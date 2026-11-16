import { Lock } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  useGithubStatus,
  useIsAdmin,
  usePullRequests,
  useRepository,
  useRepositoryOverview,
} from '../api/hooks.ts';
import type { PrListFilters, RepositoryDetail, RepositoryProfileData } from '../api/types.ts';
import { AiModeBadge } from '../components/badges.tsx';
import { PrTable, RiskCountsBar } from '../components/PrTable.tsx';
import {
  Badge,
  Card,
  CardTitle,
  EmptyState,
  ErrorState,
  ExternalA,
  LoadingBlock,
  PageHeader,
  TabPanel,
  Tabs,
} from '../components/ui.tsx';
import { ProfileEditor, RepoSettingsForm } from '../features/repos.tsx';
import { AI_MODE_HINT, timeAgo } from '../lib/format.ts';
import { DEFAULT_GITHUB_WEB_URL } from '../lib/links.ts';
import { PrFilters } from './ProjectDetailPage.tsx';

const SUMMARY_FIELDS: Array<[keyof RepositoryProfileData & string, string]> = [
  ['frameworks', 'Frameworks'],
  ['buildTools', 'Build tools'],
  ['packageManagers', 'Package managers'],
  ['testFrameworks', 'Test frameworks'],
  ['ciWorkflows', 'CI workflows'],
  ['securityTools', 'Security tools'],
];

function ProfileSummary({ repo }: { repo: RepositoryDetail }) {
  if (!repo.profile)
    return (
      <p className="text-sm text-slate-600 dark:text-slate-400">
        This repository has not been scanned yet.
      </p>
    );
  const { discovered, overrides } = repo.profile;
  const langs = Object.keys(discovered.languages ?? {});
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-2">
      {langs.length > 0 && (
        <div>
          <dt className="text-slate-600 dark:text-slate-400">Languages</dt>
          <dd>{langs.join(', ')}</dd>
        </div>
      )}
      {SUMMARY_FIELDS.map(([k, label]) => {
        const v = (
          Array.isArray(overrides[k]) && (overrides[k] as unknown[]).length
            ? overrides[k]
            : discovered[k]
        ) as unknown;
        const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
        return list.length ? (
          <div key={k}>
            <dt className="text-slate-600 dark:text-slate-400">{label}</dt>
            <dd>{list.join(', ')}</dd>
          </div>
        ) : null;
      })}
    </dl>
  );
}

export function RepositoryPage() {
  const { id } = useParams();
  const repo = useRepository(id);
  const overview = useRepositoryOverview(id);
  const github = useGithubStatus();
  const isAdmin = useIsAdmin();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'prs';
  const [filters, setFilters] = useState<PrListFilters>({ state: 'open', risk: '', author: '' });
  const prFilters = useMemo(() => ({ ...filters, repositoryId: id ?? '' }), [filters, id]);
  const prs = usePullRequests(prFilters, { enabled: Boolean(id) });

  if (repo.isPending) return <LoadingBlock />;
  if (repo.isError) return <ErrorState error={repo.error} onRetry={() => void repo.refetch()} />;
  const r = repo.data;
  const webUrl = (github.data?.webUrl ?? DEFAULT_GITHUB_WEB_URL).replace(/\/+$/, '');

  const tabs = [
    { id: 'prs', label: 'Pull requests', count: prs.data?.length },
    { id: 'profile', label: 'Profile' },
    ...(isAdmin ? [{ id: 'settings', label: 'Monitoring & AI' }] : []),
  ];

  return (
    <div>
      <PageHeader
        breadcrumb={
          r.projects?.length ? (
            <span className="flex flex-wrap gap-2">
              {r.projects.map((p) => (
                <Link key={p.id} to={`/projects/${p.id}`} className="hover:underline">
                  {p.name}
                </Link>
              ))}
            </span>
          ) : isAdmin ? (
            <Link to="/settings/repositories" className="hover:underline">
              Repositories
            </Link>
          ) : undefined
        }
        title={<span className="break-all">{r.fullName}</span>}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <ExternalA href={`${webUrl}/${r.fullName}`}>View on GitHub</ExternalA>
            <span aria-hidden>·</span>
            {r.private && <Badge icon={<Lock className="size-3" aria-hidden />}>Private</Badge>}
            <AiModeBadge mode={r.aiMode} />
            {r.monitoringEnabled ? (
              <Badge tone="green">Monitored</Badge>
            ) : (
              <Badge tone="amber">Not monitored</Badge>
            )}
            {r.archived && <Badge>Archived</Badge>}
          </span>
        }
      />

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardTitle>Open pull request risk</CardTitle>
          <RiskCountsBar counts={overview.data?.riskCounts} />
        </Card>
        <Card>
          <CardTitle>AI data</CardTitle>
          <p className="text-sm text-slate-700 dark:text-slate-300">{AI_MODE_HINT[r.aiMode]}</p>
          {r.excludePaths.length > 0 && (
            <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
              {r.excludePaths.length} excluded path patterns.
            </p>
          )}
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            Last checked {timeAgo(r.lastPolledAt)}.
          </p>
        </Card>
      </div>

      <Tabs
        tabs={tabs}
        active={tab}
        label="Repository sections"
        onChange={(t) => setParams({ tab: t }, { replace: true })}
      />
      <TabPanel id={tab}>
        {tab === 'prs' && (
          <>
            <PrFilters value={filters} onChange={setFilters} />
            {prs.isPending ? (
              <LoadingBlock />
            ) : prs.isError ? (
              <ErrorState error={prs.error} />
            ) : (
              <PrTable
                prs={prs.data}
                showRepo={false}
                empty={
                  <EmptyState title="No pull requests match">
                    {r.monitoringEnabled
                      ? 'Pull requests appear when they are opened or updated.'
                      : 'Monitoring is off for this repository. Turn it on to analyze its pull requests.'}
                  </EmptyState>
                }
              />
            )}
          </>
        )}
        {tab === 'profile' && (isAdmin ? <ProfileEditor repo={r} /> : <ProfileSummary repo={r} />)}
        {tab === 'settings' && isAdmin && <RepoSettingsForm repo={r} />}
      </TabPanel>
    </div>
  );
}
