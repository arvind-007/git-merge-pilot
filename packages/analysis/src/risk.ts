/**
 * Risk scoring and merge readiness (design §8).
 *
 * Each dimension is scored 0–100 from weighted signals and mapped to a level
 * (critical ≥80, high ≥60, medium ≥30, else low; project thresholds may override).
 * Overall = highest dimension level, bumped to at least `high` when a verified
 * critical/high security finding exists. Merge readiness uses first-match rules:
 * escalate → changes_required → needs_clarification → merge_after_checks → ready_to_merge.
 */
import {
  RISK_DIMENSIONS,
  maxRiskLevel,
  riskLevelRank,
  severityRank,
  type CheckStatus,
  type Evidence,
  type Finding,
  type MergeReadiness,
  type ReadinessCheck,
  type Recommendation,
  type RiskDimension,
  type RiskLevel,
  type RiskScore,
  type Severity,
} from '@gmp/core';
import type {
  CheckInput,
  Relationship,
  RiskThresholds,
  ScoreRiskInput,
  ScoreRiskResult,
} from './types.ts';

const SEVERITY_SCORE: Record<Severity, number> = {
  critical: 85,
  high: 65,
  medium: 35,
  low: 12,
  info: 3,
};
const MAX_EVIDENCE = 8;

function levelFor(score: number, t: Required<RiskThresholds>): RiskLevel {
  if (score >= t.critical) return 'critical';
  if (score >= t.high) return 'high';
  if (score >= t.medium) return 'medium';
  return 'low';
}

function thresholds(input: ScoreRiskInput): Required<RiskThresholds> {
  const t = input.projectSettings?.riskThresholds ?? {};
  const valid = (n: unknown, d: number) =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100 ? n : d;
  const out = {
    critical: valid(t.critical, 80),
    high: valid(t.high, 60),
    medium: valid(t.medium, 30),
  };
  // keep ordering sane
  if (!(out.critical >= out.high && out.high >= out.medium))
    return { critical: 80, high: 60, medium: 30 };
  return out;
}

interface Acc {
  score: number;
  reasons: string[];
  evidence: Evidence[];
}

function acc(): Acc {
  return { score: 0, reasons: [], evidence: [] };
}

function addEvidence(a: Acc, ev: Evidence[]): void {
  for (const e of ev) if (a.evidence.length < MAX_EVIDENCE) a.evidence.push(e);
}

/** Score contribution of a set of findings: highest severity plus a small bump per extra finding. */
function findingsScore(findings: Finding[]): number {
  if (findings.length === 0) return 0;
  let best = 0;
  for (const f of findings) {
    const base = SEVERITY_SCORE[f.severity];
    best = Math.max(best, f.verified ? base : Math.round(base * 0.7));
  }
  return Math.min(100, best + Math.min(15, (findings.length - 1) * 5));
}

function describeFindings(findings: Finding[], noun: string): string {
  const verified = findings.filter((f) => f.verified).length;
  const top = [...findings].sort((a, b) => severityRank(b.severity) - severityRank(a.severity))[0];
  const parts = [`${findings.length} ${noun}${findings.length === 1 ? '' : 's'}`];
  if (verified !== findings.length)
    parts.push(`${verified} verified, ${findings.length - verified} potential`);
  return `${parts.join(' (')}${parts.length > 1 ? ')' : ''}; most severe: ${top?.severity} — ${top?.title}.`;
}

function findingEvidence(findings: Finding[]): Evidence[] {
  return [...findings]
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .flatMap((f) => f.evidence.slice(0, 2));
}

