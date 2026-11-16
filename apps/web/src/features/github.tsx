import { CheckCircle2, ExternalLink, RefreshCw, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { errorMessage } from '../api/client.ts';
import {
  useCreateManifest,
  useDisconnectGithub,
  useGithubStatus,
  useSyncInstallations,
} from '../api/hooks.ts';
import type { GithubStatus } from '../api/types.ts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  ConfirmButton,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
  buttonClass,
} from '../components/ui.tsx';
import { formatDateTime } from '../lib/format.ts';
import { appInstallUrl, safeUrl, submitManifestForm } from '../lib/links.ts';

const PERMISSIONS = [
  ['Repository metadata', 'read'],
  ['Code (contents)', 'read'],
  ['Pull requests', 'read'],
  ['Issues', 'read'],
  ['Checks & commit statuses', 'read'],
  ['Actions', 'read'],
  ['Security events & vulnerability alerts', 'read'],
] as const;

export function installLink(status: GithubStatus | undefined): string | null {
  return safeUrl(status?.installUrl) ?? appInstallUrl(status?.app?.htmlUrl);
}

/** Step "create the GitHub App" via the manifest flow. */
export function CreateAppForm({ returnTo }: { returnTo: 'setup' | 'settings' }) {
  const manifest = useCreateManifest();
  const [appName, setAppName] = useState('git-merge-pilot');
  const [org, setOrg] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    const body: { appName: string; returnTo: 'setup' | 'settings'; org?: string } = {
      appName: appName.trim(),
      returnTo,
    };
    if (org.trim()) body.org = org.trim();
    manifest.mutate(body, {
      onSuccess: (res) => {
        try {
          submitManifestForm(res.postUrl, res.manifest);
        } catch (err) {
          setSubmitError(errorMessage(err));
        }
      },
    });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <p className="text-sm text-slate-700 dark:text-slate-300">
        git-merge-pilot connects through a private GitHub App that you own. We prepare the app for
        you; GitHub asks you to confirm, then sends you back here. It only ever{' '}
        <strong>reads</strong> — it never comments, approves or merges.
      </p>
      <details className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
        <summary className="cursor-pointer font-medium">
          Permissions the app requests (all read-only)
        </summary>
        <ul className="mt-2 grid gap-1 sm:grid-cols-2">
          {PERMISSIONS.map(([p, a]) => (
            <li key={p} className="flex items-center gap-2">
              <CheckCircle2 className="size-4 text-emerald-600" aria-hidden />
              {p}: <span className="text-slate-500">{a}</span>
            </li>
          ))}
        </ul>
      </details>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="App name" hint="Must be unique on GitHub. Add a suffix if the name is taken.">
          <Input
            value={appName}
            onChange={(e) => setAppName(e.target.value)}
            required
            maxLength={34}
          />
        </Field>
        <Field
          label="GitHub organization"
          optional
          hint="Leave empty to create the app under your personal account."
        >
          <Input
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            placeholder="your-org"
            autoCapitalize="none"
          />
        </Field>
      </div>
      {(manifest.isError || submitError) && (
        <Alert tone="danger">{submitError ?? errorMessage(manifest.error)}</Alert>
      )}
      <Button
        type="submit"
        loading={manifest.isPending}
        disabled={!appName.trim()}
        icon={<ExternalLink className="size-4" aria-hidden />}
      >
        Create GitHub App on GitHub
      </Button>
    </form>
  );
}

export function InstallationsList({ status }: { status: GithubStatus }) {
  if (!status.installations.length) return null;
  return (
    <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
      {status.installations.map((i) => (
        <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
          <div>
            <div className="font-medium">{i.accountLogin}</div>
            <div className="text-xs text-slate-600 dark:text-slate-400">
              {i.accountType} ·{' '}
              {i.repositorySelection === 'all' ? 'all repositories' : 'selected repositories'}
            </div>
          </div>
          {i.suspendedAt ? <Badge tone="red">Suspended</Badge> : <Badge tone="green">Active</Badge>}
        </li>
      ))}
    </ul>
  );
}

