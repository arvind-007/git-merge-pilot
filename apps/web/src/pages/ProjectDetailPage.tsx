import { Pause, Play, Plus, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { errorMessage } from '../api/client.ts';
import {
  useDeleteProject,
  useIsAdmin,
  useProject,
  useProjectMember,
  useProjectOverview,
  useProjectRepository,
  usePullRequests,
  useRepositories,
  useSetProjectPaused,
  useUpdateProject,
  useUsers,
} from '../api/hooks.ts';
import {
  PR_STATES,
  RISK_LEVELS,
  type PrListFilters,
  type ProjectDetail,
  type ProjectSettings,
  type RelationshipItem,
} from '../api/types.ts';
import { AiModeBadge, ConfidenceBadge } from '../components/badges.tsx';
import { PrTable, RiskCountsBar } from '../components/PrTable.tsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  ConfirmButton,
  EmptyState,
  ErrorState,
  Field,
  InlineResult,
  Input,
  LoadingBlock,
  PageHeader,
  Select,
  TabPanel,
  Tabs,
  Textarea,
} from '../components/ui.tsx';
import { RELATIONSHIP_LABEL } from '../lib/format.ts';

export function PrFilters({
  value,
  onChange,
}: {
  value: PrListFilters;
  onChange: (f: PrListFilters) => void;
}) {
  return (
    <div className="mb-4 grid gap-3 sm:grid-cols-3">
      <Field label="State">
        <Select
          value={value.state ?? 'open'}
          onChange={(e) => onChange({ ...value, state: e.target.value as PrListFilters['state'] })}
        >
          {PR_STATES.map((s) => (
            <option key={s} value={s}>
              {s[0]!.toUpperCase() + s.slice(1)}
            </option>
          ))}
          <option value="">All</option>
        </Select>
      </Field>
      <Field label="Risk">
        <Select
          value={value.risk ?? ''}
          onChange={(e) => onChange({ ...value, risk: e.target.value as PrListFilters['risk'] })}
        >
          <option value="">Any risk</option>
          {RISK_LEVELS.map((r) => (
            <option key={r} value={r}>
              {r[0]!.toUpperCase() + r.slice(1)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Author">
        <Input
          value={value.author ?? ''}
          onChange={(e) => onChange({ ...value, author: e.target.value })}
          placeholder="GitHub username"
        />
      </Field>
    </div>
  );
}

export function RelationshipsList({ items }: { items: RelationshipItem[] }) {
  if (!items.length)
    return (
      <p className="text-sm text-slate-600 dark:text-slate-400">
        No overlapping work detected between open pull requests.
      </p>
    );
  return (
    <ul className="space-y-3">
      {items.map((r) => (
        <li
          key={r.id}
          className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <ConfidenceBadge confidence={r.confidence} />
            <Badge>{RELATIONSHIP_LABEL[r.type]}</Badge>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-2 font-medium">
            <Link
              to={`/pull-requests/${r.prA.id}`}
              className="break-all text-indigo-700 hover:underline dark:text-indigo-300"
            >
              {r.prA.repositoryFullName}#{r.prA.number}
            </Link>
            <span aria-hidden>↔</span>
            <span className="sr-only">and</span>
            <Link
              to={`/pull-requests/${r.prB.id}`}
              className="break-all text-indigo-700 hover:underline dark:text-indigo-300"
            >
              {r.prB.repositoryFullName}#{r.prB.number}
            </Link>
          </div>
          <p className="mt-1 text-slate-700 dark:text-slate-300">{r.summary}</p>
        </li>
      ))}
    </ul>
  );
}

function ReposTab({ project, isAdmin }: { project: ProjectDetail; isAdmin: boolean }) {
  const all = useRepositories();
  const mut = useProjectRepository();
  const [toAdd, setToAdd] = useState('');
  const inProject = new Set(project.repositories.map((r) => r.id));
  const available = (all.data ?? []).filter((r) => !inProject.has(r.id) && !r.archived);
  return (
    <div className="space-y-4">
      {project.repositories.length === 0 ? (
        <EmptyState title="No repositories in this project">
          Add repositories so their pull requests are analyzed and reported here.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
          {project.repositories.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <div className="min-w-0">
                <Link
                  to={`/repositories/${r.id}`}
                  className="font-medium break-all text-slate-900 hover:underline dark:text-slate-100"
                >
                  {r.fullName}
                </Link>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <AiModeBadge mode={r.aiMode} />
                  {!r.monitoringEnabled && <Badge tone="amber">Not monitored</Badge>}
                </div>
              </div>
              {isAdmin && (
                <ConfirmButton
                  title={`Remove ${r.fullName}?`}
                  message="Its pull requests will no longer appear in this project. The repository stays connected and keeps its history."
                  confirmLabel="Remove"
                  onConfirm={() =>
                    mut
                      .mutateAsync({ projectId: project.id, repositoryId: r.id, remove: true })
                      .catch(() => undefined)
                  }
                  icon={<Trash2 className="size-4" aria-hidden />}
                >
                  Remove
                </ConfirmButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {isAdmin && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (toAdd)
              mut.mutate(
                { projectId: project.id, repositoryId: toAdd },
                { onSuccess: () => setToAdd('') },
              );
          }}
        >
          <Field label="Add repository" className="min-w-0 flex-1">
            <Select value={toAdd} onChange={(e) => setToAdd(e.target.value)}>
              <option value="">
                {available.length
                  ? 'Choose a repository…'
                  : 'All repositories are already in this project'}
              </option>
              {available.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.fullName}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            type="submit"
            disabled={!toAdd}
            loading={mut.isPending}
            icon={<Plus className="size-4" aria-hidden />}
          >
            Add
          </Button>
        </form>
      )}
      {mut.isError && <Alert tone="danger">{errorMessage(mut.error)}</Alert>}
    </div>
  );
}

function MembersTab({ project, isAdmin }: { project: ProjectDetail; isAdmin: boolean }) {
  const users = useUsers(isAdmin);
  const mut = useProjectMember();
  const [toAdd, setToAdd] = useState('');
  const memberIds = new Set(project.members.map((m) => m.userId));
  const candidates = (users.data?.users ?? []).filter(
    (u) => !memberIds.has(u.id) && !u.disabled && u.role === 'member',
  );
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Members see this project’s repositories and pull requests. Admins can always see every
        project.
      </p>
      {project.members.length === 0 ? (
        <EmptyState title="No members yet">
          Add teammates with the member role so they can follow this project.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
          {project.members.map((m) => (
            <li
              key={m.userId}
              className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"
            >
              <div className="min-w-0">
                <div className="font-medium">{m.name}</div>
                <div className="text-xs break-all text-slate-600 dark:text-slate-400">
                  {m.email}
                </div>
              </div>
              {isAdmin && (
                <ConfirmButton
                  title={`Remove ${m.name}?`}
                  message="They will no longer see this project."
                  confirmLabel="Remove"
                  onConfirm={() =>
                    mut
                      .mutateAsync({ projectId: project.id, userId: m.userId, remove: true })
                      .catch(() => undefined)
                  }
                >
                  Remove
                </ConfirmButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {isAdmin && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (toAdd)
              mut.mutate(
                { projectId: project.id, userId: toAdd },
                { onSuccess: () => setToAdd('') },
              );
          }}
        >
          <Field
            label="Add member"
            className="min-w-0 flex-1"
            hint={!candidates.length ? 'Invite people from Settings → Users first.' : undefined}
          >
            <Select value={toAdd} onChange={(e) => setToAdd(e.target.value)}>
              <option value="">Choose a person…</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </option>
              ))}
            </Select>
          </Field>
          <Button
            type="submit"
            disabled={!toAdd}
            loading={mut.isPending}
            icon={<UserPlus className="size-4" aria-hidden />}
          >
            Add
          </Button>
        </form>
      )}
      {mut.isError && <Alert tone="danger">{errorMessage(mut.error)}</Alert>}
    </div>
  );
}

function SettingsTab({ project }: { project: ProjectDetail }) {
  const update = useUpdateProject();
  const del = useDeleteProject();
  const navigate = useNavigate();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [depth, setDepth] = useState<NonNullable<ProjectSettings['analysisDepth']>>(
    project.settings?.analysisDepth ?? 'standard',
  );
  const [high, setHigh] = useState(String(project.settings?.riskThresholds?.high ?? 60));
  const [critical, setCritical] = useState(
    String(project.settings?.riskThresholds?.critical ?? 80),
  );
  const [medium, setMedium] = useState(String(project.settings?.riskThresholds?.medium ?? 30));
  useEffect(() => {
    setName(project.name);
    setDescription(project.description ?? '');
  }, [project.name, project.description]);

  const nums = [Number(medium), Number(high), Number(critical)];
  const thresholdsValid =
    nums.every((n) => Number.isFinite(n) && n >= 0 && n <= 100) &&
    nums[0]! < nums[1]! &&
    nums[1]! < nums[2]!;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!thresholdsValid) return;
    update.mutate({
      id: project.id,
      patch: {
        name: name.trim(),
        description: description.trim() || null,
        settings: {
          ...project.settings,
          analysisDepth: depth,
          riskThresholds: { medium: nums[0]!, high: nums[1]!, critical: nums[2]! },
        },
      },
    });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field
            label="Analysis depth"
            hint="Deep uses the larger AI model for high-risk and cross-PR analysis."
          >
            <Select value={depth} onChange={(e) => setDepth(e.target.value as 'standard' | 'deep')}>
              <option value="standard">Standard</option>
              <option value="deep">Deep</option>
            </Select>
          </Field>
        </div>
        <Field label="Description" optional>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </Field>
        <fieldset>
          <legend className="text-sm font-medium">Risk thresholds (score 0–100)</legend>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            A dimension at or above a threshold gets that level. Defaults: medium 30, high 60,
            critical 80.
          </p>
          <div className="mt-2 grid grid-cols-3 gap-3">
            <Field label="Medium">
              <Input
                type="number"
                min={0}
                max={100}
                value={medium}
                onChange={(e) => setMedium(e.target.value)}
              />
            </Field>
            <Field label="High">
              <Input
                type="number"
                min={0}
                max={100}
                value={high}
                onChange={(e) => setHigh(e.target.value)}
              />
            </Field>
            <Field label="Critical">
              <Input
                type="number"
                min={0}
                max={100}
                value={critical}
                onChange={(e) => setCritical(e.target.value)}
              />
            </Field>
          </div>
          {!thresholdsValid && (
            <p className="mt-1 text-xs text-red-700 dark:text-red-400">
              Thresholds must be between 0 and 100 and increase from medium to critical.
            </p>
          )}
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            loading={update.isPending}
            disabled={!name.trim() || !thresholdsValid}
          >
            Save settings
          </Button>
          {update.isSuccess && <InlineResult ok>Saved</InlineResult>}
          {update.isError && <InlineResult ok={false}>{errorMessage(update.error)}</InlineResult>}
        </div>
      </form>
      <div className="rounded-lg border border-red-200 p-4 dark:border-red-900">
        <h3 className="font-semibold text-red-800 dark:text-red-300">Delete project</h3>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Repositories stay connected and keep their history. Project rules and memberships are
          removed.
        </p>
        <div className="mt-3">
          <ConfirmButton
            variant="danger"
            title={`Delete ${project.name}?`}
            message="This cannot be undone."
            confirmLabel="Delete project"
            onConfirm={() =>
              del
                .mutateAsync(project.id)
                .then(() => navigate('/projects'))
                .catch(() => undefined)
            }
            loading={del.isPending}
          >
            Delete project
          </ConfirmButton>
        </div>
        {del.isError && (
          <Alert tone="danger" className="mt-3">
            {errorMessage(del.error)}
          </Alert>
        )}
      </div>
    </div>
  );
}

export function ProjectDetailPage() {
  const { id } = useParams();
  const project = useProject(id);
  const overview = useProjectOverview(id);
  const isAdmin = useIsAdmin();
  const pause = useSetProjectPaused();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'prs';
  const [filters, setFilters] = useState<PrListFilters>({ state: 'open', risk: '', author: '' });
  const prFilters = useMemo(() => ({ ...filters, projectId: id ?? '' }), [filters, id]);
  const prs = usePullRequests(prFilters, { enabled: Boolean(id) });

  if (project.isPending) return <LoadingBlock />;
  if (project.isError)
    return <ErrorState error={project.error} onRetry={() => void project.refetch()} />;
  const p = project.data;

  const tabs = [
    { id: 'prs', label: 'Pull requests', count: prs.data?.length },
    { id: 'overlaps', label: 'Overlapping work', count: overview.data?.relationships?.length },
    { id: 'repos', label: 'Repositories', count: p.repositories.length },
    { id: 'members', label: 'Members', count: p.members.length },
    ...(isAdmin ? [{ id: 'settings', label: 'Settings' }] : []),
  ];

  return (
    <div>
      <PageHeader
        breadcrumb={
          <Link to="/projects" className="hover:underline">
            Projects
          </Link>
        }
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {p.name} {p.paused && <Badge tone="amber">Paused</Badge>}
          </span>
        }
        description={p.description}
        actions={
          isAdmin && (
            <Button
              variant="secondary"
              onClick={() => pause.mutate({ id: p.id, paused: !p.paused })}
              loading={pause.isPending}
              icon={
                p.paused ? (
                  <Play className="size-4" aria-hidden />
                ) : (
                  <Pause className="size-4" aria-hidden />
                )
              }
            >
              {p.paused ? 'Resume monitoring' : 'Pause monitoring'}
            </Button>
          )
        }
      />
      {p.paused && (
        <Alert tone="warning" className="mb-4">
          Monitoring is paused: new pull request activity in this project is not analyzed until you
          resume.
        </Alert>
      )}
      {pause.isError && (
        <Alert tone="danger" className="mb-4">
          {errorMessage(pause.error)}
        </Alert>
      )}

      <Card className="mb-6">
        <CardTitle>Risk across open pull requests</CardTitle>
        <RiskCountsBar counts={overview.data?.riskCounts ?? p.riskCounts} />
      </Card>

      <Tabs
        tabs={tabs}
        active={tab}
        label="Project sections"
        onChange={(t) => setParams({ tab: t }, { replace: true })}
      />
      <TabPanel id={tab}>
        {tab === 'prs' && (
          <>
            <PrFilters value={filters} onChange={setFilters} />
            {prs.isPending ? (
              <LoadingBlock />
            ) : prs.isError ? (
              <ErrorState error={prs.error} onRetry={() => void prs.refetch()} />
            ) : (
              <PrTable
                prs={prs.data}
                empty={
                  <EmptyState title="No pull requests match">
                    {p.repositories.length
                      ? 'Try different filters, or wait for new pull request activity.'
                      : 'Add repositories to this project to see their pull requests.'}
                  </EmptyState>
                }
              />
            )}
          </>
        )}
        {tab === 'overlaps' &&
          (overview.isPending ? (
            <LoadingBlock />
          ) : (
            <RelationshipsList items={overview.data?.relationships ?? []} />
          ))}
        {tab === 'repos' && <ReposTab project={p} isAdmin={isAdmin} />}
        {tab === 'members' && <MembersTab project={p} isAdmin={isAdmin} />}
        {tab === 'settings' && isAdmin && <SettingsTab project={p} />}
      </TabPanel>
    </div>
  );
}
