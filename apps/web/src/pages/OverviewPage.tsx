import { FolderKanban, GitPullRequest } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useIsAdmin, useOverview } from '../api/hooks.ts';
import { AiStatusBanners } from '../components/banners.tsx';
import { PrTable, RiskCountsBar } from '../components/PrTable.tsx';
import {
  Alert,
  Badge,
  Card,
  CardTitle,
  EmptyState,
  ErrorState,
  LinkButton,
  LoadingBlock,
  PageHeader,
  StatCard,
} from '../components/ui.tsx';
import { RECOMMENDATION_LABEL } from '../lib/format.ts';
import { RECOMMENDATIONS } from '../api/types.ts';

export function OverviewPage() {
  const overview = useOverview();
  const isAdmin = useIsAdmin();
  if (overview.isPending) return <LoadingBlock />;
  if (overview.isError)
    return <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />;
  const o = overview.data;
  const stats = o.stats ?? {};
  const attention = o.attention ?? [];
  const recent = o.recent ?? [];
  const projects = o.projects ?? [];

  return (
    <div className="space-y-6">
      <PageHeader title="Overview" description="What needs your attention across all projects." />

      {o.ai && !o.ai.enabled && <AiStatusBanners ai={o.ai} isAdmin={isAdmin} />}
      {o.github && !o.github.connected && (
        <Alert
          tone="warning"
          title="GitHub is not connected"
          action={
            isAdmin ? (
              <Link to="/settings/github" className="text-sm font-medium underline">
                Connect
              </Link>
            ) : undefined
          }
        >
          No new pull request activity will arrive until a GitHub App is connected.
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Open pull requests" value={stats.openPrs ?? 0} />
        <StatCard
          label="High or critical risk"
          value={stats.highRiskPrs ?? 0}
          tone={(stats.highRiskPrs ?? 0) > 0 ? 'danger' : 'default'}
        />
        <StatCard
          label="Need attention"
          value={stats.needsAttention ?? attention.length}
          tone={(stats.needsAttention ?? attention.length) > 0 ? 'warning' : 'default'}
          hint="Escalate, changes required or clarification"
        />
        <StatCard
          label="Monitored repositories"
          value={stats.monitoredRepositories ?? 0}
          hint={`${stats.projects ?? projects.length} projects`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle description="Open pull requests by overall risk.">
            Risk across open pull requests
          </CardTitle>
          <RiskCountsBar counts={o.riskCounts} />
        </Card>
        <Card>
          <CardTitle>Merge recommendations</CardTitle>
          <ul className="space-y-1.5 text-sm">
            {RECOMMENDATIONS.map((r) => (
              <li key={r} className="flex items-center justify-between">
                <span className="text-slate-700 dark:text-slate-300">
                  {RECOMMENDATION_LABEL[r]}
                </span>
                <span className="font-medium tabular-nums">{o.recommendationCounts?.[r] ?? 0}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card>
        <CardTitle
          description="Pull requests that should be escalated, need changes or need clarification."
          actions={
            <LinkButton to="/risk" size="sm">
              Risk center
            </LinkButton>
          }
        >
          Needs attention
        </CardTitle>
        <PrTable
          prs={attention}
          empty={
            <EmptyState icon={<GitPullRequest />} title="Nothing needs attention right now">
              Pull requests that need escalation, changes or clarification will show up here.
            </EmptyState>
          }
        />
      </Card>

      <Card>
        <CardTitle description="Most recently updated pull requests.">Recent activity</CardTitle>
        <PrTable
          prs={recent}
          empty={
            <EmptyState icon={<GitPullRequest />} title="No pull request activity yet">
              {stats.monitoredRepositories
                ? 'Reports appear here after the next pull request is opened or updated in a monitored repository.'
                : 'Choose repositories to monitor and add them to a project to start receiving reports.'}
            </EmptyState>
          }
        />
      </Card>

      <Card>
        <CardTitle
          actions={
            <LinkButton to="/projects" size="sm">
              All projects
            </LinkButton>
          }
        >
          Projects
        </CardTitle>
        {projects.length ? (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  to={`/projects/${p.id}`}
                  className="block rounded-lg border border-slate-200 p-3 hover:border-indigo-400 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:border-slate-700"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium break-words">{p.name}</span>
                    {p.paused && <Badge tone="amber">Paused</Badge>}
                  </div>
                  <div className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                    {p.openPrCount ?? 0} open PRs · {p.repositoryCount ?? 0} repositories
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<FolderKanban />}
            title="No projects yet"
            action={
              isAdmin ? (
                <LinkButton to="/projects" variant="primary">
                  Create a project
                </LinkButton>
              ) : undefined
            }
          >
            Projects group the repositories that make up a product or team.
          </EmptyState>
        )}
      </Card>
    </div>
  );
}
