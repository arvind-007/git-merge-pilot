import {
  compareSeverityDesc,
  emptyAffectedAreas,
  severityAtLeast,
  type AffectedAreas,
  type CheckStatus,
  type Finding,
  type OverlappingWork,
  type PrReport,
  type Recommendation,
  type RiskLevel,
  type RollbackDifficulty,
} from '@gmp/core';
import {
  isConfigPath,
  isDocPath,
  isInfraPath,
  isMigrationPath,
  isSourcePath,
  isTestPath,
  listPreview,
  moduleOf,
  plural,
  uniq,
} from './classify.ts';
import type { ReportCheck, ReportInput, ReportRelationship } from './report-input.ts';

export const RECOMMENDATION_LABELS: Readonly<Record<Recommendation, string>> = Object.freeze({
  ready_to_merge: 'Ready to merge',
  merge_after_checks: 'Merge after checks',
  needs_clarification: 'Needs clarification',
  changes_required: 'Changes required',
  escalate: 'Escalate',
});

export const RISK_LABELS: Readonly<Record<RiskLevel, string>> = Object.freeze({
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
});

const API_CONTRACT_KINDS = new Set(['http_route', 'graphql', 'proto']);
const INTEGRATION_CONTRACT_KINDS = new Set(['event', 'queue_topic']);

export function migrationPaths(input: Pick<ReportInput, 'facts' | 'files'>): string[] {
  const fromFacts = (input.facts.migrations ?? []).map((m) => (typeof m === 'string' ? m : m.path));
  const fromFiles = input.files
    .filter(
      (f) =>
        f.status !== 'removed' &&
        isMigrationPath(f.path) &&
        /\.(sql|ts|js|py|rb|go|java|xml|ya?ml)$/i.test(f.path),
    )
    .map((f) => f.path);
  return uniq(fromFacts.length > 0 ? fromFacts : fromFiles);
}

/** Normalizes a GitHub check (status/conclusion) to pass/fail/pending/unknown. */
export function normalizeCheckStatus(check: ReportCheck): CheckStatus {
  const conclusion = (check.conclusion ?? '').toLowerCase();
  const status = (check.status ?? '').toLowerCase();
  if (['pass', 'fail', 'pending', 'unknown'].includes(status) && !conclusion)
    return status as CheckStatus;
  if (['success', 'neutral', 'skipped'].includes(conclusion)) return 'pass';
  if (
    [
      'failure',
      'timed_out',
      'cancelled',
      'action_required',
      'startup_failure',
      'error',
      'stale',
    ].includes(conclusion)
  )
    return 'fail';
  if (['queued', 'in_progress', 'pending', 'waiting', 'requested', 'expected'].includes(status))
    return 'pending';
  if (status === 'completed' && !conclusion) return 'unknown';
  if (status === 'success') return 'pass';
  if (status === 'failure' || status === 'error') return 'fail';
  return 'unknown';
}

export function summarizeChecks(checks: readonly ReportCheck[] | undefined): string {
  if (!checks || checks.length === 0) return 'No CI checks were reported for this commit.';
  const groups: Record<CheckStatus, string[]> = { pass: [], fail: [], pending: [], unknown: [] };
  for (const c of checks) groups[normalizeCheckStatus(c)].push(c.name);
  const parts: string[] = [];
  if (groups.pass.length) parts.push(`${groups.pass.length} passed`);
  if (groups.fail.length)
    parts.push(`${groups.fail.length} failing (${listPreview(groups.fail, 3)})`);
  if (groups.pending.length)
    parts.push(`${groups.pending.length} still running (${listPreview(groups.pending, 3)})`);
  if (groups.unknown.length) parts.push(`${groups.unknown.length} with unknown status`);
  return `${plural(checks.length, 'CI check')}: ${parts.join(', ')}.`;
}

