import { clsx } from 'clsx';
import { ChevronDown, GitBranch, RefreshCw, Share2, ShieldCheck, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { errorMessage } from '../api/client.ts';
import {
  currentRunOf,
  runKey,
  useAnalyses,
  useGithubStatus,
  useIsAdmin,
  usePullRequest,
  useReanalyze,
  type AwaitRun,
} from '../api/hooks.ts';
import {
  RISK_DIMENSIONS,
  type AffectedAreas,
  type AnalysisHistoryItem,
  type FindingLifecycle,
  type PrReport,
  type PullRequestDetail,
  type RiskScore,
} from '../api/types.ts';
import { AiBudgetBanner, AiDisabledBanner } from '../components/banners.tsx';
import {
  AnalysisStatusBadge,
  ConfidenceBadge,
  PrStateBadge,
  RecommendationBadge,
  RiskBadge,
  RISK_TONE,
  SeverityBadge,
} from '../components/badges.tsx';
import {
  EvidenceList,
  FindingList,
  LifecycleBadge,
  type LinkContext,
} from '../components/findings.tsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  ErrorState,
  ExternalA,
  LoadingBlock,
  PageHeader,
  PlainText,
  TabPanel,
  Tabs,
} from '../components/ui.tsx';
import {
  CATEGORY_LABEL,
  DIMENSION_HINT,
  DIMENSION_LABEL,
  RECOMMENDATION_HINT,
  RELATIONSHIP_LABEL,
  formatDateTime,
  shortSha,
  timeAgo,
} from '../lib/format.ts';
import { githubFileUrl } from '../lib/links.ts';
import { riskShareLines, riskShareText } from '../lib/riskShare.ts';

const Markdown = lazy(() =>
  import('../components/Markdown.tsx').then((m) => ({ default: m.Markdown })),
);

/** Wording used whenever no security issue was found. Never claims the change is "secure". */
export const NO_SECURITY_ISSUES_TEXT = 'No issues detected by automated checks';

function List({
  items,
  empty = 'None',
  mono = false,
}: {
  items: string[];
  empty?: string;
  mono?: boolean;
}) {
  if (!items.length) return <p className="text-sm text-slate-500 dark:text-slate-400">{empty}</p>;
  return (
    <ul
      className={clsx(
        'list-disc space-y-1 pl-5 text-sm text-slate-800 dark:text-slate-200',
        mono && 'font-mono text-xs break-all',
      )}
    >
      {items.map((i, idx) => (
        <li key={`${i}-${idx}`}>{i}</li>
      ))}
    </ul>
  );
}

function Section({
  title,
  children,
  description,
}: {
  title: string;
  children: ReactNode;
  description?: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
      {description && <p className="text-sm text-slate-600 dark:text-slate-400">{description}</p>}
      {children}
    </section>
  );
}

function Collapsible({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 p-3 text-left text-sm font-medium focus-visible:outline-2 focus-visible:outline-indigo-500"
      >
        {title}
        <ChevronDown
          className={clsx('size-4 transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      {open && (
        <div className="border-t border-slate-200 p-3 dark:border-slate-700">{children}</div>
      )}
    </div>
  );
}

const AREA_LABELS: Array<[keyof AffectedAreas, string]> = [
  ['modules', 'Modules'],
  ['services', 'Services'],
  ['apis', 'APIs'],
  ['databaseTables', 'Database tables'],
  ['sharedComponents', 'Shared components'],
  ['integrations', 'Integrations'],
  ['configuration', 'Configuration'],
  ['infrastructure', 'Infrastructure'],
];

