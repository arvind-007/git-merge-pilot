import { clsx } from 'clsx';
import { Lock, RefreshCw, UserPlus } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { errorMessage } from '../../api/client.ts';
import {
  useAiSettings,
  useAuditLog,
  useChannels,
  useInviteUser,
  useMe,
  useProjects,
  useRepositories,
  useRules,
  useSyncInstallations,
  useSystemStatus,
  useUpdateAiSettings,
  useUpdateRepository,
  useUpdateUser,
  useUsage,
  useUsers,
} from '../../api/hooks.ts';
import {
  AI_MODES,
  USER_ROLES,
  type AiMode,
  type InviteResponse,
  type Repository,
  type UsageBreakdown,
  type UserRole,
} from '../../api/types.ts';
import { AiModeBadge } from '../../components/badges.tsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  ConfirmButton,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
  PageHeader,
  Select,
  StatCard,
  Table,
  Toggle,
  td,
  th,
} from '../../components/ui.tsx';
import {
  DataFlowConsent,
  DataFlowExplainer,
  ModelsAndBudgetForm,
  ProviderManager,
} from '../../features/ai.tsx';
import { GithubConnectionCard } from '../../features/github.tsx';
import { ChannelManager, RuleEditor } from '../../features/notify.tsx';
import { NoReposHelp } from '../../features/repos.tsx';
import {
  AI_MODE_LABEL,
  formatDateTime,
  formatNumber,
  formatUsd,
  timeAgo,
} from '../../lib/format.ts';

const SECTIONS = [
  { to: 'github', label: 'GitHub' },
  { to: 'repositories', label: 'Repositories' },
  { to: 'ai', label: 'AI' },
  { to: 'notifications', label: 'Notifications' },
  { to: 'users', label: 'Users & invites' },
  { to: 'system', label: 'System status' },
  { to: 'audit', label: 'Audit log' },
];