function affectedAreasFrom(input: ReportInput): AffectedAreas {
  const areas = emptyAffectedAreas();
  const paths = input.files.map((f) => f.path);
  const facts = input.facts;
  const profilePackages = input.repo.profile?.packages ?? [];

  areas.modules = uniq(paths.filter((p) => !isDocPath(p)).map(moduleOf)).slice(0, 30);

  const services = new Set<string>(facts.packagesTouched ?? []);
  for (const pkg of profilePackages) {
    const prefix = pkg.path.replace(/\/+$/, '') + '/';
    if (paths.some((p) => p.startsWith(prefix))) services.add(pkg.name);
  }
  areas.services = [...services].slice(0, 30);

  const contracts = facts.contractsChanged ?? [];
  areas.apis = uniq(
    contracts.filter((c) => API_CONTRACT_KINDS.has(c.kind)).map((c) => c.identifier),
  ).slice(0, 30);
  areas.integrations = uniq(
    contracts
      .filter((c) => INTEGRATION_CONTRACT_KINDS.has(c.kind) || c.role === 'consumer')
      .map((c) => `${c.kind}: ${c.identifier}`),
  ).slice(0, 30);
  areas.databaseTables = uniq([
    ...(facts.tablesTouched ?? []),
    ...contracts.filter((c) => c.kind === 'db_table').map((c) => c.identifier),
  ]).slice(0, 30);
  areas.sharedComponents = uniq(
    (facts.touchedSymbols ?? [])
      .filter((s) => s.exported && s.change !== 'added')
      .map((s) => `${s.name} (${s.path})`),
  ).slice(0, 30);
  areas.configuration = uniq([
    ...(facts.configChanges ?? []),
    ...(facts.envVarsAdded ?? []).map((v) => `env ${v}`),
    ...(facts.envVarsRemoved ?? []).map((v) => `env ${v}`),
    ...contracts.filter((c) => c.kind === 'env_var').map((c) => `env ${c.identifier}`),
    ...paths.filter((p) => isConfigPath(p) && !isInfraPath(p)),
  ]).slice(0, 30);
  areas.infrastructure = uniq([
    ...(facts.workflowChanges ?? []),
    ...(facts.permissionChanges ?? []),
    ...paths.filter(isInfraPath),
  ]).slice(0, 30);
  return areas;
}

function coordinationFor(rel: ReportRelationship): string {
  switch (rel.type) {
    case 'same_file':
    case 'same_symbol':
      return `Coordinate merge order with ${rel.prRef}; whichever merges second will likely need a rebase.`;
    case 'contract_change':
      return `Confirm ${rel.prRef} is compatible with the changed interface before either is deployed.`;
    case 'shared_table':
      return `Align database changes with ${rel.prRef} and agree on migration order.`;
    case 'shared_config':
      return `Check that configuration changes in ${rel.prRef} do not conflict.`;
    case 'duplicate_work':
      return `Check with the author of ${rel.prRef} whether both PRs are needed.`;
    case 'depends_on':
      return `Merge ${rel.prRef} first or confirm the dependency is already satisfied.`;
  }
}

function overlappingWorkFrom(rels: readonly ReportRelationship[]): OverlappingWork[] {
  const order = { confirmed: 0, likely: 1, possible: 2 } as const;
  return [...rels]
    .sort((a, b) => order[a.confidence] - order[b.confidence])
    .map((rel) => ({
      prRef: rel.prRef,
      ...(rel.pullRequestId ? { pullRequestId: rel.pullRequestId } : {}),
      ...(rel.repository ? { repository: rel.repository } : {}),
      type: rel.type,
      confidence: rel.confidence,
      summary: rel.summary,
      suggestedCoordination: coordinationFor(rel),
    }));
}

function rollbackFrom(
  input: ReportInput,
  migrations: string[],
): { difficulty: RollbackDifficulty; notes: string } {
  const destructiveDb = input.findings.some(
    (f) =>
      (f.category === 'database' || f.category === 'breaking_change') &&
      f.verified &&
      severityAtLeast(f.severity, 'high') &&
      f.evidence.some((e) => e.path && isMigrationPath(e.path)),
  );
  const envChanges =
    (input.facts.envVarsAdded?.length ?? 0) + (input.facts.envVarsRemoved?.length ?? 0);
  const contractChanges = input.facts.contractsChanged?.length ?? 0;
  const deps = input.facts.dependencyChanges?.length ?? 0;
  if (migrations.length > 0 && destructiveDb) {
    return {
      difficulty: 'hard',
      notes:
        'This PR includes database migrations that remove or restructure data. Reverting the code alone will not ' +
        'restore the data; a tested down-migration or backup restore would be needed.',
    };
  }
  if (migrations.length > 0) {
    return {
      difficulty: 'moderate',
      notes:
        `This PR includes ${plural(migrations.length, 'database migration')}. Rolling back requires reverting the ` +
        'code and, if the schema change is not backwards compatible, a down-migration.',
    };
  }
  if (envChanges > 0 || contractChanges > 0 || deps > 0) {
    const reasons = [
      envChanges ? 'environment variables' : '',
      contractChanges ? 'interfaces used by other code' : '',
      deps ? 'dependencies' : '',
    ].filter(Boolean);
    return {
      difficulty: 'moderate',
      notes: `Reverting the code is possible, but changes to ${reasons.join(', ')} may also need to be undone in the environments where it was deployed.`,
    };
  }
  return {
    difficulty: 'easy',
    notes:
      'No database, configuration or interface changes were detected; reverting the PR should be sufficient.',
  };
}

