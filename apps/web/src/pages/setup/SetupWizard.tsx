import { clsx } from 'clsx';
import { Check, ChevronDown, Rocket } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { errorMessage } from '../../api/client.ts';
import {
  useAiProviders,
  useAiSettings,
  useChannels,
  useCompleteSetup,
  useCreateProject,
  useGithubStatus,
  useMe,
  useProjects,
  useRepositories,
  useRepository,
  useRules,
  useSetupAdmin,
  useSetupStatus,
  useSyncInstallations,
  useUpdateAiSettings,
  useUpdateRepository,
} from '../../api/hooks.ts';
import type { Repository } from '../../api/types.ts';
import { AuthShell } from '../AuthPages.tsx';
import {
  Alert,
  Button,
  ErrorState,
  Field,
  InlineResult,
  Input,
  LoadingBlock,
  Select,
  Spinner,
  Textarea,
} from '../../components/ui.tsx';
import { DataFlowConsent, ModelsAndBudgetForm, ProviderManager } from '../../features/ai.tsx';
import { CreateAppForm, InstallPanel } from '../../features/github.tsx';
import { ChannelManager, RuleEditor } from '../../features/notify.tsx';
import { NoReposHelp, ProfileEditor, RepoSelector } from '../../features/repos.tsx';
import { browserTimezone, timezoneOptions } from '../../lib/format.ts';

export const SETUP_STEPS = [
  { n: 1, title: 'Admin account' },
  { n: 2, title: 'Connect GitHub' },
  { n: 3, title: 'Repositories & project' },
  { n: 4, title: 'AI analysis' },
  { n: 5, title: 'Notifications' },
  { n: 6, title: 'Review repositories' },
  { n: 7, title: 'Start monitoring' },
] as const;

