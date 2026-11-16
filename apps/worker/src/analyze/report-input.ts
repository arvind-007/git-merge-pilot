/** Maps @gmp/analysis output and DB rows onto the structural @gmp/ai ReportInput. */
import type { ReportCheck, ReportFacts, ReportFile, ReportInput, ReportPr } from '@gmp/ai';
import type { ChangeFacts, Footprint } from '@gmp/analysis';
import type { PullRequest } from '@gmp/db';

export function toReportFacts(facts: ChangeFacts, footprint: Footprint): ReportFacts {
  return {
    touchedSymbols: facts.touchedSymbols.map((s) => ({
      name: s.qualifiedName || s.name,
      path: s.path,
      kind: s.kind,
      change: s.change,
      exported: s.exported,
      oldSignature: s.oldSignature ?? null,
      newSignature: s.newSignature ?? null,
    })),
    contractsChanged: facts.contractsChanged.map((c) => ({
      kind: c.kind,
      identifier: c.identifier,
      role: c.role,
      change: c.change,
      path: c.path,
      ...(c.line !== undefined ? { line: c.line } : {}),
    })),
    migrations: facts.migrations.map((m) => {
      const ops = m.operations
        .slice(0, 8)
        .map((o) => `${o.op.replace(/_/g, ' ')} ${o.table}${o.column ? `.${o.column}` : ''}`);
      return ops.length > 0 ? { path: m.path, summary: ops.join('; ') } : m.path;
    }),
    envVarsAdded: [...new Set(facts.envVarsAdded.map((e) => e.name))],
    envVarsRemoved: [...new Set(facts.envVarsRemoved.map((e) => e.name))],
    dependencyChanges: facts.dependencyChanges.map((d) => ({
      name: d.name,
      from: d.from ?? null,
      to: d.to ?? null,
      manifest: d.manifest,
      change: d.change,
    })),
    testsAdded: facts.testsAdded,
    testsModified: facts.testsModified,
    workflowChanges: facts.workflowChanges.map((w) => w.path),
    configChanges: facts.configChanges.map((c) => c.path),
    permissionChanges: facts.permissionChanges.map(
      (p) => `${p.change} ${p.kind.replace(/_/g, ' ')} in ${p.path}:${p.line} — ${p.detail}`,
    ),
    packagesTouched: facts.packagesTouched,
    tablesTouched: footprint.tables,
  };
}

export function toReportPr(pr: PullRequest): ReportPr {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    authorLogin: pr.authorLogin,
    baseRef: pr.baseRef,
    headRef: pr.headRef,
    headSha: pr.headSha,
    htmlUrl: pr.htmlUrl,
    draft: pr.draft,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    labels: pr.labels,
    linkedIssues: pr.linkedIssues,
    reviewDecision: pr.reviewDecision,
    mergeableState: pr.mergeableState,
  };
}

export function toReportFiles(
  files: ReadonlyArray<{
    path: string;
    status: string;
    previousPath?: string | null;
    additions?: number;
    deletions?: number;
    patch?: string | null;
  }>,
): ReportFile[] {
  return files.map((f) => ({
    path: f.path,
    status: f.status,
    previousPath: f.previousPath ?? null,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    patch: f.patch ?? null,
  }));
}

export function toReportChecks(
  checks: ReadonlyArray<{
    name: string;
    status: string;
    conclusion: string | null;
    url: string | null;
  }>,
): ReportCheck[] {
  return checks.map((c) => ({
    name: c.name,
    status: c.status,
    conclusion: c.conclusion,
    url: c.url,
  }));
}

export type { ReportInput };