function confidenceFrom(
  input: ReportInput,
  limitations: string[],
): { score: number; rationale: string } {
  let score = 70;
  const reasons: string[] = [
    'based on automated analysis of the diff and GitHub data (no AI review)',
  ];
  const missingPatches = input.files.filter(
    (f) => f.patch == null && f.status !== 'removed',
  ).length;
  if (missingPatches > 0) {
    score -= Math.min(20, missingPatches * 2);
    reasons.push(`${plural(missingPatches, 'file')} had no diff available`);
  }
  if (!input.checks || input.checks.length === 0) {
    score -= 5;
    reasons.push('no CI results were available');
  }
  if (limitations.length > 0) {
    score -= Math.min(15, limitations.length * 3);
    reasons.push(`${plural(limitations.length, 'limitation')} noted`);
  }
  score = Math.max(20, Math.min(85, score));
  return { score, rationale: `Confidence is ${score}/100: ${reasons.join('; ')}.` };
}

export interface DeterministicReportOptions {
  /** Why AI was not used (added to limitations), e.g. "AI disabled for this repository". */
  reason?: string;
}

/**
 * Builds a complete plain-language PrReport from deterministic facts alone (design §9). Used when AI is off,
 * the budget is exhausted, or the AI call failed. Deterministic findings, scores and readiness are kept verbatim.
 */