function Stepper({
  current,
  maxReached,
  onGo,
}: {
  current: number;
  maxReached: number;
  onGo: (n: number) => void;
}) {
  return (
    <nav aria-label="Setup progress" className="mb-6">
      <ol className="flex gap-1 overflow-x-auto pb-1 text-xs sm:text-sm">
        {SETUP_STEPS.map((s) => {
          const done = s.n < current;
          const active = s.n === current;
          const reachable = s.n >= 2 && s.n <= maxReached && !active;
          return (
            <li key={s.n} className="flex-1">
              <button
                type="button"
                disabled={!reachable}
                onClick={() => onGo(s.n)}
                aria-current={active ? 'step' : undefined}
                className={clsx(
                  'flex w-full min-w-24 flex-col items-start gap-1 rounded-lg border-t-4 px-1 pt-2 text-left focus-visible:outline-2 focus-visible:outline-indigo-500',
                  active
                    ? 'border-indigo-600 font-semibold text-indigo-700 dark:text-indigo-300'
                    : done
                      ? 'border-indigo-300 text-slate-700 dark:border-indigo-800 dark:text-slate-300'
                      : 'border-slate-200 text-slate-500 dark:border-slate-700',
                  reachable && 'cursor-pointer hover:text-indigo-700',
                )}
              >
                <span className="flex items-center gap-1">
                  {done ? (
                    <Check className="size-3.5" aria-hidden />
                  ) : (
                    <span aria-hidden>{s.n}.</span>
                  )}
                  <span className="sr-only">Step {s.n}: </span>
                  {s.title}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function StepFooter({
  onBack,
  children,
}: {
  onBack?: (() => void) | undefined;
  children?: ReactNode;
}) {
  return (
    <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4 dark:border-slate-700">
      {onBack ? (
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
      ) : (
        <span />
      )}
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1
// ---------------------------------------------------------------------------

function AdminStep({ initialToken, onDone }: { initialToken: string; onDone: () => void }) {
  const create = useSetupAdmin();
  // A token that arrived in the setup link is used silently; the field only appears when the
  // page was opened without one, or the linked token was rejected.
  const [tokenFromLink] = useState(() => initialToken.trim());
  const [form, setForm] = useState({
    setupToken: initialToken.trim(),
    name: '',
    email: '',
    password: '',
    confirm: '',
    timezone: browserTimezone(),
  });
  useEffect(() => {
    // Keep the one-time token out of the address bar and browser history.
    if (tokenFromLink && window.location.search.includes('token=')) {
      const url = new URL(window.location.href);
      url.searchParams.delete('token');
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    }
  }, [tokenFromLink]);
  const tokenRejected =
    create.isError && /setup token/i.test(errorMessage(create.error)) && Boolean(tokenFromLink);
  const showTokenField = !tokenFromLink || tokenRejected;
  const timezones = useMemo(() => {
    const list = timezoneOptions();
    return list.includes(form.timezone) ? list : [form.timezone, ...list];
  }, [form.timezone]);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const tooShort = form.password.length > 0 && form.password.length < 12;
  const mismatch = form.confirm.length > 0 && form.confirm !== form.password;
  const ready =
    form.setupToken.trim() &&
    form.name.trim() &&
    form.email.includes('@') &&
    form.password.length >= 12 &&
    form.password === form.confirm;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    create.mutate(
      {
        setupToken: form.setupToken.trim(),
        name: form.name.trim(),
        email: form.email.trim().toLowerCase(),
        password: form.password,
        timezone: form.timezone,
      },
      { onSuccess: onDone },
    );
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h2 className="text-lg font-semibold">Create your admin account</h2>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        You will use this email and password to sign in to git-merge-pilot.
      </p>
      {create.isError && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
      {showTokenField && (
        <Field
          label="Setup token"
          hint="Printed in the server log the first time git-merge-pilot started (run: docker compose logs server). Opening the setup link from the log fills this in for you."
        >
          <Input
            value={form.setupToken}
            onChange={set('setupToken')}
            autoComplete="off"
            required
            className="font-mono"
          />
        </Field>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Your name">
          <Input value={form.name} onChange={set('name')} autoComplete="name" required />
        </Field>
        <Field label="Email">
          <Input
            type="email"
            value={form.email}
            onChange={set('email')}
            autoComplete="email"
            required
          />
        </Field>
        <Field
          label="Password"
          hint="At least 12 characters."
          error={tooShort ? 'Use at least 12 characters.' : null}
        >
          <Input
            type="password"
            value={form.password}
            onChange={set('password')}
            autoComplete="new-password"
            required
          />
        </Field>
        <Field label="Confirm password" error={mismatch ? 'Passwords do not match.' : null}>
          <Input
            type="password"
            value={form.confirm}
            onChange={set('confirm')}
            autoComplete="new-password"
            required
          />
        </Field>
        <Field
          label="Time zone"
          hint="Detected from your browser. Used for daily digests and quiet hours."
        >
          <Select value={form.timezone} onChange={set('timezone')}>
            {timezones.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <StepFooter>
        <Button type="submit" loading={create.isPending} disabled={!ready}>
          Create account & continue
        </Button>
      </StepFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 2
// ---------------------------------------------------------------------------

function GithubStep({ onNext }: { onNext: () => void }) {
  const status = useGithubStatus();
  const [params] = useSearchParams();
  const callbackError = params.get('error');
  if (status.isPending) return <LoadingBlock />;
  if (status.isError)
    return <ErrorState error={status.error} onRetry={() => void status.refetch()} />;
  const s = status.data;
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Connect GitHub</h2>
      {callbackError && (
        <Alert tone="danger" title="GitHub connection did not finish">
          {callbackError}
        </Alert>
      )}
      {s.connected ? <InstallPanel status={s} /> : <CreateAppForm returnTo="setup" />}
      <StepFooter>
        <Button onClick={onNext} disabled={!s.connected || !s.installations.length}>
          Continue
        </Button>
      </StepFooter>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3
// ---------------------------------------------------------------------------

function ReposProjectStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const repos = useRepositories();
  const projects = useProjects();
  const sync = useSyncInstallations();
  const update = useUpdateRepository();
  const createProject = useCreateProject();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const syncedOnce = useRef(false);

  const list = useMemo(
    () => (repos.data ?? []).filter((r) => !r.archived || r.monitoringEnabled),
    [repos.data],
  );

  // First visit: pull repositories from the installation if none are known yet.
  useEffect(() => {
    if (repos.isSuccess && repos.data.length === 0 && !syncedOnce.current) {
      syncedOnce.current = true;
      sync.mutate();
    }
  }, [repos.isSuccess, repos.data, sync]);

  const initialized = useRef(false);
  useEffect(() => {
    if (!initialized.current && repos.data && repos.data.length) {
      initialized.current = true;
      setSelected(
        new Set(repos.data.filter((r) => r.monitoringEnabled && !r.archived).map((r) => r.id)),
      );
    }
  }, [repos.data]);

  const existing = projects.data ?? [];

  const save = async () => {
    setError(null);
    if (!selected.size) return setError('Select at least one repository to monitor.');
    if (!name.trim() && !existing.length) return setError('Give your first project a name.');
    setSaving(true);
    try {
      const changes = (repos.data ?? []).filter((r) => r.monitoringEnabled !== selected.has(r.id));
      for (const r of changes) {
        await update.mutateAsync({ id: r.id, patch: { monitoringEnabled: selected.has(r.id) } });
      }
      if (name.trim()) {
        await createProject.mutateAsync({
          name: name.trim(),
          description: description.trim() || null,
          repositoryIds: [...selected],
        });
      }
      onNext();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Choose repositories and create a project</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          A project groups the repositories that make up one product or team. Pull requests in
          unselected repositories are ignored.
        </p>
      </div>
      {repos.isPending || sync.isPending ? (
        <Spinner label="Loading repositories from GitHub…" />
      ) : repos.isError ? (
        <ErrorState error={repos.error} onRetry={() => void repos.refetch()} />
      ) : list.length === 0 ? (
        <div className="space-y-3">
          <NoReposHelp />
          <Button variant="secondary" size="sm" onClick={() => sync.mutate()}>
            Refresh from GitHub
          </Button>
          {sync.isError && <InlineResult ok={false}>{errorMessage(sync.error)}</InlineResult>}
        </div>
      ) : (
        <RepoSelector
          repos={list}
          selected={selected}
          onChange={setSelected}
          label="Repositories to monitor"
        />
      )}

      <div className="space-y-4 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
        {existing.length > 0 && (
          <Alert tone="success">
            You already have{' '}
            {existing.length === 1
              ? `the project “${existing[0]?.name}”`
              : `${existing.length} projects`}
            . You can add another or continue.
          </Alert>
        )}
        <Field label="Project name" optional={existing.length > 0}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Checkout platform"
          />
        </Field>
        <Field label="Description" optional>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </Field>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <StepFooter onBack={onBack}>
        <Button onClick={() => void save()} loading={saving} disabled={!list.length}>
          {name.trim() ? 'Create project & continue' : 'Save & continue'}
        </Button>
      </StepFooter>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4
// ---------------------------------------------------------------------------

function AiStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const settings = useAiSettings();
  const repos = useRepositories();
  const providers = useAiProviders();
  const update = useUpdateAiSettings();
  const updateRepo = useUpdateRepository();
  const [phase, setPhase] = useState<'consent' | 'provider' | 'models'>('consent');

  useEffect(() => {
    if (settings.data?.enabled && phase === 'consent')
      setPhase(providers.data?.length ? 'models' : 'provider');
  }, [settings.data?.enabled, providers.data?.length]);

  if (settings.isPending) return <LoadingBlock />;
  if (settings.isError)
    return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;

  const monitored = (repos.data ?? []).filter((r) => r.monitoringEnabled);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">AI analysis (optional)</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Without AI you still get verified facts: breaking changes, security checks, overlaps, risk
          and merge readiness. AI adds plain-language summaries and potential concerns.
        </p>
      </div>
      {phase === 'consent' && (
        <DataFlowConsent
          repos={monitored}
          onRepoModeChange={(r: Repository, mode) =>
            updateRepo.mutate({ id: r.id, patch: { aiMode: mode } })
          }
          enabling={update.isPending}
          error={
            update.isError
              ? errorMessage(update.error)
              : updateRepo.isError
                ? errorMessage(updateRepo.error)
                : null
          }
          onEnable={() =>
            update.mutate(
              { enabled: true, consent: true },
              { onSuccess: () => setPhase('provider') },
            )
          }
          onSkip={onNext}
        />
      )}
      {phase === 'provider' && (
        <div className="space-y-4">
          <Alert tone="success">AI is enabled. Add the provider git-merge-pilot should use.</Alert>
          <ProviderManager />
          <StepFooter onBack={() => setPhase('consent')}>
            <Button onClick={() => setPhase('models')} disabled={!providers.data?.length}>
              Continue to models & budget
            </Button>
          </StepFooter>
        </div>
      )}
      {phase === 'models' && settings.data && (
        <div className="space-y-4">
          <ModelsAndBudgetForm
            settings={settings.data}
            onSaved={onNext}
            submitLabel="Save & continue"
          />
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPhase('provider')}>
              Manage providers
            </Button>
          </div>
        </div>
      )}
      {phase === 'consent' && <StepFooter onBack={onBack} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 5
// ---------------------------------------------------------------------------

function NotificationsStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const channels = useChannels();
  const rules = useRules();
  const orgRule = (rules.data ?? []).find((r) => r.projectId === null) ?? null;
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Notifications</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Choose where alerts go, which events matter, quiet hours and when the daily digest is
          sent.
        </p>
      </div>
      <section aria-labelledby="ch-h" className="space-y-3">
        <h3 id="ch-h" className="font-semibold">
          Channels
        </h3>
        <ChannelManager />
      </section>
      <section aria-labelledby="rule-h" className="space-y-3">
        <h3 id="rule-h" className="font-semibold">
          Default rule
        </h3>
        {channels.isPending || rules.isPending ? (
          <Spinner />
        ) : (
          <RuleEditor key={orgRule?.id ?? 'new'} rule={orgRule} channels={channels.data ?? []} />
        )}
      </section>
      <StepFooter onBack={onBack}>
        <Button onClick={onNext}>Continue</Button>
      </StepFooter>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 6
// ---------------------------------------------------------------------------

function RepoProfileItem({ repo }: { repo: Repository }) {
  const [open, setOpen] = useState(false);
  const detail = useRepository(open ? repo.id : undefined);
  return (
    <li className="rounded-lg border border-slate-200 dark:border-slate-700">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 p-3 text-left text-sm font-medium break-all focus-visible:outline-2 focus-visible:outline-indigo-500"
      >
        {repo.fullName}
        <ChevronDown
          className={clsx('size-4 shrink-0 transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      {open && (
        <div className="border-t border-slate-200 p-3 dark:border-slate-700">
          {detail.isPending ? (
            <Spinner />
          ) : detail.isError ? (
            <ErrorState error={detail.error} />
          ) : (
            <ProfileEditor repo={detail.data} />
          )}
        </div>
      )}
    </li>
  );
}

function ProfilesStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const repos = useRepositories();
  const monitored = (repos.data ?? []).filter((r) => r.monitoringEnabled);
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Review what we discovered</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Each repository is scanned for languages, frameworks, CI and docs. Correct anything that
          looks wrong — it helps reports describe impact accurately. Scans run in the background and
          may take a minute.
        </p>
      </div>
      {repos.isPending ? (
        <Spinner />
      ) : monitored.length ? (
        <ul className="space-y-2">
          {monitored.map((r) => (
            <RepoProfileItem key={r.id} repo={r} />
          ))}
        </ul>
      ) : (
        <Alert tone="info">No monitored repositories. Go back to choose some.</Alert>
      )}
      <StepFooter onBack={onBack}>
        <Button onClick={onNext}>Continue</Button>
      </StepFooter>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 7
// ---------------------------------------------------------------------------

function FinishStep({ onBack }: { onBack: () => void }) {
  const github = useGithubStatus();
  const repos = useRepositories();
  const projects = useProjects();
  const ai = useAiSettings();
  const channels = useChannels();
  const complete = useCompleteSetup();
  const navigate = useNavigate();
  const monitored = (repos.data ?? []).filter((r) => r.monitoringEnabled).length;
  const items: Array<{ label: string; ok: boolean; detail: string }> = [
    {
      label: 'GitHub',
      ok: Boolean(github.data?.connected && github.data.installations.length),
      detail: github.data?.app?.name ?? 'Not connected',
    },
    { label: 'Repositories', ok: monitored > 0, detail: `${monitored} monitored` },
    {
      label: 'Projects',
      ok: (projects.data?.length ?? 0) > 0,
      detail: `${projects.data?.length ?? 0} created`,
    },
    {
      label: 'AI analysis',
      ok: true,
      detail: ai.data?.enabled ? 'Enabled' : 'Off (automated analysis only)',
    },
    {
      label: 'Notification channels',
      ok: true,
      detail: `${channels.data?.length ?? 0} configured · in-app always on`,
    },
  ];
  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold">Ready to start monitoring</h2>
      <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
        {items.map((i) => (
          <li key={i.label} className="flex items-center justify-between gap-3 p-3 text-sm">
            <span className="flex items-center gap-2 font-medium">
              <span
                className={clsx(
                  'grid size-5 place-items-center rounded-full',
                  i.ok
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                    : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
                )}
              >
                {i.ok ? (
                  <Check className="size-3.5" aria-label="done" />
                ) : (
                  <span aria-label="needs attention">!</span>
                )}
              </span>
              {i.label}
            </span>
            <span className="text-right text-slate-600 dark:text-slate-400">{i.detail}</span>
          </li>
        ))}
      </ul>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Open pull requests in monitored repositories are analyzed first; new activity arrives
        through GitHub webhooks, with a safety check every 15 minutes.
      </p>
      {complete.isError && <Alert tone="danger">{errorMessage(complete.error)}</Alert>}
      <StepFooter onBack={onBack}>
        <Button
          onClick={() =>
            complete.mutate(undefined, { onSuccess: () => navigate('/', { replace: true }) })
          }
          loading={complete.isPending}
          icon={<Rocket className="size-4" aria-hidden />}
        >
          Start monitoring
        </Button>
      </StepFooter>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

export function SetupWizard() {
  const status = useSetupStatus();
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const [maxReached, setMaxReached] = useState(1);

  const requested = Number(params.get('step'));
  const serverStep = status.data?.step ?? 1;
  const adminCreated = status.data?.adminCreated ?? false;
  const step = !adminCreated
    ? 1
    : Math.min(
        7,
        Math.max(2, Number.isFinite(requested) && requested >= 2 ? requested : serverStep),
      );

  useEffect(() => setMaxReached((m) => Math.max(m, step, serverStep)), [step, serverStep]);

  if (status.isPending || me.isPending) return <LoadingBlock />;
  if (status.isError) {
    return (
      <AuthShell title="Set up git-merge-pilot">
        <ErrorState
          error={status.error}
          title="Could not reach the server"
          onRetry={() => void status.refetch()}
        />
      </AuthShell>
    );
  }
  if (status.data.completed) return <Navigate to="/" replace />;
  if (adminCreated && !me.data)
    return <Navigate to={`/login?next=${encodeURIComponent('/setup')}`} replace />;
  if (adminCreated && me.data && me.data.user.role !== 'admin') {
    return (
      <AuthShell title="Setup in progress">
        <Alert tone="info">
          An admin is still setting up git-merge-pilot. Please check back later.
        </Alert>
      </AuthShell>
    );
  }

  const go = (n: number) => {
    const next = new URLSearchParams(params);
    next.set('step', String(n));
    next.delete('error');
    setParams(next);
    window.scrollTo?.({ top: 0 });
  };

  return (
    <AuthShell
      wide
      title="Set up git-merge-pilot"
      subtitle="About 10 minutes. You can change everything later in Settings."
    >
      <Stepper current={step} maxReached={maxReached} onGo={go} />
      {step === 1 && <AdminStep initialToken={params.get('token') ?? ''} onDone={() => go(2)} />}
      {step === 2 && <GithubStep onNext={() => go(3)} />}
      {step === 3 && <ReposProjectStep onBack={() => go(2)} onNext={() => go(4)} />}
      {step === 4 && <AiStep onBack={() => go(3)} onNext={() => go(5)} />}
      {step === 5 && <NotificationsStep onBack={() => go(4)} onNext={() => go(6)} />}
      {step === 6 && <ProfilesStep onBack={() => go(5)} onNext={() => go(7)} />}
      {step === 7 && <FinishStep onBack={() => go(6)} />}
    </AuthShell>
  );
}
