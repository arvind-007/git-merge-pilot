import { GitPullRequest } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { PrListItem } from '../api/types.ts';
import { timeAgo } from '../lib/format.ts';
import { AnalysisStatusBadge, PrStateBadge, RecommendationBadge, RiskBadge } from './badges.tsx';
import { EmptyState, ExternalA } from './ui.tsx';

/**
 * Responsive PR list: stacked cards on small screens, a table from `md` up.
 */
export function PrTable({
  prs,
  empty,
  showRepo = true,
}: {
  prs: PrListItem[];
  empty?: ReactNode;
  showRepo?: boolean;
}) {
  if (!prs.length) {
    return (
      <>
        {empty ?? (
          <EmptyState icon={<GitPullRequest />} title="No pull requests here yet">
            Pull requests appear automatically when they are opened or updated in a monitored
            repository.
          </EmptyState>
        )}
      </>
    );
  }
  return (
    <>
      <ul
        className="divide-y divide-slate-200 md:hidden dark:divide-slate-700"
        aria-label="Pull requests"
      >
        {prs.map((pr) => (
          <li key={pr.id} className="py-3">
            <Link
              to={`/pull-requests/${pr.id}`}
              className="block rounded focus-visible:outline-2 focus-visible:outline-indigo-500"
            >
              <div className="text-xs text-slate-600 dark:text-slate-400">
                {showRepo && <span className="break-all">{pr.repositoryFullName} </span>}#
                {pr.number}
              </div>
              <div className="mt-0.5 font-medium break-words text-slate-900 dark:text-slate-100">
                {pr.title}
              </div>
            </Link>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <RiskBadge level={pr.overallRisk} />
              <RecommendationBadge value={pr.recommendation} />
              <AnalysisStatusBadge
                status={pr.analysisStatus === 'completed' ? null : pr.analysisStatus}
              />
              {pr.state !== 'open' || pr.draft ? (
                <PrStateBadge state={pr.state} draft={pr.draft} />
              ) : null}
            </div>
            <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {pr.authorLogin ?? 'unknown'} · updated {timeAgo(pr.lastEventAt ?? pr.updatedAt)}
            </div>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto md:block">
        <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-700">
          <thead>
            <tr className="text-left text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-400">
              <th scope="col" className="px-3 py-2">
                Pull request
              </th>
              <th scope="col" className="px-3 py-2">
                Risk
              </th>
              <th scope="col" className="px-3 py-2">
                Recommendation
              </th>
              <th scope="col" className="px-3 py-2">
                Author
              </th>
              <th scope="col" className="px-3 py-2">
                Updated
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {prs.map((pr) => (
              <tr key={pr.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                <td className="max-w-md px-3 py-2.5">
                  <Link
                    to={`/pull-requests/${pr.id}`}
                    className="font-medium break-words text-slate-900 hover:text-indigo-700 hover:underline focus-visible:outline-2 focus-visible:outline-indigo-500 dark:text-slate-100 dark:hover:text-indigo-300"
                  >
                    {pr.title}
                  </Link>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
                    <ExternalA href={pr.htmlUrl} className="text-xs">
                      {showRepo ? `${pr.repositoryFullName}#${pr.number}` : `#${pr.number}`}
                    </ExternalA>
                    {pr.state !== 'open' || pr.draft ? (
                      <PrStateBadge state={pr.state} draft={pr.draft} />
                    ) : null}
                    <AnalysisStatusBadge
                      status={pr.analysisStatus === 'completed' ? null : pr.analysisStatus}
                    />
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <RiskBadge level={pr.overallRisk} />
                </td>
                <td className="px-3 py-2.5">
                  <RecommendationBadge value={pr.recommendation} />
                </td>
                <td className="px-3 py-2.5 text-slate-700 dark:text-slate-300">
                  {pr.authorLogin ?? '—'}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap text-slate-600 dark:text-slate-400">
                  {timeAgo(pr.lastEventAt ?? pr.updatedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function RiskCountsBar({
  counts,
}: {
  counts: Partial<Record<'critical' | 'high' | 'medium' | 'low', number>> | undefined;
}) {
  const levels = ['critical', 'high', 'medium', 'low'] as const;
  const total = levels.reduce((s, l) => s + (counts?.[l] ?? 0), 0);
  const colors = {
    critical: 'bg-red-500',
    high: 'bg-orange-500',
    medium: 'bg-amber-400',
    low: 'bg-emerald-500',
  };
  return (
    <div>
      <div
        className="flex h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
        role="img"
        aria-label={levels.map((l) => `${counts?.[l] ?? 0} ${l}`).join(', ')}
      >
        {total > 0 &&
          levels.map((l) =>
            counts?.[l] ? (
              <div
                key={l}
                className={colors[l]}
                style={{ width: `${((counts[l] ?? 0) / total) * 100}%` }}
              />
            ) : null,
          )}
      </div>
      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-400">
        {levels.map((l) => (
          <div key={l} className="flex items-center gap-1.5">
            <span className={`inline-block size-2 rounded-full ${colors[l]}`} aria-hidden />
            <dt className="capitalize">{l}</dt>
            <dd className="font-medium tabular-nums text-slate-800 dark:text-slate-200">
              {counts?.[l] ?? 0}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