export function buildDeterministicReport(
  input: ReportInput,
  opts: DeterministicReportOptions = {},
): PrReport {
  const { pr, facts, risk } = input;
  const files = input.files;
  const findings = [...input.findings];
  const breakingChanges = findings.filter((f) => f.category === 'breaking_change').sort(bySeverity);
  const security = findings.filter((f) => f.category === 'security').sort(bySeverity);
  const integrationImpact = findings
    .filter((f) => f.category !== 'breaking_change' && f.category !== 'security')
    .sort(bySeverity);
  const relationships = input.relationships ?? [];
  const migrations = migrationPaths(input);
  const affectedAreas = affectedAreasFrom(input);
  const limitations = uniq([...(input.limitations ?? []), ...(opts.reason ? [opts.reason] : [])]);

  const additions = pr.additions ?? sum(files.map((f) => f.additions ?? 0));
  const deletions = pr.deletions ?? sum(files.map((f) => f.deletions ?? 0));
  const fileCount = pr.changedFiles ?? files.length;
  const readinessLabel = RECOMMENDATION_LABELS[risk.mergeReadiness.recommendation];

  // ---- Executive summary ----
  const highlights: string[] = [];
  if (breakingChanges.length)
    highlights.push(plural(breakingChanges.length, 'verified breaking change'));
  if (security.length) highlights.push(plural(security.length, 'security finding'));
  if (migrations.length) highlights.push(plural(migrations.length, 'database migration'));
  const strongOverlaps = relationships.filter((r) => r.confidence !== 'possible');
  if (strongOverlaps.length)
    highlights.push(`overlap with ${plural(strongOverlaps.length, 'other PR')}`);
  const author = pr.authorLogin ? ` by @${pr.authorLogin}` : '';
  const draft = pr.draft ? ' (draft)' : '';
  const executiveSummary = [
    `PR #${pr.number} "${oneLine(pr.title)}"${author}${draft} changes ${plural(fileCount, 'file')} ` +
      `(+${additions}/−${deletions}) in ${input.repo.fullName}` +
      (pr.baseRef ? `, targeting ${pr.baseRef}.` : '.'),
    highlights.length
      ? `Automated analysis found ${listPreview(highlights)}.`
      : 'Automated analysis found no breaking changes, security findings or migrations.',
    `Overall risk is ${RISK_LABELS[risk.overallRisk]}. Merge readiness: ${readinessLabel}.`,
    risk.mergeReadiness.blockers.length
      ? `Before merging: ${listPreview(risk.mergeReadiness.blockers, 3)}.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');

  // ---- Business impact ----
  const impact: string[] = [];
  if (affectedAreas.apis.length)
    impact.push(
      `It changes ${plural(affectedAreas.apis.length, 'API endpoint or interface', 'API endpoints or interfaces')} (${listPreview(affectedAreas.apis, 3)}), which other systems or clients may rely on.`,
    );
  if (affectedAreas.databaseTables.length || migrations.length)
    impact.push(
      `It changes stored data${affectedAreas.databaseTables.length ? ` (${listPreview(affectedAreas.databaseTables, 3)})` : ''}; deployments need the migration to run safely.`,
    );
  if ((facts.envVarsAdded?.length ?? 0) > 0)
    impact.push(
      `New configuration is required in each environment: ${listPreview(facts.envVarsAdded ?? [], 4)}.`,
    );
  if ((facts.envVarsRemoved?.length ?? 0) > 0)
    impact.push(`Configuration is no longer read: ${listPreview(facts.envVarsRemoved ?? [], 4)}.`);
  if (affectedAreas.integrations.length)
    impact.push(
      `It affects integrations with other services (${listPreview(affectedAreas.integrations, 3)}).`,
    );
  if ((facts.dependencyChanges?.length ?? 0) > 0)
    impact.push(
      `It changes ${plural(facts.dependencyChanges?.length ?? 0, 'third-party dependency', 'third-party dependencies')}.`,
    );
  if (breakingChanges.length)
    impact.push(
      'Some existing behaviour or interfaces are removed or changed, so callers may break if they are not updated together.',
    );
  if (security.length)
    impact.push('Security-relevant code is touched; review the security section before merging.');
  if (impact.length === 0) {
    const onlyDocsOrTests =
      files.length > 0 && files.every((f) => isDocPath(f.path) || isTestPath(f.path));
    impact.push(
      onlyDocsOrTests
        ? 'The change only touches documentation and/or tests, so no user-facing behaviour change is expected.'
        : `The change is contained to ${listPreview(affectedAreas.modules, 4) || 'the repository'}; no external interfaces, data or configuration changes were detected.`,
    );
  }
  const businessImpact = impact.join(' ');

  // ---- Technical summary ----
  const symbols = facts.touchedSymbols ?? [];
  const symCount = (c: string) => symbols.filter((s) => s.change === c).length;
  const tech: string[] = [`${plural(fileCount, 'file')} changed (+${additions}/−${deletions}).`];
  if (symbols.length)
    tech.push(
      `Code symbols: ${symCount('added')} added, ${symCount('modified')} modified, ${symCount('removed')} removed${symCount('renamed') ? `, ${symCount('renamed')} renamed` : ''}.`,
    );
  if (facts.contractsChanged?.length)
    tech.push(
      `Interfaces/contracts changed: ${listPreview(
        facts.contractsChanged.map((c) => `${c.kind} ${c.identifier}`),
        5,
      )}.`,
    );
  if (migrations.length) tech.push(`Migrations: ${listPreview(migrations, 5)}.`);
  if (facts.dependencyChanges?.length)
    tech.push(
      `Dependencies: ${listPreview(
        facts.dependencyChanges.map((d) =>
          d.from && d.to
            ? `${d.name} ${d.from} → ${d.to}`
            : `${d.name} (${d.change ?? (d.to ? 'added' : 'removed')})`,
        ),
        5,
      )}.`,
    );
  if (facts.workflowChanges?.length)
    tech.push(`CI/workflow files changed: ${listPreview(facts.workflowChanges, 4)}.`);
  if (facts.permissionChanges?.length)
    tech.push(`Permission changes: ${listPreview(facts.permissionChanges, 4)}.`);
  if (affectedAreas.modules.length)
    tech.push(`Areas touched: ${listPreview(affectedAreas.modules, 6)}.`);
  const technicalSummary = tech.join(' ');

  // ---- Testing ----
  const testsAdded = uniq(
    facts.testsAdded ??
      files.filter((f) => f.status === 'added' && isTestPath(f.path)).map((f) => f.path),
  );
  const testsModified = uniq(
    facts.testsModified ??
      files
        .filter((f) => f.status !== 'added' && f.status !== 'removed' && isTestPath(f.path))
        .map((f) => f.path),
  );
  const missingTests: string[] = [];
  const sourceChanged = files.filter((f) => isSourcePath(f.path) && f.status !== 'removed');
  if (sourceChanged.length > 0 && testsAdded.length === 0 && testsModified.length === 0) {
    missingTests.push(
      `No test changes accompany changes to ${plural(sourceChanged.length, 'source file')} (${listPreview(
        sourceChanged.map((f) => f.path),
        3,
      )}).`,
    );
  }
  const changedExported = symbols.filter(
    (s) => s.exported && (s.change === 'modified' || s.change === 'added'),
  );
  if (changedExported.length > 0 && testsAdded.length === 0 && testsModified.length === 0) {
    missingTests.push(
      `Public code changed without test updates: ${listPreview(
        changedExported.map((s) => s.name),
        5,
      )}.`,
    );
  }
  for (const f of findings) if (f.category === 'testing') missingTests.push(f.title);
  const testing = {
    testsAdded,
    testsModified,
    missingTests: uniq(missingTests),
    ciSummary: summarizeChecks(input.checks),
  };

  // ---- Deployment ----
  const envChanges = [
    ...(facts.envVarsAdded ?? []).map((v) => `Add environment variable ${v}`),
    ...(facts.envVarsRemoved ?? []).map((v) => `Environment variable ${v} is no longer used`),
  ];
  const configChanges = uniq([...(facts.configChanges ?? []), ...affectedAreas.infrastructure]);
  const ordering: string[] = [];
  if ((facts.envVarsAdded?.length ?? 0) > 0)
    ordering.push('Set the new environment variables in every environment before deploying.');
  if (migrations.length)
    ordering.push(
      'Run the database migrations as part of (or before) the deployment, after taking a backup.',
    );
  const providerChanges = (facts.contractsChanged ?? []).filter(
    (c) => c.role !== 'consumer' && API_CONTRACT_KINDS.has(c.kind),
  );
  if (providerChanges.length && relationships.some((r) => r.type === 'contract_change'))
    ordering.push(
      'Deploy the service that provides the changed interface before the services that consume it.',
    );
  for (const r of relationships.filter((x) => x.type === 'depends_on'))
    ordering.push(`Merge and deploy ${r.prRef} first.`);
  const deploymentNotes: string[] = [];
  if (!envChanges.length && !migrations.length && !configChanges.length)
    deploymentNotes.push('No special deployment steps were detected.');
  if (facts.workflowChanges?.length)
    deploymentNotes.push('CI/CD workflow files changed; watch the first pipeline run after merge.');
  for (const f of findings.filter((x) => x.category === 'deployment'))
    deploymentNotes.push(f.title);
  const deployment = {
    migrations,
    envChanges,
    configChanges,
    ordering: uniq(ordering),
    notes: deploymentNotes.join(' '),
  };

  // ---- Recommended actions ----
  const actions: string[] = [...risk.mergeReadiness.blockers];
  for (const f of [...breakingChanges, ...security, ...integrationImpact]) {
    if (severityAtLeast(f.severity, 'high')) actions.push(f.recommendation ?? `Review: ${f.title}`);
  }
  for (const o of overlappingWorkFrom(strongOverlaps))
    if (o.suggestedCoordination) actions.push(o.suggestedCoordination);
  if (testing.missingTests.length)
    actions.push('Ask the author to add or update tests for the changed behaviour.');
  if (envChanges.length)
    actions.push('Make sure operations has the new configuration values ready before deployment.');
  if (actions.length === 0) actions.push('No additional actions identified beyond normal review.');

  return {
    executiveSummary,
    businessImpact,
    technicalSummary,
    affectedAreas,
    breakingChanges,
    security,
    integrationImpact,
    overlappingWork: overlappingWorkFrom(relationships),
    testing,
    deployment,
    rollback: rollbackFrom(input, migrations),
    recommendedActions: uniq(actions).slice(0, 15),
    riskScores: risk.riskScores,
    overallRisk: risk.overallRisk,
    mergeReadiness: risk.mergeReadiness,
    confidence: confidenceFrom(input, limitations),
    generatedBy: 'deterministic',
    limitations,
  };
}

function bySeverity(a: Finding, b: Finding): number {
  return compareSeverityDesc(a.severity, b.severity);
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 200);
}
