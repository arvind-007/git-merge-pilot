/** Builds @gmp/analysis inputs from a PR snapshot (diffs + selectively fetched file contents). */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import {
  addedLines,
  detectLanguage,
  isDependencyManifest,
  isGeneratedPath,
  isLockFile,
  isMigrationPath,
  isSchemaDefinitionPath,
  isScannerControlFile,
  isSourceLanguage,
  isTestPath,
  makeFinding,
  parseUnifiedDiff,
  type ChangedFileInput,
} from '@gmp/analysis';
import { severityAtLeast, type Evidence, type Finding, type Severity } from '@gmp/core';
import type { PrFileSnapshot, PrSnapshot, SecurityAlertSummary } from '@gmp/github';
import type { WorkerContext } from '../deps.ts';
import type { RepoTarget } from '../github.ts';
import { mapLimit } from '../util.ts';

/** Priority of fetching full contents for a changed file (lower first); null = do not fetch. */
export function contentPriority(f: Pick<PrFileSnapshot, 'path' | 'status'>): number | null {
  const path = f.path;
  if (isLockFile(path) || isGeneratedPath(path)) return null;
  if (isMigrationPath(path) || isSchemaDefinitionPath(path)) return 0;
  if (isDependencyManifest(path)) return 1;
  const lang = detectLanguage(path);
  if (!isSourceLanguage(lang)) return null;
  return isTestPath(path) ? 3 : 2;
}

/** Picks which changed files get before/after contents, most relevant and largest first. */
export function selectContentFiles(files: readonly PrFileSnapshot[], max: number): Set<string> {
  const ranked = files
    .map((f) => ({ f, p: contentPriority(f) }))
    .filter((x): x is { f: PrFileSnapshot; p: number } => x.p !== null)
    .sort(
      (a, b) =>
        a.p - b.p ||
        b.f.additions + b.f.deletions - (a.f.additions + a.f.deletions) ||
        (a.f.path < b.f.path ? -1 : 1),
    );
  return new Set(ranked.slice(0, Math.max(0, max)).map((x) => x.f.path));
}

export interface ChangedFilesResult {
  files: ChangedFileInput[];
  limitations: string[];
  /** Files whose contents were fetched. */
  contentPaths: string[];
}

/**
 * Converts snapshot files into analysis inputs. Before contents come from `baseRef` (the merge
 * base when known), after contents from the head sha. Fetch failures degrade to patch-only.
 */
export async function buildChangedFiles(
  ctx: WorkerContext,
  repo: RepoTarget,
  snap: PrSnapshot,
  baseRef: string,
): Promise<ChangedFilesResult> {
  const headSha = snap.pullRequest.headSha;
  const { maxContentFiles, maxContentBytes, contentConcurrency } = ctx.limits;
  const selected = selectContentFiles(snap.files, maxContentFiles);
  const eligible = snap.files.filter((f) => contentPriority(f) !== null).length;
  const limitations: string[] = [];
  if (eligible > selected.size) {
    limitations.push(
      `Full file contents were analysed for ${selected.size} of ${eligible} changed source files; the rest were analysed from the diff only.`,
    );
  }
  let failures = 0;
  const fetchContent = async (path: string, ref: string): Promise<string | null> => {
    try {
      return await ctx.github.getFileContent(repo, path, ref, { maxBytes: maxContentBytes });
    } catch (err) {
      failures += 1;
      ctx.logger.debug({ err, path }, 'file content fetch failed; using diff only');
      return null;
    }
  };
  const files = await mapLimit(snap.files, contentConcurrency, async (f) => {
    const input: ChangedFileInput = {
      path: f.path,
      status: f.status,
      previousPath: f.previousPath,
      patch: f.patch,
      additions: f.additions,
      deletions: f.deletions,
    };
    if (selected.has(f.path)) {
      const [before, after] = await Promise.all([
        f.status === 'added' ? null : fetchContent(f.previousPath ?? f.path, baseRef),
        f.status === 'removed' ? null : fetchContent(f.path, headSha),
      ]);
      if (before !== null) input.before = before;
      if (after !== null) input.after = after;
    }
    return input;
  });
  if (failures > 0) {
    limitations.push(
      `${failures} file content request(s) failed; affected files were analysed from the diff only.`,
    );
  }
  return { files, limitations, contentPaths: [...selected] };
}

const ALERT_SEVERITY: Record<string, Severity> = {
  critical: 'critical',
  high: 'high',
  error: 'high',
  medium: 'medium',
  moderate: 'medium',
  warning: 'medium',
  low: 'low',
  note: 'low',
};

function alertSeverity(a: SecurityAlertSummary): Severity {
  return ALERT_SEVERITY[(a.severity ?? '').toLowerCase()] ?? 'medium';
}

/** Severity of context-only alerts that GitHub does not attribute to this PR. */
const CONTEXT_ALERT_MAX: Severity = 'medium';

function capSeverity(sev: Severity, max: Severity): Severity {
  return severityAtLeast(sev, max) ? max : sev;
}

/**
 * GitHub security alerts relevant to this PR.
 *
 * - A code-scanning alert on a line this PR adds is attributed to the PR: verified, with the
 *   alert's severity.
 * - Other open alerts (code scanning elsewhere in a changed file, and every Dependabot alert,
 *   which describes the default branch) already existed before the PR. They are reported as
 *   context only: unverified and capped at medium, so a pre-existing repository problem never
 *   escalates the PR or marks it as the PR's own verified risk.
 */
