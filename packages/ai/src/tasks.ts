import type {
  Evidence,
  Recommendation,
  RelationshipConfidence,
  RelationshipType,
  RiskLevel,
} from '@gmp/core';
import { isDocPath, listPreview, plural } from './classify.ts';
import { createPathMatcher, mentionsExcludedPath } from './glob.ts';
import { buildWrappedUserMessage, type PromptBuildOptions } from './prompt.ts';
import type { RepoContext } from './report-input.ts';

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

export interface TriageInput {
  repo: RepoContext;
  pr: { number: number; title: string; body?: string | null };
  /** Files changed since the previous analysis (or the whole PR when there is none). */
  changedFiles: Array<{
    path: string;
    status?: string;
    additions?: number;
    deletions?: number;
    patch?: string | null;
  }>;
  commitMessages?: string[];
  previousSummary?: string | null;
  /** Number of new/changed deterministic findings since the previous analysis. */
  newFindings?: number;
  pullRequestId?: string | null;
  analysisId?: string | null;
}

export interface TriageResult {
  meaningful: boolean;
  reason: string;
  generatedBy: 'ai' | 'deterministic';
}

const WHITESPACE_ONLY_LINE = /^[+-]\s*$/;

/** Rule-based triage used when AI is unavailable: anything but docs-only / whitespace-only changes is meaningful. */
export function deterministicTriage(input: TriageInput): TriageResult {
  const files = input.changedFiles;
  if ((input.newFindings ?? 0) > 0) {
    return {
      meaningful: true,
      reason: `${plural(input.newFindings ?? 0, 'new finding')} since the last analysis.`,
      generatedBy: 'deterministic',
    };
  }
  if (files.length === 0) {
    return {
      meaningful: false,
      reason: 'No file changes since the last analysis.',
      generatedBy: 'deterministic',
    };
  }
  if (files.every((f) => isDocPath(f.path))) {
    return {
      meaningful: false,
      reason: 'Only documentation changed since the last analysis.',
      generatedBy: 'deterministic',
    };
  }
  const allWhitespace = files.every((f) => {
    if (!f.patch) return false;
    const changed = f.patch
      .split('\n')
      .filter(
        (l) =>
          (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'),
      );
    return changed.length > 0 && changed.every((l) => WHITESPACE_ONLY_LINE.test(l));
  });
  if (allWhitespace) {
    return {
      meaningful: false,
      reason: 'Only whitespace changed since the last analysis.',
      generatedBy: 'deterministic',
    };
  }
  return {
    meaningful: true,
    reason: `${plural(files.length, 'file')} changed (${listPreview(
      files.map((f) => f.path),
      3,
    )}).`,
    generatedBy: 'deterministic',
  };
}

export function buildTriageMessage(input: TriageInput, opts: PromptBuildOptions = {}) {
  const excluded = createPathMatcher(input.repo.excludePaths ?? []);
  const metadataOnly = input.repo.aiMode === 'metadata_only';
  const files = input.changedFiles.filter((f) => !excluded(f.path));
  const sections: Array<{ kind: string; content: string; attrs?: Record<string, string> }> = [
    {
      kind: 'pull_request',
      content: `#${input.pr.number} ${input.pr.title}\n\n${(input.pr.body ?? '').slice(0, 3_000)}`,
    },
    {
      kind: 'changed_files',
      content:
        files
          .map(
            (f) =>
              `${f.status ?? 'modified'}\t+${f.additions ?? 0}\t-${f.deletions ?? 0}\t${f.path}`,
          )
          .join('\n') || '(none)',
    },
  ];
  if (input.commitMessages?.length) {
    sections.push({
      kind: 'commit_messages',
      content: input.commitMessages
        .slice(-30)
        .map((m) => `- ${m.split('\n')[0]}`)
        .join('\n'),
    });
  }
  if (input.previousSummary)
    sections.push({
      kind: 'previous_report_summary',
      content: input.previousSummary.slice(0, 2_000),
    });
  if (!metadataOnly) {
    for (const f of files.filter((x) => x.patch).slice(0, 40)) {
      sections.push({
        kind: 'diff',
        content: (f.patch ?? '').slice(0, 6_000),
        attrs: { path: f.path },
      });
    }
  }
  return buildWrappedUserMessage(
    'Decide whether these changes are meaningful enough to regenerate the pull request report. Output the JSON object.',
    sections,
    { ...opts, maxInputTokens: Math.min(opts.maxInputTokens ?? 30_000, 30_000) },
  );
}

// ---------------------------------------------------------------------------
// Relationship confirmation
// ---------------------------------------------------------------------------

export interface PrBrief {
  id: string;
  /** e.g. `owner/repo#12` */
  ref: string;
  title: string;
  body?: string | null;
  files?: string[];
  repo: RepoContext;
}

export interface RelationshipCandidate {
  prA: PrBrief;
  prB: PrBrief;
  type: RelationshipType;
  confidence: RelationshipConfidence;
  summary: string;
  evidence?: Evidence[];
}

export interface ConfirmedRelationship extends RelationshipCandidate {
  /** Set when the AI reviewed the candidate. */
  ai?: { related: boolean; rationale: string };
}

export function buildRelationshipMessage(
  candidates: RelationshipCandidate[],
  opts: PromptBuildOptions = {},
) {
  const brief = (p: PrBrief) => {
    const excluded = createPathMatcher(p.repo.excludePaths ?? []);
    return {
      ref: p.ref,
      title: p.title,
      description: (p.body ?? '').slice(0, 1_500),
      files: (p.files ?? []).filter((f) => !excluded(f)).slice(0, 60),
    };
  };
  const sections = candidates.map((c, index) => {
    // The static summary lists file paths; withhold it when it names a path either repository
    // excludes from AI review (the filtered file lists below are still sent).
    const matchers = [
      createPathMatcher(c.prA.repo.excludePaths ?? []),
      createPathMatcher(c.prB.repo.excludePaths ?? []),
    ];
    const evidencePaths = (c.evidence ?? []).map((e) => e.path).filter((p): p is string => !!p);
    const withheld =
      mentionsExcludedPath(c.summary, matchers) ||
      evidencePaths.some((p) => matchers.some((m) => m(p)));
    return {
      kind: 'candidate',
      attrs: { index: String(index) },
      content: JSON.stringify({
        index,
        type: c.type,
        staticAnalysisSummary: withheld
          ? '(withheld: it involves paths excluded from AI review)'
          : c.summary,
        prA: brief(c.prA),
        prB: brief(c.prB),
      }),
    };
  });
  return buildWrappedUserMessage(
    `Judge each of the ${candidates.length} candidate relationships (indexes 0..${candidates.length - 1}). Output the JSON object with one verdict per index.`,
    sections,
    opts,
  );
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

export interface DigestItem {
  prRef: string;
  title: string;
  repo: string;
  url?: string | null;
  overallRisk?: RiskLevel | null;
  recommendation?: Recommendation | null;
  summary?: string | null;
  highlights?: string[];
  /** Repo AI mode; items whose repo is `off` are never sent to the AI. */
  aiMode?: RepoContext['aiMode'];
}

export interface DigestInput {
  orgName?: string;
  periodLabel: string;
  projectName?: string | null;
  items: DigestItem[];
  stats?: Record<string, number>;
}

const RISK_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Plain-text digest written without AI. */
export function renderDeterministicDigest(input: DigestInput): string {
  const items = [...input.items].sort(
    (a, b) => (RISK_ORDER[a.overallRisk ?? 'low'] ?? 4) - (RISK_ORDER[b.overallRisk ?? 'low'] ?? 4),
  );
  const lines: string[] = [];
  const scope = input.projectName
    ? ` for ${input.projectName}`
    : input.orgName
      ? ` for ${input.orgName}`
      : '';
  lines.push(`Pull request digest${scope} — ${input.periodLabel}`);
  if (input.stats && Object.keys(input.stats).length) {
    lines.push(
      Object.entries(input.stats)
        .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
        .join(' · '),
    );
  }
  if (items.length === 0) {
    lines.push('', 'No pull request activity needing attention in this period.');
    return lines.join('\n');
  }
  const urgent = items.filter(
    (i) =>
      i.overallRisk === 'critical' ||
      i.overallRisk === 'high' ||
      i.recommendation === 'escalate' ||
      i.recommendation === 'changes_required',
  );
  if (urgent.length) {
    lines.push('', 'Needs attention:');
    for (const i of urgent.slice(0, 10)) lines.push(`- ${formatItem(i)}`);
  }
  const rest = items.filter((i) => !urgent.includes(i));
  if (rest.length) {
    lines.push('', 'Other activity:');
    for (const i of rest.slice(0, 30)) lines.push(`- ${formatItem(i)}`);
    if (rest.length > 30) lines.push(`- … and ${rest.length - 30} more`);
  }
  return lines.join('\n');
}

function formatItem(i: DigestItem): string {
  const risk = i.overallRisk ? ` [${i.overallRisk} risk]` : '';
  const rec = i.recommendation ? ` — ${i.recommendation.replace(/_/g, ' ')}` : '';
  const hl = i.highlights?.length ? ` (${listPreview(i.highlights, 3)})` : '';
  return `${i.prRef} ${i.title}${risk}${rec}${hl}`;
}

export function buildDigestMessage(input: DigestInput, opts: PromptBuildOptions = {}) {
  const items = input.items
    .filter((i) => i.aiMode !== 'off')
    .map((i) => ({
      prRef: i.prRef,
      title: i.title,
      overallRisk: i.overallRisk ?? null,
      recommendation: i.recommendation ?? null,
      summary: i.aiMode === 'metadata_only' ? null : (i.summary ?? '').slice(0, 600) || null,
      highlights: (i.highlights ?? []).slice(0, 5),
    }));
  return buildWrappedUserMessage(
    `Write the ${input.periodLabel} digest${input.projectName ? ` for project "${input.projectName}"` : ''}.`,
    [
      { kind: 'digest_stats', content: JSON.stringify(input.stats ?? {}) },
      { kind: 'digest_items', content: JSON.stringify(items) },
    ],
    { ...opts, maxInputTokens: Math.min(opts.maxInputTokens ?? 40_000, 40_000) },
  );
}
