import { Search, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useDevelopers } from '../api/hooks.ts';
import {
  EmptyState,
  ErrorState,
  Input,
  LoadingBlock,
  PageHeader,
  Table,
  td,
  th,
} from '../components/ui.tsx';
import { timeAgo } from '../lib/format.ts';

export function DevelopersPage() {
  const devs = useDevelopers();
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (devs.data ?? [])
      .filter((d) => !needle || d.login.toLowerCase().includes(needle))
      .sort((a, b) => b.highRiskPrs - a.highRiskPrs || b.openPrs - a.openPrs);
  }, [devs.data, q]);

  return (
    <div>
      <PageHeader
        title="Developers"
        description="Who has open work, and where the riskiest changes are. Based on GitHub authors of pull requests in your projects."
      />
      {devs.isPending ? (
        <LoadingBlock />
      ) : devs.isError ? (
        <ErrorState error={devs.error} onRetry={() => void devs.refetch()} />
      ) : !devs.data.length ? (
        <EmptyState icon={<Users />} title="No developer activity yet">
          Authors appear here once pull requests in monitored repositories are analyzed.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          <div className="relative max-w-sm">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400"
              aria-hidden
            />
            <Input
              type="search"
              aria-label="Search developers"
              placeholder="Search by GitHub username…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-8"
            />
          </div>
          <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
            <Table label="Developers">
              <thead>
                <tr>
                  <th scope="col" className={th}>
                    Developer
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    Open PRs
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    High risk
                  </th>
                  <th scope="col" className={`${th} hidden text-right sm:table-cell`}>
                    Merged
                  </th>
                  <th scope="col" className={`${th} hidden md:table-cell`}>
                    Repositories
                  </th>
                  <th scope="col" className={`${th} hidden sm:table-cell`}>
                    Last activity
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {list.map((d) => (
                  <tr key={d.login}>
                    <th scope="row" className={`${td} text-left font-medium`}>
                      {d.login}
                    </th>
                    <td className={`${td} text-right tabular-nums`}>{d.openPrs}</td>
                    <td
                      className={`${td} text-right tabular-nums ${d.highRiskPrs > 0 ? 'font-semibold text-orange-700 dark:text-orange-400' : ''}`}
                    >
                      {d.highRiskPrs}
                    </td>
                    <td className={`${td} hidden text-right tabular-nums sm:table-cell`}>
                      {d.mergedPrs ?? '—'}
                    </td>
                    <td className={`${td} hidden max-w-xs md:table-cell`}>
                      <span className="line-clamp-2 text-xs break-all text-slate-600 dark:text-slate-400">
                        {(d.repositories ?? []).join(', ') || '—'}
                      </span>
                    </td>
                    <td
                      className={`${td} hidden whitespace-nowrap text-slate-600 sm:table-cell dark:text-slate-400`}
                    >
                      {timeAgo(d.lastActivityAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