function AffectedAreasView({ areas }: { areas: AffectedAreas }) {
  const present = AREA_LABELS.filter(([k]) => areas[k]?.length);
  if (!present.length)
    return (
      <p className="text-sm text-slate-500 dark:text-slate-400">No specific areas identified.</p>
    );
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      {present.map(([k, label]) => (
        <div key={k}>
          <dt className="text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-400">
            {label}
          </dt>
          <dd className="mt-1 flex flex-wrap gap-1">
            {areas[k].map((v) => (
              <Badge key={v} tone="gray" className="max-w-full truncate">
                {v}
              </Badge>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function SummaryTab({ detail, report }: { detail: PullRequestDetail; report: PrReport }) {
  const pr = detail.pullRequest;
  const mr = report.mergeReadiness;
  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">Merge readiness</h3>
          <RecommendationBadge value={mr.recommendation} />
        </div>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          {RECOMMENDATION_HINT[mr.recommendation]}
        </p>
        <PlainText text={mr.rationale} className="mt-2 text-sm" />
        {mr.blockers.length > 0 && (
          <div className="mt-3">
            <div className="text-sm font-medium">Before merging</div>
            <List items={mr.blockers} />
          </div>
        )}
      </Card>

      <Section title="What this change does">
        <PlainText text={report.executiveSummary} className="text-slate-800 dark:text-slate-200" />
      </Section>
      <Section title="Business impact">
        <PlainText text={report.businessImpact} className="text-slate-800 dark:text-slate-200" />
      </Section>
      {report.recommendedActions.length > 0 && (
        <Section title="Recommended actions">
          <List items={report.recommendedActions} />
        </Section>
      )}
      <Section title="Affected areas">
        <AffectedAreasView areas={report.affectedAreas} />
      </Section>
      <Section title="How confident is this report?">
        <div className="flex items-center gap-3">
          <div
            className="h-2 w-40 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={report.confidence.score}
            aria-label="Report confidence"
          >
            <div
              className="h-full bg-indigo-500"
              style={{ width: `${report.confidence.score}%` }}
            />
          </div>
          <span className="text-sm font-medium tabular-nums">{report.confidence.score}/100</span>
        </div>
        <PlainText
          text={report.confidence.rationale}
          className="text-sm text-slate-700 dark:text-slate-300"
        />
      </Section>

      <Collapsible title="Technical summary">
        <PlainText text={report.technicalSummary} className="text-sm" />
      </Collapsible>
      {pr.linkedIssues?.length > 0 && (
        <Collapsible title={`Linked issues (${pr.linkedIssues.length})`}>
          <ul className="space-y-1 text-sm">
            {pr.linkedIssues.map((i) => (
              <li key={`${i.repo ?? ''}#${i.number}`}>
                <ExternalA href={i.url}>
                  {i.repo ? `${i.repo}#${i.number}` : `#${i.number}`}
                  {i.title ? ` — ${i.title}` : ''}
                </ExternalA>
                {i.closing && <Badge className="ml-2">closes</Badge>}
              </li>
            ))}
          </ul>
        </Collapsible>
      )}
      {pr.body && pr.body.trim() && (
        <Collapsible title="Author’s description">
          <Suspense fallback={<PlainText text={pr.body} className="text-sm" />}>
            <Markdown text={pr.body} />
          </Suspense>
        </Collapsible>
      )}
    </div>
  );
}

function DimensionCard({ score, ctx }: { score: RiskScore; ctx: LinkContext }) {
  const barColor = {
    critical: 'bg-red-500',
    high: 'bg-orange-500',
    medium: 'bg-amber-400',
    low: 'bg-emerald-500',
  }[score.level];
  return (
    <Card as="article">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{DIMENSION_LABEL[score.dimension]}</h3>
        <Badge tone={RISK_TONE[score.level]}>
          {score.level[0]!.toUpperCase() + score.level.slice(1)}
        </Badge>
      </div>
      <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
        {DIMENSION_HINT[score.dimension]}
      </p>
      <div className="mt-3 flex items-center gap-3">
        <div
          className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={score.score}
          aria-label={`${DIMENSION_LABEL[score.dimension]} risk score`}
        >
          <div
            className={clsx('h-full', barColor)}
            style={{ width: `${Math.max(2, score.score)}%` }}
          />
        </div>
        <span className="w-12 text-right text-sm font-semibold tabular-nums">{score.score}</span>
      </div>
      <PlainText
        text={score.rationale}
        className="mt-3 text-sm text-slate-700 dark:text-slate-300"
      />
      {score.evidence.length > 0 && (
        <div className="mt-3">
          <EvidenceList evidence={score.evidence} ctx={ctx} />
        </div>
      )}
    </Card>
  );
}

/** "Share issues" dropdown: one line per risk, copyable as plain text for Slack, WhatsApp, etc. */
function ShareRisksMenu({ detail, report }: { detail: PullRequestDetail; report: PrReport }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const lines = useMemo(() => riskShareLines(report), [report]);
  const text = useMemo(() => riskShareText(detail, lines), [detail, lines]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <Button
        variant="secondary"
        size="sm"
        icon={<Share2 className="size-4" aria-hidden />}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        Share issues
      </Button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Share issues"
          className="absolute right-0 z-20 mt-2 w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-slate-200 bg-white p-4 shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                PR #{detail.pullRequest.number}: {detail.pullRequest.title}
              </p>
              <p className="text-xs text-slate-600 dark:text-slate-300">
                {lines.length} {lines.length === 1 ? 'issue' : 'issues'} to share
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Paste into Slack, WhatsApp or any chat. The PR link is included.
              </p>
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={() => setOpen(false)}
              className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
          {lines.length ? (
            <ul className="max-h-72 list-disc space-y-1.5 overflow-y-auto pl-5 text-sm text-slate-800 dark:text-slate-200">
              {lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-600 dark:text-slate-400">
              No risks above “low” were found by the automated analysis.
            </p>
          )}
          <div className="mt-4 flex justify-end">
            <CopyButton value={text} label="Copy to clipboard" />
          </div>
        </div>
      )}
    </div>
  );
}

function RiskTab({
  detail,
  report,
  ctx,
}: {
  detail: PullRequestDetail;
  report: PrReport;
  ctx: LinkContext;
}) {
  const byDim = new Map(report.riskScores.map((s) => [s.dimension, s]));
  const ordered = RISK_DIMENSIONS.map((d) => byDim.get(d)).filter((s): s is RiskScore =>
    Boolean(s),
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-slate-700 dark:text-slate-300">Overall:</span>
          <RiskBadge level={report.overallRisk} />
          <span className="text-xs text-slate-500 dark:text-slate-400">
            The overall level is the highest of the six dimensions below.
          </span>
        </div>
        <ShareRisksMenu detail={detail} report={report} />
      </div>
      {ordered.length ? (
        <div className="grid gap-4 md:grid-cols-2">
          {ordered.map((s) => (
            <DimensionCard key={s.dimension} score={s} ctx={ctx} />
          ))}
        </div>
      ) : (
        <EmptyState title="No risk scores yet">
          Scores appear after the analysis completes.
        </EmptyState>
      )}
    </div>
  );
}

function BreakingTab({
  report,
  ctx,
  lifecycles,
}: {
  report: PrReport;
  ctx: LinkContext;
  lifecycles: Map<string, FindingLifecycle>;
}) {
  return (
    <div className="space-y-8">
      <Section
        title="Breaking changes"
        description="Changes that may break code, services or people relying on this repository."
      >
        <FindingList
          findings={report.breakingChanges}
          ctx={ctx}
          lifecycleByFingerprint={lifecycles}
          empty={<Alert tone="success">No breaking changes detected by automated checks.</Alert>}
        />
      </Section>
      <Section
        title="Integration impact"
        description="Effects on other services, APIs, events or shared components."
      >
        <FindingList
          findings={report.integrationImpact}
          ctx={ctx}
          lifecycleByFingerprint={lifecycles}
          empty={
            <p className="text-sm text-slate-600 dark:text-slate-400">
              No integration impact identified.
            </p>
          }
        />
      </Section>
    </div>
  );
}

function SecurityTab({
  report,
  ctx,
  lifecycles,
}: {
  report: PrReport;
  ctx: LinkContext;
  lifecycles: Map<string, FindingLifecycle>;
}) {
  return (
    <div className="space-y-4">
      <FindingList
        findings={report.security}
        ctx={ctx}
        lifecycleByFingerprint={lifecycles}
        empty={
          <Alert tone="success" title={NO_SECURITY_ISSUES_TEXT}>
            Built-in rules and available scanners found nothing in this change. Automated checks
            cannot catch every problem, so a human review is still recommended for sensitive code.
          </Alert>
        }
      />
      {report.security.length > 0 && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          “Verified fact” items come from scanners and rules run on the actual code. “Potential
          concern” items are AI suggestions worth checking.
        </p>
      )}
    </div>
  );
}

function RelatedTab({ detail, report }: { detail: PullRequestDetail; report: PrReport }) {
  const rels = detail.relationships.filter((r) => r.active !== false);
  const order = { confirmed: 0, likely: 1, possible: 2 } as const;
  rels.sort((a, b) => order[a.confidence] - order[b.confidence]);
  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Other open pull requests that touch the same code, data or contracts.{' '}
        <strong>Confirmed</strong> means overlapping edits were found; <strong>possible</strong> is
        a weaker signal worth a quick check with both authors.
      </p>
      {rels.length ? (
        <ul className="space-y-3">
          {rels.map((r) => (
            <li key={r.id} className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
              <div className="flex flex-wrap items-center gap-1.5">
                <ConfidenceBadge confidence={r.confidence} />
                <Badge>{RELATIONSHIP_LABEL[r.type]}</Badge>
                {r.otherPr.overallRisk && <RiskBadge level={r.otherPr.overallRisk} />}
              </div>
              <div className="mt-2 font-medium break-words">
                <Link
                  to={`/pull-requests/${r.otherPr.id}`}
                  className="text-indigo-700 hover:underline dark:text-indigo-300"
                >
                  {r.otherPr.title}
                </Link>
              </div>
              <div className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
                <ExternalA href={r.otherPr.htmlUrl} className="text-xs">
                  {r.otherPr.repositoryFullName}#{r.otherPr.number}
                </ExternalA>
                {r.otherPr.authorLogin ? ` · by ${r.otherPr.authorLogin}` : ''}
              </div>
              <PlainText
                text={r.summary}
                className="mt-2 text-sm text-slate-700 dark:text-slate-300"
              />
              {r.evidence.length > 0 && (
                <div className="mt-3">
                  <EvidenceList evidence={r.evidence} ctx={{ webUrl: undefined, ref: undefined }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No related pull requests">
          No other open pull request touches the same files, code, tables or contracts.
        </EmptyState>
      )}
      {report.overlappingWork.some((o) => o.suggestedCoordination) && (
        <Section title="Suggested coordination">
          <ul className="space-y-2 text-sm">
            {report.overlappingWork
              .filter((o) => o.suggestedCoordination)
              .map((o, i) => (
                <li
                  key={`${o.prRef}-${i}`}
                  className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60"
                >
                  <span className="font-medium">{o.prRef}</span>{' '}
                  <ConfidenceBadge confidence={o.confidence} />
                  <p className="mt-1 text-slate-700 dark:text-slate-300">
                    {o.suggestedCoordination}
                  </p>
                </li>
              ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function checkTone(status: string, conclusion: string | null): 'green' | 'red' | 'amber' | 'gray' {
  const c = (conclusion ?? status).toLowerCase();
  if (['success', 'pass', 'neutral', 'skipped'].includes(c)) return 'green';
  if (
    [
      'failure',
      'fail',
      'timed_out',
      'cancelled',
      'action_required',
      'error',
      'startup_failure',
    ].includes(c)
  )
    return 'red';
  if (['pending', 'queued', 'in_progress', 'waiting', 'requested'].includes(c)) return 'amber';
  return 'gray';
}

function TestsDeployTab({
  detail,
  report,
  ctx,
}: {
  detail: PullRequestDetail;
  report: PrReport;
  ctx: LinkContext;
}) {
  const t = report.testing;
  const d = report.deployment;
  const pr = detail.pullRequest;
  const fileLink = (path: string) =>
    githubFileUrl({ webUrl: ctx.webUrl, repo: detail.repository.fullName, ref: pr.headSha, path });
  return (
    <div className="space-y-8">
      <Section title="Tests">
        <PlainText text={t.ciSummary} className="text-sm" />
        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <div className="text-sm font-medium">Tests added</div>
            {t.testsAdded.length ? (
              <ul className="mt-1 space-y-1 text-xs">
                {t.testsAdded.map((p) => (
                  <li key={p}>
                    <ExternalA href={fileLink(p)} className="font-mono break-all">
                      {p}
                    </ExternalA>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">None</p>
            )}
          </div>
          <div>
            <div className="text-sm font-medium">Tests changed</div>
            <List items={t.testsModified} mono />
          </div>
          <div>
            <div className="text-sm font-medium">Possibly missing tests</div>
            <List items={t.missingTests} empty="Nothing obvious" />
          </div>
        </div>
      </Section>

      <Section title="Checks & reviews">
        {report.mergeReadiness.checks.length > 0 && (
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 text-sm dark:divide-slate-700 dark:border-slate-700">
            {report.mergeReadiness.checks.map((c) => (
              <li key={c.name} className="flex flex-wrap items-center justify-between gap-2 p-2.5">
                <span className="font-medium">{c.name}</span>
                <span className="flex items-center gap-2 text-slate-600 dark:text-slate-400">
                  {c.detail}
                  <Badge tone={checkTone(c.status, null)}>{c.status}</Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
        {detail.checks.length > 0 && (
          <Collapsible title={`CI checks from GitHub (${detail.checks.length})`}>
            <ul className="space-y-1.5 text-sm">
              {detail.checks.map((c) => (
                <li
                  key={`${c.name}-${c.id ?? ''}`}
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  {c.url ? <ExternalA href={c.url}>{c.name}</ExternalA> : <span>{c.name}</span>}
                  <Badge tone={checkTone(c.status, c.conclusion)}>{c.conclusion ?? c.status}</Badge>
                </li>
              ))}
            </ul>
          </Collapsible>
        )}
        {detail.reviews.length > 0 && (
          <Collapsible title={`Reviews (${detail.reviews.length})`}>
            <ul className="space-y-1.5 text-sm">
              {detail.reviews.map((r, i) => (
                <li
                  key={`${r.reviewerLogin}-${i}`}
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  <span>{r.reviewerLogin}</span>
                  <span className="text-xs text-slate-600 dark:text-slate-400">
                    {r.state.toLowerCase().replace(/_/g, ' ')} · {timeAgo(r.submittedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </Collapsible>
        )}
      </Section>

      <Section title="Deployment">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <div className="text-sm font-medium">Database migrations</div>
            <List items={d.migrations} mono />
          </div>
          <div>
            <div className="text-sm font-medium">Environment variable changes</div>
            <List items={d.envChanges} mono />
          </div>
          <div>
            <div className="text-sm font-medium">Configuration changes</div>
            <List items={d.configChanges} mono />
          </div>
          <div>
            <div className="text-sm font-medium">Release order</div>
            <List items={d.ordering} empty="No special ordering needed" />
          </div>
        </div>
        {d.notes && <PlainText text={d.notes} className="text-sm" />}
      </Section>

      <Section title="Rollback">
        <div className="flex items-center gap-2 text-sm">
          Difficulty:
          <Badge
            tone={
              report.rollback.difficulty === 'easy'
                ? 'green'
                : report.rollback.difficulty === 'moderate'
                  ? 'amber'
                  : 'red'
            }
          >
            {report.rollback.difficulty}
          </Badge>
        </div>
        <PlainText text={report.rollback.notes} className="text-sm" />
      </Section>
    </div>
  );
}

function HistoryItem({ item, isLatest }: { item: AnalysisHistoryItem; isLatest: boolean }) {
  const [open, setOpen] = useState(isLatest);
  const findings = item.findings ?? [];
  const counts: Record<FindingLifecycle, number> = {
    new: item.findingCounts?.new ?? findings.filter((f) => f.lifecycle === 'new').length,
    unchanged:
      item.findingCounts?.unchanged ?? findings.filter((f) => f.lifecycle === 'unchanged').length,
    resolved:
      item.findingCounts?.resolved ?? findings.filter((f) => f.lifecycle === 'resolved').length,
  };
  const kindLabel = {
    full: 'Full analysis',
    incremental: 'Incremental update',
    readiness_only: 'Readiness re-check',
  }[item.kind];
  return (
    <li className="relative pl-6">
      <span
        className={clsx(
          'absolute top-1.5 left-0 size-3 rounded-full ring-4 ring-white dark:ring-slate-950',
          isLatest ? 'bg-indigo-600' : 'bg-slate-300 dark:bg-slate-600',
        )}
        aria-hidden
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{kindLabel}</span>
        <span className="font-mono text-xs text-slate-600 dark:text-slate-400">
          {shortSha(item.headSha)}
        </span>
        <AnalysisStatusBadge status={item.status} />
        {item.overallRisk && <RiskBadge level={item.overallRisk} />}
        {item.recommendation && <RecommendationBadge value={item.recommendation} />}
        {item.generatedBy && (
          <Badge tone={item.generatedBy === 'ai' ? 'indigo' : 'gray'}>
            {item.generatedBy === 'ai' ? 'AI-assisted' : 'Automated only'}
          </Badge>
        )}
        {isLatest && <Badge tone="blue">Latest</Badge>}
      </div>
      <div className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
        {formatDateTime(item.completedAt ?? item.startedAt ?? item.createdAt)}
      </div>
      <div className="mt-1 flex flex-wrap gap-3 text-sm">
        <span>
          <span className="font-medium text-red-700 dark:text-red-400">{counts.new}</span> new
        </span>
        <span>
          <span className="font-medium">{counts.unchanged}</span> unchanged
        </span>
        <span>
          <span className="font-medium text-emerald-700 dark:text-emerald-400">
            {counts.resolved}
          </span>{' '}
          resolved
        </span>
      </div>
      {item.error && <p className="mt-1 text-sm text-red-700 dark:text-red-400">{item.error}</p>}
      {findings.length > 0 && (
        <>
          <button
            type="button"
            className="mt-1 text-sm font-medium text-indigo-700 hover:underline dark:text-indigo-300"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? 'Hide findings' : 'Show findings'}
          </button>
          {open && (
            <ul className="mt-2 space-y-1.5">
              {(['new', 'unchanged', 'resolved'] as const).flatMap((lc) =>
                findings
                  .filter((f) => f.lifecycle === lc)
                  .map((f) => (
                    <li
                      key={`${lc}-${f.fingerprint}`}
                      className="flex flex-wrap items-center gap-1.5 text-sm"
                    >
                      <LifecycleBadge lifecycle={f.lifecycle} />
                      <SeverityBadge severity={f.severity} />
                      <span
                        className={clsx(
                          'break-words',
                          f.lifecycle === 'resolved' && 'text-slate-500 line-through',
                        )}
                      >
                        {f.title}
                      </span>
                      <span className="text-xs text-slate-500">{CATEGORY_LABEL[f.category]}</span>
                    </li>
                  )),
              )}
            </ul>
          )}
        </>
      )}
    </li>
  );
}

function HistoryTab({ prId }: { prId: string }) {
  const analyses = useAnalyses(prId);
  if (analyses.isPending) return <LoadingBlock />;
  if (analyses.isError)
    return <ErrorState error={analyses.error} onRetry={() => void analyses.refetch()} />;
  const items = [...analyses.data].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
  if (!items.length)
    return (
      <EmptyState title="No analyses yet">
        The first analysis runs shortly after the pull request is synced.
      </EmptyState>
    );
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Each push is re-analyzed. Findings are compared with the previous analysis: new, unchanged
        or resolved.
      </p>
      <ol className="space-y-5 border-l border-slate-200 pl-0 dark:border-slate-700 [&>li]:-ml-1.5">
        {items.map((a, i) => (
          <HistoryItem key={a.id} item={a} isLatest={i === 0} />
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function PullRequestPage() {
  const { id } = useParams();
  const [awaitRun, setAwaitRun] = useState<AwaitRun | null>(null);
  const detail = usePullRequest(id, { awaitRun });
  const github = useGithubStatus();
  const isAdmin = useIsAdmin();
  const reanalyze = useReanalyze();
  const requestReanalysis = (prId: string) => {
    setAwaitRun({ previousKey: runKey(currentRunOf(detail.data)), requestedAt: Date.now() });
    reanalyze.mutate(prId);
  };
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'summary';

  const lifecycles = useMemo(
    () => new Map((detail.data?.findings ?? []).map((f) => [f.fingerprint, f.lifecycle])),
    [detail.data?.findings],
  );

  if (detail.isPending) return <LoadingBlock />;
  if (detail.isError)
    return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;

  const d = detail.data;
  const pr = d.pullRequest;
  const analysis = d.analysis;
  const report = analysis?.report ?? null;
  // The newest run may be newer than the report shown (queued, running or failed).
  const run = currentRunOf(d);
  const runInFlight = run?.status === 'queued' || run?.status === 'running';
  const reportIsStale = Boolean(report && analysis && analysis.headSha !== pr.headSha);
  // Line numbers refer to the analysed commit, which may be older than the PR head.
  const ctx: LinkContext = {
    webUrl: github.data?.webUrl,
    ref: analysis?.headSha ?? pr.headSha,
    baseRef: analysis?.baseSha ?? pr.baseSha ?? undefined,
  };
  const aiOffForRepo = d.repository.aiMode === 'off';

  const tabs = [
    { id: 'summary', label: 'Summary' },
    { id: 'risk', label: 'Risk' },
    {
      id: 'breaking',
      label: 'Breaking changes',
      count: report ? report.breakingChanges.length + report.integrationImpact.length : undefined,
    },
    { id: 'security', label: 'Security', count: report?.security.length },
    {
      id: 'related',
      label: 'Related PRs',
      count: d.relationships.filter((r) => r.active !== false).length,
    },
    { id: 'tests', label: 'Tests & deploy' },
    { id: 'history', label: 'History' },
  ];

  return (
    <div>
      <PageHeader
        breadcrumb={
          <Link to={`/repositories/${d.repository.id}`} className="break-all hover:underline">
            {d.repository.fullName}
          </Link>
        }
        title={pr.title}
        description={
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <ExternalA href={pr.htmlUrl}>#{pr.number} on GitHub</ExternalA>
              <span aria-hidden>·</span>
              <span>by {pr.authorLogin ?? 'unknown'}</span>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1 font-mono text-xs break-all">
                <GitBranch className="size-3.5" aria-hidden />
                {pr.headRef} → {pr.baseRef}
              </span>
              <span aria-hidden>·</span>
              <span className="text-xs">
                <span className="text-emerald-700 dark:text-emerald-400">+{pr.additions}</span>{' '}
                <span className="text-red-700 dark:text-red-400">−{pr.deletions}</span> in{' '}
                {pr.changedFiles} files
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <PrStateBadge state={pr.state} draft={pr.draft} />
              <RiskBadge level={analysis?.overallRisk ?? report?.overallRisk} />
              <RecommendationBadge
                value={analysis?.recommendation ?? report?.mergeReadiness.recommendation}
              />
              <AnalysisStatusBadge status={run?.status === 'completed' ? null : run?.status} />
              {report && (
                <Badge
                  tone={report.generatedBy === 'ai' ? 'indigo' : 'gray'}
                  title={
                    report.generatedBy === 'ai'
                      ? 'Narrative written with AI; facts verified by automated analysis.'
                      : 'Produced from automated analysis only.'
                  }
                >
                  {report.generatedBy === 'ai' ? 'AI-assisted report' : 'Automated analysis only'}
                </Badge>
              )}
              {pr.labels.map((l) => (
                <Badge key={l} tone="gray">
                  {l}
                </Badge>
              ))}
            </div>
          </div>
        }
        actions={
          isAdmin &&
          pr.state === 'open' && (
            <Button
              variant="secondary"
              onClick={() => requestReanalysis(pr.id)}
              loading={reanalyze.isPending}
              icon={<RefreshCw className="size-4" aria-hidden />}
            >
              Re-analyze
            </Button>
          )
        }
      />

      <div className="mb-4 space-y-3">
        {reanalyze.isSuccess && (
          <Alert tone="success">Re-analysis queued. This page refreshes automatically.</Alert>
        )}
        {reanalyze.isError && <Alert tone="danger">{errorMessage(reanalyze.error)}</Alert>}
        {d.ai?.enabled && d.ai.budgetExhausted && (
          <AiBudgetBanner status={d.ai} isAdmin={isAdmin} />
        )}
        {aiOffForRepo ? (
          <AiDisabledBanner
            isAdmin={isAdmin}
            reason="AI is turned off for this repository. This report comes from automated analysis of the code and GitHub data only."
          />
        ) : d.ai && !d.ai.enabled ? (
          <AiDisabledBanner isAdmin={isAdmin} />
        ) : null}
        {run?.status === 'failed' && (
          <Alert tone="danger" title="The latest analysis failed">
            {run.error ?? 'An unknown error occurred.'}{' '}
            {report ? 'Showing the most recent available report.' : ''}
          </Alert>
        )}
        {report && runInFlight && (
          <Alert tone="info" title="A new analysis is in progress">
            This page refreshes automatically when it finishes.
          </Alert>
        )}
        {reportIsStale && !runInFlight && (
          <Alert tone="warning" title="This report is for an older commit">
            It was produced for commit {shortSha(analysis?.headSha)}; the pull request is now at{' '}
            {shortSha(pr.headSha)}, which has not been analyzed yet.
          </Alert>
        )}
        {report && report.limitations.length > 0 && (
          <Alert tone="info" title="Limitations of this report">
            <ul className="list-disc pl-5">
              {report.limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </Alert>
        )}
      </div>

      {!report ? (
        <>
          <EmptyState
            icon={<ShieldCheck />}
            title={runInFlight ? 'Analysis in progress' : 'No report yet'}
            action={
              isAdmin && !analysis && pr.state === 'open' ? (
                <Button onClick={() => requestReanalysis(pr.id)} loading={reanalyze.isPending}>
                  Analyze now
                </Button>
              ) : undefined
            }
          >
            {runInFlight
              ? 'The report will appear here automatically in a minute or two.'
              : 'This pull request has not been analyzed yet. It will be analyzed after the next sync.'}
          </EmptyState>
          <div className="mt-6">
            <Tabs
              tabs={[{ id: 'history', label: 'History' }]}
              active="history"
              onChange={() => undefined}
              label="Pull request report"
            />
            <TabPanel id="history">
              <HistoryTab prId={pr.id} />
            </TabPanel>
          </div>
        </>
      ) : (
        <>
          <Tabs
            tabs={tabs}
            active={tab}
            label="Pull request report"
            onChange={(t) => setParams({ tab: t }, { replace: true })}
          />
          <TabPanel id={tab}>
            {tab === 'summary' && <SummaryTab detail={d} report={report} />}
            {tab === 'risk' && <RiskTab detail={d} report={report} ctx={ctx} />}
            {tab === 'breaking' && (
              <BreakingTab report={report} ctx={ctx} lifecycles={lifecycles} />
            )}
            {tab === 'security' && (
              <SecurityTab report={report} ctx={ctx} lifecycles={lifecycles} />
            )}
            {tab === 'related' && <RelatedTab detail={d} report={report} />}
            {tab === 'tests' && <TestsDeployTab detail={d} report={report} ctx={ctx} />}
            {tab === 'history' && <HistoryTab prId={pr.id} />}
          </TabPanel>
          <p className="mt-8 text-xs text-slate-500 dark:text-slate-400">
            Analyzed {timeAgo(analysis?.completedAt)} at commit {shortSha(analysis?.headSha)}.
            git-merge-pilot only reads from GitHub; it never comments, approves or merges.
          </p>
        </>
      )}
    </div>
  );
}