const relWeight = (r: Relationship, confirmed: number, likely: number, possible: number) =>
  r.confidence === 'confirmed' ? confirmed : r.confidence === 'likely' ? likely : possible;

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** Normalizes a GitHub check-run / status into pass | fail | pending | unknown. */
export function normalizeCheckStatus(c: CheckInput): CheckStatus {
  const status = (c.status ?? '').toLowerCase();
  const conclusion = (c.conclusion ?? '').toLowerCase();
  if (['pass', 'fail', 'pending', 'unknown'].includes(status) && !conclusion)
    return status as CheckStatus;
  if (conclusion) {
    if (['success', 'neutral', 'skipped'].includes(conclusion)) return 'pass';
    if (
      [
        'failure',
        'timed_out',
        'cancelled',
        'action_required',
        'startup_failure',
        'stale',
        'error',
      ].includes(conclusion)
    )
      return 'fail';
  }
  if (['success', 'passed', 'completed'].includes(status)) return conclusion ? 'unknown' : 'pass';
  if (['failure', 'error', 'failed'].includes(status)) return 'fail';
  if (['queued', 'in_progress', 'pending', 'waiting', 'requested', 'expected'].includes(status))
    return 'pending';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export function scoreRisk(input: ScoreRiskInput): ScoreRiskResult {
  const { facts } = input;
  const findings = input.findings ?? [];
  const relationships = input.relationships ?? [];
  const checks = (input.checks ?? []).map((c) => ({
    ...c,
    normalized: normalizeCheckStatus(c),
    required: c.required !== false,
  }));
  const t = thresholds(input);
  const dims: Record<RiskDimension, Acc> = {
    security: acc(),
    breaking_change: acc(),
    integration: acc(),
    regression: acc(),
    database: acc(),
    deployment: acc(),
  };

  // ---- security ----
  {
    const a = dims.security;
    const sec = findings.filter((f) => f.category === 'security');
    if (sec.length > 0) {
      a.score = findingsScore(sec);
      a.reasons.push(describeFindings(sec, 'security finding'));
      addEvidence(a, findingEvidence(sec));
    }
    const auth = facts.permissionChanges.filter(
      (p) => p.kind === 'auth_middleware' || p.kind === 'access_control',
    );
    if (auth.length > 0) {
      a.score += sec.length > 0 ? 5 : 20;
      a.reasons.push(`Login/permission-related code changed in ${auth.length} place(s).`);
      addEvidence(
        a,
        auth.slice(0, 3).map((p) => ({
          repo: facts.repo,
          path: p.path,
          line: p.line,
          snippet: p.detail,
          source: 'diff' as const,
        })),
      );
    }
    const wf = facts.permissionChanges.filter(
      (p) => p.kind === 'workflow_permissions' || p.kind === 'iam',
    );
    if (wf.length > 0) {
      a.score += 10;
      a.reasons.push(`CI or cloud permissions changed in ${wf.length} place(s).`);
      addEvidence(
        a,
        wf.slice(0, 2).map((p) => ({
          repo: facts.repo,
          path: p.path,
          line: p.line,
          snippet: p.detail,
          source: 'diff' as const,
        })),
      );
    }
    if (a.reasons.length === 0)
      a.reasons.push(
        'No security issues were found by the automated checks (this is not a guarantee that the change is secure).',
      );
  }

  // ---- breaking_change ----
  {
    const a = dims.breaking_change;
    const br = findings.filter((f) => f.category === 'breaking_change');
    if (br.length > 0) {
      a.score = findingsScore(br);
      a.reasons.push(describeFindings(br, 'breaking change'));
      addEvidence(a, findingEvidence(br));
    } else {
      const exportedChanges = facts.touchedSymbols.filter(
        (s) => s.exported && s.change !== 'added',
      ).length;
      if (exportedChanges > 0) {
        a.score = Math.min(25, exportedChanges * 4);
        a.reasons.push(
          `${exportedChanges} public code element(s) modified without a detected breaking change.`,
        );
      } else a.reasons.push('No breaking changes detected in public code, APIs or schemas.');
    }
  }

  // ---- integration ----
  {
    const a = dims.integration;
    const providers = facts.contractsChanged.filter(
      (c) => c.role === 'provider' && c.kind !== 'env_var' && c.kind !== 'db_table',
    );
    const changed = providers.filter((c) => c.change !== 'added');
    const added = providers.filter((c) => c.change === 'added');
    if (changed.length + added.length > 0) {
      a.score += Math.min(45, changed.length * 15 + added.length * 5);
      a.reasons.push(
        `${changed.length} existing and ${added.length} new API/message contract(s) changed.`,
      );
      addEvidence(
        a,
        providers.slice(0, 4).map((c) => ({
          repo: facts.repo,
          path: c.path,
          ...((c.line ?? c.oldLine) ? { line: c.line ?? c.oldLine } : {}),
          ...(!c.line && c.oldLine ? { side: 'base' as const } : {}),
          snippet: `${c.kind} ${c.change}: ${c.identifier}`,
          source: 'diff' as const,
        })),
      );
    }
    const contractRels = relationships.filter((r) => r.type === 'contract_change');
    if (contractRels.length > 0) {
      a.score += Math.min(
        40,
        contractRels.reduce((n, r) => n + relWeight(r, 30, 20, 5), 0),
      );
      a.reasons.push(
        `${contractRels.length} other PR(s) touch the same API contracts (${contractRels.map((r) => r.confidence).join(', ')}).`,
      );
      addEvidence(
        a,
        contractRels.flatMap((r) => r.evidence.slice(0, 1)),
      );
    }
    const deps = relationships.filter(
      (r) => r.type === 'depends_on' && r.confidence !== 'possible',
    );
    if (deps.length > 0) {
      a.score += 10;
      a.reasons.push(`Depends on or is linked with ${deps.length} other PR(s).`);
    }
    const integ = findings.filter((f) => f.category === 'integration');
    if (integ.length > 0) {
      a.score = Math.max(a.score, findingsScore(integ));
      a.reasons.push(describeFindings(integ, 'integration concern'));
      addEvidence(a, findingEvidence(integ));
    }
    if (facts.packagesTouched.length >= 3) {
      a.score += 10;
      a.reasons.push(
        `Touches ${facts.packagesTouched.length} packages/areas: ${facts.packagesTouched.slice(0, 5).join(', ')}.`,
      );
    }
    const runtimeDeps = facts.dependencyChanges.filter((d) => !d.dev);
    if (runtimeDeps.length > 0) {
      a.score += Math.min(15, runtimeDeps.length * 5);
      a.reasons.push(`${runtimeDeps.length} runtime dependency change(s).`);
    }
    if (a.reasons.length === 0)
      a.reasons.push('No API, message or cross-PR integration changes detected.');
  }

  // ---- regression ----
  {
    const a = dims.regression;
    const lines = facts.stats.additions + facts.stats.deletions;
    const sizeScore =
      lines >= 1000 ? 35 : lines >= 500 ? 25 : lines >= 200 ? 15 : lines >= 50 ? 8 : 3;
    a.score += sizeScore;
    a.reasons.push(
      `${facts.stats.files} file(s), +${facts.stats.additions}/-${facts.stats.deletions} lines.`,
    );
    if (facts.stats.files >= 30) {
      a.score += 10;
      a.reasons.push('Large number of files changed.');
    }
    const testsTouched = facts.testsAdded.length + facts.testsModified.length;
    if (facts.sourceFilesChanged.length > 0 && testsTouched === 0) {
      a.score += 20;
      a.reasons.push(
        `${facts.sourceFilesChanged.length} source file(s) changed with no test changes.`,
      );
      addEvidence(
        a,
        facts.sourceFilesChanged
          .slice(0, 3)
          .map((p) => ({ repo: facts.repo, path: p, source: 'diff' as const })),
      );
    } else if (testsTouched > 0) {
      a.reasons.push(
        `${facts.testsAdded.length} test file(s) added, ${facts.testsModified.length} modified.`,
      );
    }
    if (facts.testsRemoved.length > 0) {
      a.score += 15;
      a.reasons.push(`${facts.testsRemoved.length} test file(s) deleted.`);
      addEvidence(
        a,
        facts.testsRemoved
          .slice(0, 2)
          .map((p) => ({ repo: facts.repo, path: p, source: 'diff' as const })),
      );
    }
    const failing = checks.filter((c) => c.normalized === 'fail' && c.required);
    if (failing.length > 0) {
      a.score += 25;
      a.reasons.push(
        `${failing.length} failing check(s): ${failing
          .map((c) => c.name)
          .slice(0, 5)
          .join(', ')}.`,
      );
      addEvidence(
        a,
        failing.slice(0, 3).map((c) => ({
          repo: facts.repo,
          ...(c.url ? { url: c.url } : {}),
          snippet: `${c.name}: failing`,
          source: 'github' as const,
        })),
      );
    }
    const overlap = relationships.filter((r) => r.type === 'same_file' || r.type === 'same_symbol');
    if (overlap.length > 0) {
      a.score += Math.min(
        20,
        overlap.reduce((n, r) => n + relWeight(r, 15, 5, 0), 0),
      );
      a.reasons.push(
        `Overlaps with ${overlap.length} other open PR change(s) to the same files/code.`,
      );
      addEvidence(
        a,
        overlap.flatMap((r) => r.evidence.slice(0, 1)),
      );
    }
    const reg = findings.filter((f) => f.category === 'regression' || f.category === 'testing');
    if (reg.length > 0) {
      a.score = Math.max(a.score, findingsScore(reg));
      a.reasons.push(describeFindings(reg, 'regression/testing concern'));
      addEvidence(a, findingEvidence(reg));
    }
    const modifiedPublic = facts.touchedSymbols.filter(
      (s) => s.exported && s.change === 'modified',
    ).length;
    if (modifiedPublic >= 5) {
      a.score += 10;
      a.reasons.push(`${modifiedPublic} public functions/classes modified.`);
    }
  }

  // ---- database ----
  {
    const a = dims.database;
    const ops = facts.schemaOperations;
    if (facts.migrations.length > 0) {
      a.score += 25;
      a.reasons.push(`${facts.migrations.length} database migration file(s) included.`);
      addEvidence(
        a,
        facts.migrations
          .slice(0, 3)
          .map((m) => ({ repo: facts.repo, path: m.path, source: 'diff' as const })),
      );
    }
    const floor = (n: number) => (a.score = Math.max(a.score, n));
    const destructive = ops.filter((o) => o.op === 'drop_table' || o.op === 'truncate_table');
    if (destructive.length > 0) floor(85);
    const risky = ops.filter((o) =>
      ['drop_column', 'rename_column', 'rename_table'].includes(o.op),
    );
    if (risky.length > 0) floor(65);
    const constraint = ops.filter(
      (o) => o.op === 'set_not_null' || (o.op === 'add_column' && o.notNull && !o.hasDefault),
    );
    if (constraint.length > 0) floor(60);
    const typeChanges = ops.filter((o) => o.op === 'alter_column_type');
    if (typeChanges.length > 0) floor(40);
    const blockingIndexes = ops.filter(
      (o) =>
        o.op === 'create_index' &&
        !/CONCURRENTLY|algorithm:\s*:concurrently|postgresql_concurrently\s*=\s*True/i.test(
          o.statement,
        ),
    );
    if (blockingIndexes.length > 0) {
      a.score += 10;
      a.reasons.push(
        `${blockingIndexes.length} index(es) created without CONCURRENTLY (may lock writes on large tables).`,
      );
    }
    const notable = [...destructive, ...risky, ...constraint, ...typeChanges];
    if (notable.length > 0) {
      a.reasons.push(
        `Schema operations: ${notable
          .slice(0, 5)
          .map((o) => `${o.op} ${o.table}${o.column ? `.${o.column}` : ''}`)
          .join(', ')}${notable.length > 5 ? ', …' : ''}.`,
      );
      addEvidence(
        a,
        notable.slice(0, 5).map((o) => ({
          repo: facts.repo,
          path: o.path,
          line: o.line,
          snippet: o.statement,
          source: 'diff' as const,
        })),
      );
    } else if (ops.length > 0) {
      a.reasons.push(
        `${ops.length} additive schema operation(s) (e.g. ${ops[0]?.op} ${ops[0]?.table}).`,
      );
    }
    const shared = relationships.filter((r) => r.type === 'shared_table');
    if (shared.length > 0) {
      a.score += Math.min(
        20,
        shared.reduce((n, r) => n + relWeight(r, 15, 8, 3), 0),
      );
      a.reasons.push(`${shared.length} other PR(s) change the same database table(s).`);
      addEvidence(
        a,
        shared.flatMap((r) => r.evidence.slice(0, 1)),
      );
    }
    const dbFindings = findings.filter((f) => f.category === 'database');
    if (dbFindings.length > 0) {
      a.score = Math.max(a.score, findingsScore(dbFindings));
      a.reasons.push(describeFindings(dbFindings, 'database concern'));
      addEvidence(a, findingEvidence(dbFindings));
    }
    if (a.reasons.length === 0) a.reasons.push('No database schema changes detected.');
  }

  // ---- deployment ----
  {
    const a = dims.deployment;
    const newEnv = facts.envVarsAdded.filter((e) => e.role === 'consumer');
    if (newEnv.length > 0) {
      a.score += Math.min(25, newEnv.length * 10);
      a.reasons.push(
        `New configuration setting(s) must be provided: ${[...new Set(newEnv.map((e) => e.name))].slice(0, 6).join(', ')}.`,
      );
      addEvidence(
        a,
        newEnv.slice(0, 3).map((e) => ({
          repo: facts.repo,
          path: e.path,
          line: e.line,
          snippet: e.name,
          source: 'diff' as const,
        })),
      );
    }
    if (facts.envVarsRemoved.length > 0) {
      a.score += 10;
      a.reasons.push(`${facts.envVarsRemoved.length} configuration setting(s) removed.`);
    }
    if (facts.migrations.length > 0) {
      a.score += 15;
      a.reasons.push('Deployment must run database migrations (ordering matters).');
    }
    const infra = facts.configChanges.filter((c) => c.infrastructure);
    if (infra.length > 0) {
      a.score += 20;
      a.reasons.push(
        `Infrastructure/deployment configuration changed: ${infra
          .slice(0, 4)
          .map((c) => c.path)
          .join(', ')}.`,
      );
      addEvidence(
        a,
        infra.slice(0, 3).map((c) => ({ repo: facts.repo, path: c.path, source: 'diff' as const })),
      );
    }
    if (facts.workflowChanges.length > 0) {
      a.score += 10;
      a.reasons.push(`${facts.workflowChanges.length} CI/CD workflow file(s) changed.`);
    }
    const runtimeDeps = facts.dependencyChanges.filter((d) => !d.dev);
    if (runtimeDeps.length > 0) {
      a.score += Math.min(15, runtimeDeps.length * 5);
      a.reasons.push(`${runtimeDeps.length} runtime dependency change(s) to install.`);
    }
    if (facts.permissionChanges.some((p) => p.kind === 'iam')) {
      a.score += 15;
      a.reasons.push('Cloud/cluster access permissions changed.');
    }
    const dep = findings.filter((f) => f.category === 'deployment');
    if (dep.length > 0) {
      a.score = Math.max(a.score, findingsScore(dep));
      a.reasons.push(describeFindings(dep, 'deployment concern'));
      addEvidence(a, findingEvidence(dep));
    }
    if (a.reasons.length === 0)
      a.reasons.push(
        'No deployment configuration, migration or new-setting requirements detected.',
      );
  }

  const riskScores: RiskScore[] = RISK_DIMENSIONS.map((dimension) => {
    const a = dims[dimension];
    const score = Math.max(0, Math.min(100, Math.round(a.score)));
    return {
      dimension,
      score,
      level: levelFor(score, t),
      rationale: a.reasons.join(' '),
      evidence: a.evidence,
    };
  });

  let overallRisk = maxRiskLevel(riskScores.map((r) => r.level));
  const severeSecurity = findings.some(
    (f) =>
      f.category === 'security' &&
      f.verified &&
      (f.severity === 'critical' || f.severity === 'high'),
  );
  if (severeSecurity && riskLevelRank(overallRisk) < riskLevelRank('high')) overallRisk = 'high';

  return { riskScores, overallRisk, mergeReadiness: mergeReadiness(input, checks, overallRisk) };
}

// ---------------------------------------------------------------------------
// Merge readiness
// ---------------------------------------------------------------------------

function mergeReadiness(
  input: ScoreRiskInput,
  checks: Array<CheckInput & { normalized: CheckStatus; required: boolean }>,
  overallRisk: RiskLevel,
): MergeReadiness {
  const findings = input.findings ?? [];
  const relationships = input.relationships ?? [];
  const mitigated = new Set(input.mitigatedFingerprints ?? []);
  const review = (input.reviewDecision ?? '').toUpperCase();
  const mergeable = (input.mergeableState ?? '').toLowerCase();
  const facts = input.facts;

  const tiers: Record<Recommendation, string[]> = {
    escalate: [],
    changes_required: [],
    needs_clarification: [],
    merge_after_checks: [],
    ready_to_merge: [],
  };

  // 1. escalate
  for (const f of findings) {
    if (!f.verified || f.severity !== 'critical' || mitigated.has(f.fingerprint)) continue;
    if (f.category === 'security') tiers.escalate.push(`Critical security finding: ${f.title}`);
    else if (f.category === 'breaking_change')
      tiers.escalate.push(`Critical breaking change without mitigation: ${f.title}`);
  }
  // 2. changes_required
  const failing = checks.filter((c) => c.normalized === 'fail' && c.required);
  for (const c of failing) tiers.changes_required.push(`Check failing: ${c.name}`);
  if (review === 'CHANGES_REQUESTED') tiers.changes_required.push('A reviewer requested changes.');
  if (mergeable === 'dirty')
    tiers.changes_required.push('Merge conflicts with the target branch must be resolved.');
  // 3. needs_clarification
  for (const q of input.openQuestions ?? [])
    if (q.trim()) tiers.needs_clarification.push(`Open question: ${q.trim()}`);
  for (const f of findings) {
    if (f.verified || mitigated.has(f.fingerprint)) continue;
    if (f.severity === 'critical' || f.severity === 'high')
      tiers.needs_clarification.push(`Potential concern to clarify: ${f.title}`);
  }
  // 4. merge_after_checks
  const pending = checks.filter((c) => c.normalized === 'pending' && c.required);
  if (pending.length > 0)
    tiers.merge_after_checks.push(
      `Waiting for ${pending.length} check(s): ${pending
        .map((c) => c.name)
        .slice(0, 5)
        .join(', ')}`,
    );
  if (review === 'REVIEW_REQUIRED')
    tiers.merge_after_checks.push('Required approval has not been given yet.');
  const approved = review === 'APPROVED' || (input.approvedReviews ?? 0) > 0;
  if (!approved && review !== 'REVIEW_REQUIRED' && review !== 'CHANGES_REQUESTED')
    tiers.merge_after_checks.push('No approving review yet.');
  if (checks.length === 0)
    tiers.merge_after_checks.push(
      'No CI checks reported for this commit: confirm the change was built and tested.',
    );
  if (mergeable === 'blocked' && review !== 'REVIEW_REQUIRED' && pending.length === 0)
    tiers.merge_after_checks.push('GitHub reports the PR is blocked by branch protection rules.');
  if (mergeable === 'behind')
    tiers.merge_after_checks.push('Branch is behind the target branch and must be updated.');
  if (input.draft || mergeable === 'draft')
    tiers.merge_after_checks.push('PR is still marked as a draft.');
  if (facts.migrations.length > 0)
    tiers.merge_after_checks.push(
      'Includes database migration(s): plan the deployment order and a rollback.',
    );
  const newEnv = [
    ...new Set(facts.envVarsAdded.filter((e) => e.role === 'consumer').map((e) => e.name)),
  ];
  if (newEnv.length > 0)
    tiers.merge_after_checks.push(
      `New configuration setting(s) must be set in every environment: ${newEnv.slice(0, 5).join(', ')}`,
    );
  const crossDeps = relationships.filter(
    (r) => (r.type === 'contract_change' || r.type === 'depends_on') && r.confidence !== 'possible',
  );
  if (crossDeps.length > 0)
    tiers.merge_after_checks.push(
      `Coordinate with ${crossDeps.length} related PR(s) (API contract / dependency).`,
    );
  const conflicts = relationships.filter(
    (r) => r.type === 'same_file' && r.confidence === 'confirmed',
  );
  if (conflicts.length > 0)
    tiers.merge_after_checks.push(
      `Edits the same lines as ${conflicts.length} other open PR(s); expect merge conflicts.`,
    );
  const highBreaking = findings.filter(
    (f) =>
      f.category === 'breaking_change' && f.severity === 'high' && !mitigated.has(f.fingerprint),
  );
  if (highBreaking.length > 0)
    tiers.merge_after_checks.push(
      `${highBreaking.length} high-severity breaking change(s) need coordinated release.`,
    );
  if (riskLevelRank(overallRisk) >= riskLevelRank('high'))
    tiers.merge_after_checks.push(
      `Overall risk is ${overallRisk}: needs careful review before merging.`,
    );

  const order: Recommendation[] = [
    'escalate',
    'changes_required',
    'needs_clarification',
    'merge_after_checks',
  ];
  const recommendation: Recommendation = order.find((r) => tiers[r].length > 0) ?? 'ready_to_merge';
  const blockers = order.flatMap((r) => tiers[r]);

  // Readiness checks
  const rc: ReadinessCheck[] = [];
  for (const c of checks) {
    const detail = [
      c.conclusion ? `conclusion: ${c.conclusion}` : `status: ${c.status}`,
      c.required ? null : 'optional',
    ]
      .filter(Boolean)
      .join(', ');
    rc.push({ name: c.name, status: c.normalized, detail });
  }
  if (checks.length === 0)
    rc.push({
      name: 'CI checks',
      status: 'unknown',
      detail: 'No CI checks reported for this commit.',
    });
  rc.push(
    review === 'APPROVED'
      ? { name: 'Code review', status: 'pass', detail: 'Approved.' }
      : review === 'CHANGES_REQUESTED'
        ? { name: 'Code review', status: 'fail', detail: 'Changes requested by a reviewer.' }
        : review === 'REVIEW_REQUIRED'
          ? { name: 'Code review', status: 'pending', detail: 'Approval required.' }
          : {
              name: 'Code review',
              status: 'unknown',
              detail: 'GitHub reported no review decision (reviews may not be required).',
            },
  );
  rc.push(
    mergeable === 'dirty'
      ? { name: 'Merge conflicts', status: 'fail', detail: 'Conflicts with the target branch.' }
      : ['clean', 'unstable', 'has_hooks', 'blocked'].includes(mergeable)
        ? { name: 'Merge conflicts', status: 'pass', detail: 'No conflicts reported.' }
        : mergeable === 'behind'
          ? {
              name: 'Merge conflicts',
              status: 'pending',
              detail: 'Branch is behind the target branch.',
            }
          : {
              name: 'Merge conflicts',
              status: 'unknown',
              detail: 'Mergeability not yet computed by GitHub.',
            },
  );
  const sec = findings.filter((f) => f.category === 'security' && !mitigated.has(f.fingerprint));
  const secSevere = sec.filter((f) => f.severity === 'critical' || f.severity === 'high');
  rc.push(
    secSevere.length > 0
      ? {
          name: 'Security findings',
          status: 'fail',
          detail: `${secSevere.length} high/critical security finding(s).`,
        }
      : {
          name: 'Security findings',
          status: 'pass',
          detail:
            sec.length > 0
              ? `${sec.length} lower-severity finding(s) to review.`
              : 'No issues found by automated checks (not a guarantee of security).',
        },
  );
  const br = findings.filter(
    (f) => f.category === 'breaking_change' && !mitigated.has(f.fingerprint),
  );
  rc.push(
    br.some((f) => f.severity === 'critical')
      ? {
          name: 'Breaking changes',
          status: 'fail',
          detail: `${br.length} breaking change(s), including critical.`,
        }
      : br.length > 0
        ? {
            name: 'Breaking changes',
            status: 'pending',
            detail: `${br.length} breaking change(s) need coordination.`,
          }
        : { name: 'Breaking changes', status: 'pass', detail: 'None detected.' },
  );
  if (facts.migrations.length > 0)
    rc.push({
      name: 'Database migrations',
      status: 'pending',
      detail: `${facts.migrations.length} migration file(s) to run during deployment.`,
    });

  const rationale = (() => {
    switch (recommendation) {
      case 'escalate':
        return `Escalate: ${tiers.escalate.length} critical issue(s) need a senior decision before this can merge.`;
      case 'changes_required':
        return `Changes required: ${tiers.changes_required.join(' ')}`;
      case 'needs_clarification':
        return `Needs clarification: ${tiers.needs_clarification.length} open question(s) or potential concern(s) should be answered by the author.`;
      case 'merge_after_checks':
        return `Can merge once these are handled: ${tiers.merge_after_checks.join(' ')}`;
      default: {
        const passing = checks.filter((c) => c.normalized === 'pass').length;
        const parts = [
          `${passing} of ${checks.length} reported check(s) passing`,
          approved ? 'the PR is approved' : '',
          `overall risk is ${overallRisk}`,
        ].filter(Boolean);
        return `No blocking issues detected: ${parts.join(', ')}.`;
      }
    }
  })();

  return { recommendation, blockers, checks: rc, rationale };
}