export function githubAlertFindings(repoFullName: string, snap: PrSnapshot): Finding[] {
  const touched = new Set(snap.files.map((f) => f.path));
  const addedByPath = new Map<string, Set<number>>();
  for (const f of snap.files) {
    if (!f.patch) continue;
    addedByPath.set(f.path, new Set(addedLines(parseUnifiedDiff(f.patch)).map((l) => l.line)));
  }
  const out: Finding[] = [];
  for (const a of snap.codeScanningAlerts.alerts) {
    if (a.state !== 'open' || !a.path || !touched.has(a.path)) continue;
    const onAddedLine = a.startLine !== null && !!addedByPath.get(a.path)?.has(a.startLine);
    const evidence = {
      repo: repoFullName,
      path: a.path,
      source: 'github' as const,
      ...(a.startLine ? { line: a.startLine } : {}),
      ...(a.url ? { url: a.url } : {}),
    };
    out.push(
      makeFinding({
        ruleId: `github.code_scanning.${a.ruleId ?? 'alert'}`,
        category: 'security',
        severity: onAddedLine ? alertSeverity(a) : capSeverity(alertSeverity(a), CONTEXT_ALERT_MAX),
        title: onAddedLine
          ? `Code scanning alert on a line this PR adds: ${a.title}`
          : `Existing code scanning alert in a changed file: ${a.title}`,
        description: onAddedLine
          ? `GitHub code scanning${a.tool ? ` (${a.tool})` : ''} reports an open alert in ${a.path} at a line this pull request adds.`
          : `GitHub code scanning${a.tool ? ` (${a.tool})` : ''} reports an open alert in ${a.path}, which this pull request changes. The alert is not on a line this pull request adds, so it most likely existed before; it is shown for context.`,
        recommendation:
          'Review the alert on GitHub and confirm whether this change fixes or affects it.',
        evidence: [evidence],
        identity: [a.ruleId ?? a.title, a.path],
        source: 'github',
        verified: onAddedLine,
      }),
    );
  }
  for (const a of snap.dependabotAlerts.alerts) {
    if (a.state !== 'open' || !a.manifestPath || !touched.has(a.manifestPath)) continue;
    const pkg = a.packageName ?? 'a dependency';
    out.push(
      makeFinding({
        ruleId: 'github.dependabot',
        category: 'security',
        severity: capSeverity(alertSeverity(a), CONTEXT_ALERT_MAX),
        title: `Existing vulnerability alert for ${pkg}`,
        description: `Dependabot reports an open vulnerability${a.ghsaId ? ` (${a.ghsaId})` : ''} in ${pkg}${a.severity ? ` (GitHub severity: ${a.severity})` : ''}, declared in ${a.manifestPath}, which this pull request changes. The alert describes the default branch, so it existed before this pull request; it is shown for context and is not counted as a risk this pull request introduces.`,
        recommendation: a.fixedIn
          ? `Check whether this pull request upgrades ${pkg} to ${a.fixedIn} or later; otherwise track the upgrade separately.`
          : 'Review the alert on GitHub.',
        evidence: [
          {
            repo: repoFullName,
            path: a.manifestPath,
            source: 'github',
            ...(a.url ? { url: a.url } : {}),
          },
        ],
        identity: [pkg, a.ghsaId ?? a.cveId ?? a.title, a.manifestPath],
        source: 'github',
        verified: false,
      }),
    );
  }
  return out;
}

/**
 * Writes the fetched head contents of changed files into a temporary directory so external
 * scanners (gitleaks/semgrep) can run without a full checkout. Returns null when there is
 * nothing to scan.
 */
export async function materializeHeadFiles(
  files: readonly ChangedFileInput[],
): Promise<{ dir: string; cleanup: () => Promise<void> } | null> {
  const withContent = files.filter(
    (f): f is ChangedFileInput & { after: string } => typeof f.after === 'string',
  );
  if (withContent.length === 0) return null;
  const dir = await mkdtemp(join(tmpdir(), 'gmp-scan-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    for (const f of withContent) {
      const rel = normalize(f.path);
      if (rel.startsWith('..') || rel.startsWith('/') || rel.includes('\0')) continue;
      // PR content must not configure the scanners (allow-lists, ignore files).
      if (isScannerControlFile(rel)) continue;
      const target = join(dir, rel);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, f.after, 'utf8');
    }
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { dir, cleanup };
}

/**
 * Pins the commit each evidence line refers to: base-side evidence (removed code) to the merge
 * base, everything else to the analysed head. Links then stay correct after later pushes.
 * Evidence from other repositories (related PRs) and evidence with its own URL is left alone.
 */
export function pinEvidenceRefs(
  items: ReadonlyArray<{ evidence: Evidence[] }>,
  repoFullName: string,
  refs: { base: string; head: string },
): void {
  for (const item of items) {
    for (const e of item.evidence) {
      if (e.ref || e.url || !e.path || e.repo !== repoFullName) continue;
      e.ref = e.side === 'base' ? refs.base : refs.head;
    }
  }
}
