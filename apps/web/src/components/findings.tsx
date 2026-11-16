import { ChevronDown, FileCode2 } from 'lucide-react';
import { useState } from 'react';
import type { Evidence, Finding, FindingLifecycle } from '../api/types.ts';
import { CATEGORY_LABEL } from '../lib/format.ts';
import { evidenceLabel, evidenceUrl } from '../lib/links.ts';
import { SeverityBadge, VerifiedBadge } from './badges.tsx';
import { Badge, ExternalA, PlainText } from './ui.tsx';

export interface LinkContext {
  /** GitHub web base URL (e.g. https://github.com). */
  webUrl?: string | undefined;
  /** Ref (the analysed head SHA) used to build file links when evidence has no URL or ref. */
  ref?: string | undefined;
  /** Ref for base-side evidence (removed code) without its own ref. */
  baseRef?: string | undefined;
}

const SOURCE_LABEL: Record<Evidence['source'], string> = {
  diff: 'from the diff',
  index: 'from the code index',
  github: 'from GitHub',
  scanner: 'from a scanner',
  ai: 'from AI',
};

export function EvidenceList({ evidence, ctx }: { evidence: Evidence[]; ctx: LinkContext }) {
  if (!evidence.length) return null;
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-400">
        Evidence
      </h4>
      <ul className="space-y-2">
        {evidence.map((ev, i) => {
          const url = evidenceUrl(ev, ctx);
          return (
            <li key={`${ev.repo}:${ev.path ?? ''}:${ev.line ?? ''}:${i}`} className="text-sm">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <FileCode2 className="size-4 shrink-0 text-slate-400" aria-hidden />
                {url ? (
                  <ExternalA href={url} className="font-mono text-xs break-all">
                    {evidenceLabel(ev)}
                  </ExternalA>
                ) : (
                  <span className="font-mono text-xs break-all">{evidenceLabel(ev)}</span>
                )}
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {SOURCE_LABEL[ev.source]}
                </span>
              </div>
              {ev.snippet && (
                <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-slate-100 p-2 font-mono text-xs whitespace-pre text-slate-800 dark:bg-slate-950 dark:text-slate-200">
                  {ev.snippet}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const LIFECYCLE_TONE = { new: 'red', unchanged: 'gray', resolved: 'green' } as const;
const LIFECYCLE_LABEL: Record<FindingLifecycle, string> = {
  new: 'New',
  unchanged: 'Unchanged',
  resolved: 'Resolved',
};

export function LifecycleBadge({ lifecycle }: { lifecycle: FindingLifecycle }) {
  return <Badge tone={LIFECYCLE_TONE[lifecycle]}>{LIFECYCLE_LABEL[lifecycle]}</Badge>;
}

/** Plain-language-first finding card; technical detail + evidence are expandable. */
export function FindingCard({
  finding,
  ctx,
  lifecycle,
  defaultOpen = false,
}: {
  finding: Finding;
  ctx: LinkContext;
  lifecycle?: FindingLifecycle | undefined;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hasDetail = Boolean(
    finding.technicalDetail ||
    finding.evidence.length ||
    finding.affected?.length ||
    finding.ruleId,
  );
  const detailId = `finding-${finding.fingerprint}`;
  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <div className="flex flex-wrap items-center gap-1.5">
        <SeverityBadge severity={finding.severity} />
        <VerifiedBadge verified={finding.verified} />
        <Badge tone="gray">{CATEGORY_LABEL[finding.category]}</Badge>
        {lifecycle && <LifecycleBadge lifecycle={lifecycle} />}
      </div>
      <h3 className="mt-2 font-medium break-words text-slate-900 dark:text-slate-100">
        {finding.title}
      </h3>
      <PlainText
        text={finding.description}
        className="mt-1 text-sm text-slate-700 dark:text-slate-300"
      />
      {finding.whatMightBreak && (
        <div className="mt-2 text-sm">
          <span className="font-medium text-slate-800 dark:text-slate-200">What might break: </span>
          <span className="text-slate-700 dark:text-slate-300">{finding.whatMightBreak}</span>
        </div>
      )}
      {finding.recommendation && (
        <div className="mt-2 text-sm">
          <span className="font-medium text-slate-800 dark:text-slate-200">
            Suggested next step:{' '}
          </span>
          <span className="text-slate-700 dark:text-slate-300">{finding.recommendation}</span>
        </div>
      )}
      {hasDetail && (
        <>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={detailId}
            className="mt-3 inline-flex items-center gap-1 rounded text-sm font-medium text-indigo-700 hover:underline focus-visible:outline-2 focus-visible:outline-indigo-500 dark:text-indigo-300"
          >
            <ChevronDown
              className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`}
              aria-hidden
            />
            {open ? 'Hide technical details' : 'Show technical details'}
          </button>
          {open && (
            <div
              id={detailId}
              className="mt-3 space-y-3 border-t border-slate-200 pt-3 dark:border-slate-700"
            >
              {finding.technicalDetail && (
                <PlainText
                  text={finding.technicalDetail}
                  className="text-sm text-slate-700 dark:text-slate-300"
                />
              )}
              {finding.affected && finding.affected.length > 0 && (
                <div className="text-sm">
                  <span className="font-medium">Affected: </span>
                  <span className="font-mono text-xs break-all">{finding.affected.join(', ')}</span>
                </div>
              )}
              <EvidenceList evidence={finding.evidence} ctx={ctx} />
              {finding.ruleId && (
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Rule: {finding.ruleId}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </article>
  );
}

export function FindingList({
  findings,
  ctx,
  empty,
  lifecycleByFingerprint,
}: {
  findings: Finding[];
  ctx: LinkContext;
  empty: React.ReactNode;
  lifecycleByFingerprint?: Map<string, FindingLifecycle>;
}) {
  if (!findings.length) return <>{empty}</>;
  // Verified facts first, then by severity.
  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
  const sorted = [...findings].sort(
    (a, b) => order[a.severity] - order[b.severity] || Number(b.verified) - Number(a.verified),
  );
  return (
    <div className="space-y-3">
      {sorted.map((f) => (
        <FindingCard
          key={f.fingerprint}
          finding={f}
          ctx={ctx}
          lifecycle={lifecycleByFingerprint?.get(f.fingerprint)}
        />
      ))}
    </div>
  );
}