export function SettingsLayout() {
  return (
    <div>
      <PageHeader
        title="Settings"
        description="Administration for this git-merge-pilot installation."
      />
      <div className="grid gap-6 lg:grid-cols-[12rem_1fr]">
        <nav aria-label="Settings sections" className="-mx-4 overflow-x-auto px-4 lg:mx-0 lg:px-0">
          <ul className="flex gap-1 lg:flex-col">
            {SECTIONS.map((s) => (
              <li key={s.to}>
                <NavLink
                  to={s.to}
                  className={({ isActive }) =>
                    clsx(
                      'block rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:outline-indigo-500',
                      isActive
                        ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-200'
                        : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                    )
                  }
                >
                  {s.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export function GithubSettings() {
  return <GithubConnectionCard />;
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

function RepoRow({ repo }: { repo: Repository }) {
  const update = useUpdateRepository();
  return (
    <tr>
      <td className={td}>
        <Link
          to={`/repositories/${repo.id}`}
          className="font-medium break-all text-slate-900 hover:underline dark:text-slate-100"
        >
          {repo.fullName}
        </Link>
        <div className="mt-0.5 flex flex-wrap gap-1">
          {repo.private && <Badge icon={<Lock className="size-3" aria-hidden />}>Private</Badge>}
          {repo.archived && <Badge>Archived</Badge>}
          {(repo.projects ?? []).map((p) => (
            <Badge key={p.id} tone="blue">
              {p.name}
            </Badge>
          ))}
        </div>
        {update.isError && (
          <p className="mt-1 text-xs text-red-700 dark:text-red-400">
            {errorMessage(update.error)}
          </p>
        )}
      </td>
      <td className={td}>
        <Toggle
          label={`Monitor ${repo.fullName}`}
          checked={repo.monitoringEnabled}
          disabled={update.isPending}
          onChange={(v) => update.mutate({ id: repo.id, patch: { monitoringEnabled: v } })}
        />
      </td>
      <td className={td}>
        <Select
          aria-label={`AI mode for ${repo.fullName}`}
          value={repo.aiMode}
          disabled={update.isPending}
          onChange={(e) =>
            update.mutate({ id: repo.id, patch: { aiMode: e.target.value as AiMode } })
          }
          className="min-w-36"
        >
          {AI_MODES.map((m) => (
            <option key={m} value={m}>
              {AI_MODE_LABEL[m]}
            </option>
          ))}
        </Select>
      </td>
      <td
        className={`${td} hidden whitespace-nowrap text-slate-600 md:table-cell dark:text-slate-400`}
      >
        {timeAgo(repo.lastDiscoveredAt)}
      </td>
    </tr>
  );
}

export function RepositoriesSettings() {
  const repos = useRepositories();
  const sync = useSyncInstallations();
  const [q, setQ] = useState('');
  const list = useMemo(
    () =>
      (repos.data ?? []).filter((r) => r.fullName.toLowerCase().includes(q.trim().toLowerCase())),
    [repos.data, q],
  );
  return (
    <Card>
      <CardTitle
        description="Turn monitoring on or off and choose what each repository may send to AI. Open a repository for excluded paths and profile overrides."
        actions={
          <Button
            size="sm"
            variant="secondary"
            onClick={() => sync.mutate()}
            loading={sync.isPending}
            icon={<RefreshCw className="size-4" aria-hidden />}
          >
            Refresh from GitHub
          </Button>
        }
      >
        Repositories
      </CardTitle>
      {sync.isError && (
        <Alert tone="danger" className="mb-3">
          {errorMessage(sync.error)}
        </Alert>
      )}
      {repos.isPending ? (
        <LoadingBlock />
      ) : repos.isError ? (
        <ErrorState error={repos.error} onRetry={() => void repos.refetch()} />
      ) : !repos.data.length ? (
        <NoReposHelp />
      ) : (
        <>
          <Input
            type="search"
            aria-label="Search repositories"
            placeholder="Search repositories…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="mb-3 max-w-sm"
          />
          <Table label="Repositories">
            <thead>
              <tr>
                <th scope="col" className={th}>
                  Repository
                </th>
                <th scope="col" className={th}>
                  Monitored
                </th>
                <th scope="col" className={th}>
                  AI mode
                </th>
                <th scope="col" className={`${th} hidden md:table-cell`}>
                  Last scanned
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {list.map((r) => (
                <RepoRow key={r.id} repo={r} />
              ))}
            </tbody>
          </Table>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

function BreakdownTable({ title, rows }: { title: string; rows: UsageBreakdown[] }) {
  if (!rows.length) return null;
  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold">{title}</h3>
      <Table label={title}>
        <thead>
          <tr>
            <th scope="col" className={th}>
              Name
            </th>
            <th scope="col" className={`${th} text-right`}>
              Calls
            </th>
            <th scope="col" className={`${th} text-right`}>
              Input tokens
            </th>
            <th scope="col" className={`${th} text-right`}>
              Output tokens
            </th>
            <th scope="col" className={`${th} text-right`}>
              Cost
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((r) => (
            <tr key={r.key}>
              <td className={`${td} font-mono text-xs`}>{r.key}</td>
              <td className={`${td} text-right tabular-nums`}>{formatNumber(r.calls)}</td>
              <td className={`${td} text-right tabular-nums`}>{formatNumber(r.inputTokens)}</td>
              <td className={`${td} text-right tabular-nums`}>{formatNumber(r.outputTokens)}</td>
              <td className={`${td} text-right tabular-nums`}>{formatUsd(r.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function UsageCard() {
  const usage = useUsage();
  if (usage.isPending) return <LoadingBlock />;
  if (usage.isError) return <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />;
  const b = usage.data.budget;
  const pct = Math.min(100, Math.max(0, b.pct));
  return (
    <Card>
      <CardTitle description="Spending this calendar month.">Usage & budget</CardTitle>
      {b.exhausted && (
        <Alert tone="warning" className="mb-4" title="Budget reached">
          AI calls are paused until next month or until you raise the budget. Reports continue from
          automated analysis.
        </Alert>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Spent this month"
          value={formatUsd(b.spentUsd)}
          tone={b.exhausted ? 'danger' : pct >= 80 ? 'warning' : 'default'}
        />
        <StatCard label="Monthly budget" value={formatUsd(b.capUsd)} />
        <StatCard label="Used" value={`${Math.round(b.pct)}%`} />
      </div>
      <div
        className="mt-4 h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
        role="meter"
        aria-label="Budget used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <div
          className={clsx(
            'h-full',
            b.exhausted ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-indigo-500',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-6 space-y-6">
        <BreakdownTable title="By task" rows={usage.data.byTask ?? []} />
        <BreakdownTable title="By model" rows={usage.data.byModel ?? []} />
      </div>
    </Card>
  );
}

export function AiSettingsPage() {
  const settings = useAiSettings();
  const repos = useRepositories();
  const update = useUpdateAiSettings();
  const updateRepo = useUpdateRepository();
  const [showConsent, setShowConsent] = useState(false);

  if (settings.isPending) return <LoadingBlock />;
  if (settings.isError)
    return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  const s = settings.data;

  return (
    <div className="space-y-6">
      <Card>
        <CardTitle description="AI writes plain-language summaries and suggests potential concerns. Verified facts come from automated analysis either way.">
          AI analysis
        </CardTitle>
        {s.enabled ? (
          <div className="space-y-3">
            <Alert tone="success" title="AI analysis is on">
              Consent given {s.consentAt ? formatDateTime(s.consentAt) : ''}
              {s.consentBy ? ` by ${s.consentBy}` : ''}.
            </Alert>
            <ConfirmButton
              title="Turn AI off?"
              message="New reports will use automated analysis only. Nothing will be sent to the AI provider."
              confirmLabel="Turn off"
              onConfirm={() => update.mutateAsync({ enabled: false }).catch(() => undefined)}
              loading={update.isPending}
            >
              Turn AI off
            </ConfirmButton>
            <details className="text-sm">
              <summary className="cursor-pointer font-medium">
                What is sent to the AI provider?
              </summary>
              <div className="mt-3">
                <DataFlowExplainer />
              </div>
            </details>
          </div>
        ) : showConsent ? (
          <DataFlowConsent
            repos={(repos.data ?? []).filter((r) => r.monitoringEnabled)}
            onRepoModeChange={(r, mode) => updateRepo.mutate({ id: r.id, patch: { aiMode: mode } })}
            onEnable={() =>
              update.mutate(
                { enabled: true, consent: true },
                { onSuccess: () => setShowConsent(false) },
              )
            }
            onSkip={() => setShowConsent(false)}
            enabling={update.isPending}
            error={update.isError ? errorMessage(update.error) : null}
          />
        ) : (
          <div className="space-y-3">
            <Alert tone="info" title="AI analysis is off">
              Reports use automated analysis only. Nothing is sent to an AI provider.
            </Alert>
            <Button onClick={() => setShowConsent(true)}>Review data flow & enable</Button>
          </div>
        )}
        {update.isError && !showConsent && (
          <Alert tone="danger" className="mt-3">
            {errorMessage(update.error)}
          </Alert>
        )}
      </Card>

      <Card>
        <CardTitle description="API keys are encrypted on your server and never shown again.">
          Providers
        </CardTitle>
        <ProviderManager />
      </Card>

      <Card>
        <CardTitle>Models & budget</CardTitle>
        <ModelsAndBudgetForm settings={s} />
      </Card>

      <UsageCard />

      {repos.data && repos.data.length > 0 && (
        <Card>
          <CardTitle description="Change per repository in Settings → Repositories.">
            AI mode by repository
          </CardTitle>
          <ul className="flex flex-wrap gap-2">
            {repos.data
              .filter((r) => r.monitoringEnabled)
              .map((r) => (
                <li key={r.id} className="flex items-center gap-1.5 text-sm">
                  <span className="break-all">{r.fullName}</span>
                  <AiModeBadge mode={r.aiMode} />
                </li>
              ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export function NotificationSettings() {
  const channels = useChannels();
  const rules = useRules();
  const projects = useProjects();
  const [adding, setAdding] = useState(false);
  const projectName = (id: string | null) =>
    id
      ? ((projects.data ?? []).find((p) => p.id === id)?.name ?? 'Unknown project')
      : 'All projects (organization default)';

  return (
    <div className="space-y-6">
      <Card>
        <CardTitle>Channels</CardTitle>
        <ChannelManager />
      </Card>
      <Card>
        <CardTitle
          description="Who gets told about what, quiet hours, timezone and the daily digest. Project rules override the organization default."
          actions={
            !adding && (
              <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
                Add rule
              </Button>
            )
          }
        >
          Rules
        </CardTitle>
        {rules.isPending || channels.isPending ? (
          <LoadingBlock />
        ) : rules.isError ? (
          <ErrorState error={rules.error} onRetry={() => void rules.refetch()} />
        ) : (
          <div className="space-y-6">
            {rules.data.length === 0 && !adding && (
              <EmptyState
                title="No rules yet"
                action={<Button onClick={() => setAdding(true)}>Create the default rule</Button>}
              >
                Without a rule, only in-app notifications are recorded.
              </EmptyState>
            )}
            {rules.data.map((r) => (
              <details
                key={r.id}
                className="rounded-lg border border-slate-200 p-4 dark:border-slate-700"
                open={rules.data.length === 1}
              >
                <summary className="cursor-pointer font-medium">
                  {projectName(r.projectId)}
                  <span className="ml-2 text-xs font-normal text-slate-600 dark:text-slate-400">
                    {r.minSeverity}+ · {r.channelIds.length} channels · digest{' '}
                    {r.digestEnabled
                      ? `${String(r.digestHour).padStart(2, '0')}:00 ${r.timezone ?? ''}`
                      : 'off'}
                  </span>
                </summary>
                <div className="mt-4">
                  <RuleEditor
                    rule={r}
                    channels={channels.data ?? []}
                    projects={projects.data ?? []}
                  />
                </div>
              </details>
            ))}
            {adding && (
              <div className="rounded-lg border border-indigo-200 p-4 dark:border-indigo-900">
                <h3 className="mb-3 font-semibold">New rule</h3>
                <RuleEditor
                  rule={null}
                  channels={channels.data ?? []}
                  projects={projects.data ?? []}
                  onSaved={() => setAdding(false)}
                />
                <Button variant="ghost" size="sm" className="mt-2" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Users & invites
// ---------------------------------------------------------------------------

function InviteForm() {
  const invite = useInviteUser();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('member');
  const [result, setResult] = useState<InviteResponse | null>(null);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setResult(null);
    invite.mutate(
      { email: email.trim().toLowerCase(), role },
      {
        onSuccess: (r) => {
          setResult(r);
          setEmail('');
        },
      },
    );
  };
  return (
    <div className="space-y-3">
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
        <Field label="Email" className="min-w-0 flex-1">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            {USER_ROLES.map((r) => (
              <option key={r} value={r}>
                {r === 'admin' ? 'Admin (everything)' : 'Member (assigned projects)'}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          type="submit"
          loading={invite.isPending}
          disabled={!email.includes('@')}
          icon={<UserPlus className="size-4" aria-hidden />}
        >
          Create invite
        </Button>
      </form>
      {invite.isError && <Alert tone="danger">{errorMessage(invite.error)}</Alert>}
      {result && (
        <Alert tone="success" title="Invite link created">
          <p>
            Send this one-time link to the person. It expires {formatDateTime(result.expiresAt)} and
            will not be shown again.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="max-w-full rounded bg-white/70 px-2 py-1 font-mono text-xs break-all dark:bg-slate-900">
              {result.inviteUrl}
            </code>
            <CopyButton value={result.inviteUrl} label="Copy link" />
          </div>
        </Alert>
      )}
    </div>
  );
}

export function UsersSettings() {
  const users = useUsers();
  const me = useMe();
  const update = useUpdateUser();
  return (
    <div className="space-y-6">
      <Card>
        <CardTitle description="Members only see projects they are added to. Admins see and manage everything.">
          Invite someone
        </CardTitle>
        <InviteForm />
      </Card>
      <Card>
        <CardTitle>Users</CardTitle>
        {update.isError && (
          <Alert tone="danger" className="mb-3">
            {errorMessage(update.error)}
          </Alert>
        )}
        {users.isPending ? (
          <LoadingBlock />
        ) : users.isError ? (
          <ErrorState error={users.error} onRetry={() => void users.refetch()} />
        ) : (
          <Table label="Users">
            <thead>
              <tr>
                <th scope="col" className={th}>
                  Person
                </th>
                <th scope="col" className={th}>
                  Role
                </th>
                <th scope="col" className={`${th} hidden sm:table-cell`}>
                  Last sign-in
                </th>
                <th scope="col" className={th}>
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {users.data.users.map((u) => {
                const self = u.id === me.data?.user.id;
                return (
                  <tr key={u.id}>
                    <td className={td}>
                      <div className="font-medium">
                        {u.name} {self && <Badge tone="blue">You</Badge>}
                      </div>
                      <div className="text-xs break-all text-slate-600 dark:text-slate-400">
                        {u.email}
                      </div>
                    </td>
                    <td className={td}>
                      <Select
                        aria-label={`Role for ${u.name}`}
                        value={u.role}
                        disabled={self || update.isPending}
                        onChange={(e) =>
                          update.mutate({ id: u.id, patch: { role: e.target.value as UserRole } })
                        }
                        className="min-w-28"
                      >
                        {USER_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className={`${td} hidden whitespace-nowrap sm:table-cell`}>
                      {timeAgo(u.lastLoginAt)}
                    </td>
                    <td className={td}>
                      {self ? (
                        <Badge tone="green">Active</Badge>
                      ) : u.disabled ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => update.mutate({ id: u.id, patch: { disabled: false } })}
                        >
                          Enable
                        </Button>
                      ) : (
                        <ConfirmButton
                          title={`Disable ${u.name}?`}
                          message="They will be signed out and unable to sign in until re-enabled."
                          confirmLabel="Disable"
                          onConfirm={() =>
                            update
                              .mutateAsync({ id: u.id, patch: { disabled: true } })
                              .catch(() => undefined)
                          }
                        >
                          Disable
                        </ConfirmButton>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      {users.data && users.data.invites.length > 0 && (
        <Card>
          <CardTitle>Invites</CardTitle>
          <ul className="divide-y divide-slate-200 text-sm dark:divide-slate-700">
            {users.data.invites.map((i) => {
              const expired = !i.acceptedAt && Date.parse(i.expiresAt) < Date.now();
              return (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="break-all">
                    {i.email} <span className="text-slate-500">({i.role})</span>
                  </span>
                  {i.acceptedAt ? (
                    <Badge tone="green">Accepted</Badge>
                  ) : expired ? (
                    <Badge>Expired</Badge>
                  ) : (
                    <Badge tone="amber">Pending · expires {timeAgo(i.expiresAt)}</Badge>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// System status
// ---------------------------------------------------------------------------

export function SystemStatusPage() {
  const status = useSystemStatus();
  if (status.isPending) return <LoadingBlock />;
  if (status.isError)
    return <ErrorState error={status.error} onRetry={() => void status.refetch()} />;
  const s = status.data;
  const failedTotal = (s.queues ?? []).reduce((n, q) => n + q.failed, 0);
  const backlog = s.webhooks?.backlog ?? 0;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Database"
          value={s.database?.ok === false ? 'Down' : 'OK'}
          tone={s.database?.ok === false ? 'danger' : 'success'}
        />
        <StatCard
          label="Webhook backlog"
          value={backlog}
          tone={backlog > 50 ? 'warning' : 'default'}
          hint={`Last delivery ${timeAgo(s.webhooks?.lastDeliveryAt)}`}
        />
        <StatCard
          label="Failed jobs"
          value={failedTotal}
          tone={failedTotal > 0 ? 'danger' : 'default'}
        />
        <StatCard
          label="AI budget"
          value={s.ai ? `${Math.round(s.ai.pct)}%` : '—'}
          tone={s.ai?.exhausted ? 'danger' : (s.ai?.pct ?? 0) >= 80 ? 'warning' : 'default'}
          hint={s.ai ? `${formatUsd(s.ai.spentUsd)} of ${formatUsd(s.ai.capUsd)}` : undefined}
        />
      </div>

      {s.webhooks?.failed24h ? (
        <Alert tone="warning" title="Webhook failures">
          {s.webhooks.failed24h} webhook deliveries failed in the last 24 hours. Missed updates are
          caught by the 15-minute reconciliation.
        </Alert>
      ) : null}

      <Card>
        <CardTitle>Queues</CardTitle>
        {(s.queues ?? []).length ? (
          <Table label="Queues">
            <thead>
              <tr>
                <th scope="col" className={th}>
                  Queue
                </th>
                <th scope="col" className={`${th} text-right`}>
                  Waiting
                </th>
                <th scope="col" className={`${th} text-right`}>
                  Running
                </th>
                <th scope="col" className={`${th} text-right`}>
                  Failed
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {(s.queues ?? []).map((q) => (
                <tr key={q.name}>
                  <td className={`${td} font-mono text-xs`}>{q.name}</td>
                  <td className={`${td} text-right tabular-nums`}>{q.queued}</td>
                  <td className={`${td} text-right tabular-nums`}>{q.active}</td>
                  <td
                    className={`${td} text-right tabular-nums ${q.failed ? 'font-semibold text-red-700 dark:text-red-400' : ''}`}
                  >
                    {q.failed}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            No queue information reported. Is the worker running?
          </p>
        )}
      </Card>

      {(s.failedJobs ?? []).length > 0 && (
        <Card>
          <CardTitle description="Most recent failures. Jobs retry automatically with backoff.">
            Recent failed jobs
          </CardTitle>
          <ul className="divide-y divide-slate-200 text-sm dark:divide-slate-700">
            {(s.failedJobs ?? []).map((j) => (
              <li key={j.id} className="py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{j.queue}</span>
                  <span className="text-xs text-slate-500">{timeAgo(j.failedAt)}</span>
                </div>
                {j.error && (
                  <p className="mt-0.5 text-xs break-words text-red-700 dark:text-red-400">
                    {j.error}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardTitle>GitHub</CardTitle>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-slate-600 dark:text-slate-400">API rate limit</dt>
            <dd>
              {s.rateLimit
                ? `${formatNumber(s.rateLimit.remaining)} of ${formatNumber(s.rateLimit.limit)} remaining${s.rateLimit.resetAt ? `, resets ${timeAgo(s.rateLimit.resetAt)}` : ''}`
                : 'Unknown'}
            </dd>
          </div>
          <div>
            <dt className="text-slate-600 dark:text-slate-400">Last reconciliation poll</dt>
            <dd>{timeAgo(s.lastPollAt)}</dd>
          </div>
          <div>
            <dt className="text-slate-600 dark:text-slate-400">Last webhook status</dt>
            <dd>{s.webhooks?.lastDeliveryStatus ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-slate-600 dark:text-slate-400">Webhook relay</dt>
            <dd>{s.smeeUrl ? 'smee.io relay active' : 'Direct (public URL)'}</dd>
          </div>
          {s.version && (
            <div>
              <dt className="text-slate-600 dark:text-slate-400">Version</dt>
              <dd className="font-mono text-xs">{s.version}</dd>
            </div>
          )}
        </dl>
      </Card>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        This page refreshes every 30 seconds.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export function AuditLogPage() {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const log = useAuditLog(cursor);
  return (
    <Card>
      <CardTitle description="Every administrative change, who made it and when.">
        Audit log
      </CardTitle>
      {log.isPending ? (
        <LoadingBlock />
      ) : log.isError ? (
        <ErrorState error={log.error} onRetry={() => void log.refetch()} />
      ) : !log.data.entries.length ? (
        <EmptyState title="No entries">Administrative actions will be recorded here.</EmptyState>
      ) : (
        <>
          <Table label="Audit log">
            <thead>
              <tr>
                <th scope="col" className={th}>
                  When
                </th>
                <th scope="col" className={th}>
                  Who
                </th>
                <th scope="col" className={th}>
                  Action
                </th>
                <th scope="col" className={`${th} hidden md:table-cell`}>
                  Target
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {log.data.entries.map((e) => (
                <tr key={e.id}>
                  <td className={`${td} whitespace-nowrap text-xs`}>
                    {formatDateTime(e.occurredAt)}
                  </td>
                  <td className={`${td} text-xs break-all`}>
                    {e.userName ?? e.userEmail ?? (e.userId ? e.userId.slice(0, 8) : 'system')}
                  </td>
                  <td className={`${td} font-mono text-xs`}>{e.action}</td>
                  <td className={`${td} hidden font-mono text-xs break-all md:table-cell`}>
                    {e.targetType ? `${e.targetType}${e.targetId ? `:${e.targetId}` : ''}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="mt-4 flex justify-between gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={cursors.length <= 1}
              onClick={() => setCursors((c) => c.slice(0, -1))}
            >
              Newer
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!log.data.nextCursor}
              onClick={() => setCursors((c) => [...c, log.data.nextCursor ?? null])}
            >
              Older
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