/** Install-the-app panel used once the app exists. */
export function InstallPanel({ status }: { status: GithubStatus }) {
  const sync = useSyncInstallations();
  const link = installLink(status);
  return (
    <div className="space-y-4">
      <Alert
        tone="success"
        title={`GitHub App "${status.app?.name ?? 'git-merge-pilot'}" is connected`}
      >
        {status.app?.ownerLogin ? `Owned by ${status.app.ownerLogin}. ` : ''}Next, install it on the
        account or organization that holds your repositories.
      </Alert>
      <div className="flex flex-wrap gap-2">
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClass('primary')}
          >
            <ExternalLink className="size-4" aria-hidden />
            {status.installations.length
              ? 'Add or change repositories on GitHub'
              : 'Install on GitHub'}
          </a>
        )}
        <Button
          variant="secondary"
          onClick={() => sync.mutate()}
          loading={sync.isPending}
          icon={<RefreshCw className="size-4" aria-hidden />}
        >
          {status.installations.length ? 'Refresh installations' : "I've installed it"}
        </Button>
      </div>
      {sync.isError && <Alert tone="danger">{errorMessage(sync.error)}</Alert>}
      {sync.isSuccess && !status.installations.length && (
        <Alert tone="warning">
          No installation found yet. Finish installing on GitHub, then press the button again.
        </Alert>
      )}
      <InstallationsList status={status} />
    </div>
  );
}

/** Full GitHub connection card (settings page). */
export function GithubConnectionCard() {
  const status = useGithubStatus();
  const disconnect = useDisconnectGithub();
  if (status.isPending) return <LoadingBlock />;
  if (status.isError)
    return <ErrorState error={status.error} onRetry={() => void status.refetch()} />;
  const s = status.data;
  return (
    <div className="space-y-4">
      <Card>
        <CardTitle description="The read-only GitHub App git-merge-pilot uses to watch pull requests.">
          GitHub App
        </CardTitle>
        {s.connected && s.app ? (
          <div className="space-y-4">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-slate-600 dark:text-slate-400">App</dt>
                <dd className="font-medium">
                  {safeUrl(s.app.htmlUrl) ? (
                    <a
                      href={safeUrl(s.app.htmlUrl) ?? undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-indigo-700 underline dark:text-indigo-300"
                    >
                      {s.app.name}
                    </a>
                  ) : (
                    s.app.name
                  )}{' '}
                  <span className="text-slate-500">(ID {s.app.appId})</span>
                </dd>
              </div>
              <div>
                <dt className="text-slate-600 dark:text-slate-400">Owner</dt>
                <dd className="font-medium">{s.app.ownerLogin ?? '—'}</dd>
              </div>
              {s.webhookUrl && (
                <div className="sm:col-span-2">
                  <dt className="text-slate-600 dark:text-slate-400">Webhook URL</dt>
                  <dd className="font-mono text-xs break-all">{s.webhookUrl}</dd>
                </div>
              )}
              <div>
                <dt className="text-slate-600 dark:text-slate-400">Last webhook received</dt>
                <dd>{formatDateTime(s.lastDeliveryAt)}</dd>
              </div>
              {s.smeeEnabled !== undefined && (
                <div>
                  <dt className="text-slate-600 dark:text-slate-400">Webhook relay (smee)</dt>
                  <dd>{s.smeeEnabled ? 'On' : 'Off'}</dd>
                </div>
              )}
            </dl>
            <InstallPanel status={s} />
            <div className="border-t border-slate-200 pt-4 dark:border-slate-700">
              <h3 className="text-sm font-semibold">Reauthorize or disconnect</h3>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                To change which repositories the app can see, use “Add or change repositories on
                GitHub”. Disconnecting deletes the stored app credentials from git-merge-pilot;
                existing reports and history are kept. You should also delete the app on GitHub
                afterwards.
              </p>
              <div className="mt-3">
                <ConfirmButton
                  variant="danger"
                  title="Disconnect GitHub?"
                  message="git-merge-pilot will stop receiving pull request updates until you connect a GitHub App again. Stored history is kept."
                  confirmLabel="Disconnect"
                  onConfirm={() => disconnect.mutateAsync().catch(() => undefined)}
                  loading={disconnect.isPending}
                  icon={<Trash2 className="size-4" aria-hidden />}
                >
                  Disconnect GitHub
                </ConfirmButton>
              </div>
              {disconnect.isError && (
                <Alert tone="danger" className="mt-3">
                  {errorMessage(disconnect.error)}
                </Alert>
              )}
            </div>
          </div>
        ) : (
          <CreateAppForm returnTo="settings" />
        )}
      </Card>
    </div>
  );
}
