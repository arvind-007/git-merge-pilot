import { FlaskConical, Mail, MessageSquare, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { errorMessage } from '../api/client.ts';
import {
  useChannels,
  useCreateChannel,
  useDeleteChannel,
  useDeleteRule,
  useSaveRule,
  useTestChannel,
  useUpdateChannel,
} from '../api/hooks.ts';
import {
  NOTIFICATION_KINDS,
  SEVERITIES,
  type ChannelKind,
  type NotificationChannel,
  type NotificationKind,
  type NotificationRule,
  type NotificationRuleInput,
  type Project,
  type Severity,
} from '../api/types.ts';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ConfirmButton,
  Field,
  InlineResult,
  Input,
  Select,
  Toggle,
} from '../components/ui.tsx';
import {
  CHANNEL_LABEL,
  NOTIFICATION_KIND_LABEL,
  SEVERITY_LABEL,
  browserTimezone,
  timezoneOptions,
} from '../lib/format.ts';

function ChannelRow({ channel }: { channel: NotificationChannel }) {
  const test = useTestChannel();
  const update = useUpdateChannel();
  const del = useDeleteChannel();
  const Icon = channel.kind === 'email' ? Mail : MessageSquare;
  return (
    <li className="space-y-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="size-4 shrink-0 text-slate-500" aria-hidden />
          <div className="min-w-0">
            <div className="font-medium break-words">{channel.name}</div>
            <div className="text-xs break-all text-slate-600 dark:text-slate-400">
              {CHANNEL_LABEL[channel.kind]}
              {channel.summary ? ` · ${channel.summary}` : ''}
              {channel.kind !== 'in_app' && !channel.configured ? ' · not configured' : ''}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!channel.enabled && <Badge>Disabled</Badge>}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => test.mutate(channel.id)}
            loading={test.isPending}
            icon={<FlaskConical className="size-4" aria-hidden />}
          >
            Send test
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => update.mutate({ id: channel.id, patch: { enabled: !channel.enabled } })}
            loading={update.isPending}
          >
            {channel.enabled ? 'Disable' : 'Enable'}
          </Button>
          {channel.kind !== 'in_app' && (
            <ConfirmButton
              title={`Delete ${channel.name}?`}
              message="Rules that use this channel will no longer send to it."
              confirmLabel="Delete"
              onConfirm={() => del.mutateAsync(channel.id).catch(() => undefined)}
              loading={del.isPending}
              icon={<Trash2 className="size-4" aria-hidden />}
            >
              Delete
            </ConfirmButton>
          )}
        </div>
      </div>
      {test.data && (
        <InlineResult ok={test.data.ok}>
          {test.data.ok ? 'Test message sent' : (test.data.error ?? 'Test failed')}
        </InlineResult>
      )}
      {test.isError && <InlineResult ok={false}>{errorMessage(test.error)}</InlineResult>}
      {(update.isError || del.isError) && (
        <InlineResult ok={false}>{errorMessage(update.error ?? del.error)}</InlineResult>
      )}
    </li>
  );
}

export function ChannelForm({ onDone }: { onDone?: () => void }) {
  const create = useCreateChannel();
  const [kind, setKind] = useState<Exclude<ChannelKind, 'in_app'>>('slack');
  const [name, setName] = useState('Team Slack');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('587');
  const [secure, setSecure] = useState(false);
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [from, setFrom] = useState('');
  const [testTo, setTestTo] = useState('');

  const slackValid = /^https:\/\/\S+$/.test(webhookUrl.trim());
  const emailValid =
    host.trim() &&
    Number(port) > 0 &&
    from.includes('@') &&
    (!testTo.trim() || testTo.includes('@'));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const config =
      kind === 'slack'
        ? { webhookUrl: webhookUrl.trim() }
        : {
            host: host.trim(),
            port: Number(port),
            secure,
            from: from.trim(),
            ...(testTo.trim() ? { testRecipient: testTo.trim() } : {}),
            ...(user.trim() ? { user: user.trim() } : {}),
            ...(pass ? { pass } : {}),
          };
    create.mutate(
      { kind, name: name.trim(), enabled: true, config },
      { onSuccess: () => onDone?.() },
    );
  };

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-lg border border-slate-200 p-4 dark:border-slate-700"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Channel type">
          <Select
            value={kind}
            onChange={(e) => {
              const k = e.target.value as 'slack' | 'email';
              setKind(k);
              setName(k === 'slack' ? 'Team Slack' : 'Team email');
            }}
          >
            <option value="slack">Slack (incoming webhook)</option>
            <option value="email">Email (SMTP)</option>
          </Select>
        </Field>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
      </div>
      {kind === 'slack' ? (
        <Field
          label="Slack incoming webhook URL"
          hint="Create one in Slack: Apps → Incoming Webhooks. Stored encrypted."
        >
          <Input
            type="password"
            autoComplete="off"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder="https://hooks.slack.com/services/…"
            required
          />
        </Field>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="SMTP host">
            <Input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="smtp.example.com"
              required
            />
          </Field>
          <Field label="Port">
            <Input
              type="number"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              min={1}
              max={65535}
              required
            />
          </Field>
          <Field label="Username" optional>
            <Input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Password" optional hint="Stored encrypted.">
            <Input
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field label="From address">
            <Input
              type="email"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder="gmp@example.com"
              required
            />
          </Field>
          <Field
            label="Test address"
            optional
            hint="Only used by the Test button. Notifications are emailed to each recipient's own account address: admins, plus members of the project."
          >
            <Input
              type="email"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="you@example.com"
            />
          </Field>
          <div className="sm:col-span-2">
            <Checkbox
              checked={secure}
              onChange={setSecure}
              label="Use TLS from the start (port 465)"
              description="Leave off for STARTTLS on port 587."
            />
          </div>
        </div>
      )}
      {create.isError && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          loading={create.isPending}
          disabled={!name.trim() || (kind === 'slack' ? !slackValid : !emailValid)}
          icon={<Plus className="size-4" aria-hidden />}
        >
          Add channel
        </Button>
        {onDone && (
          <Button variant="secondary" onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

export function ChannelManager() {
  const channels = useChannels();
  const [adding, setAdding] = useState(false);
  const list = channels.data ?? [];
  return (
    <div className="space-y-4">
      {channels.isError && <Alert tone="danger">{errorMessage(channels.error)}</Alert>}
      <p className="text-sm text-slate-600 dark:text-slate-400">
        In-app notifications are always available. Add Slack or email to reach people where they
        work.
      </p>
      {list.length > 0 && (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
          {list.map((c) => (
            <ChannelRow key={c.id} channel={c} />
          ))}
        </ul>
      )}
      {adding ? (
        <ChannelForm onDone={() => setAdding(false)} />
      ) : (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setAdding(true)}
          icon={<Plus className="size-4" aria-hidden />}
        >
          Add Slack or email channel
        </Button>
      )}
    </div>
  );
}

const DEFAULT_EVENTS: NotificationKind[] = [
  'high_risk',
  'security_finding',
  'breaking_change',
  'overlap_detected',
  'clarification_needed',
  'budget_alert',
  'webhook_failure',
];

export function emptyRule(
  channels: NotificationChannel[],
  projectId: string | null = null,
): NotificationRuleInput {
  return {
    projectId,
    minSeverity: 'high',
    events: DEFAULT_EVENTS,
    channelIds: channels.filter((c) => c.enabled).map((c) => c.id),
    digestEnabled: true,
    digestHour: 9,
    timezone: browserTimezone(),
    quietStart: null,
    quietEnd: null,
  };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Validate a rule; returns a plain-language problem or null. */
export function validateRule(r: NotificationRuleInput): string | null {
  if (!r.channelIds.length) return 'Pick at least one channel.';
  if (Boolean(r.quietStart) !== Boolean(r.quietEnd))
    return 'Set both a start and end time for quiet hours, or neither.';
  if (r.quietStart && !HHMM.test(r.quietStart)) return 'Quiet hours start must look like 22:00.';
  if (r.quietEnd && !HHMM.test(r.quietEnd)) return 'Quiet hours end must look like 07:00.';
  if (!Number.isInteger(r.digestHour) || r.digestHour < 0 || r.digestHour > 23)
    return 'Digest hour must be between 0 and 23.';
  return null;
}

export function RuleEditor({
  rule,
  channels,
  projects = [],
  onSaved,
  onDeleted,
}: {
  rule: NotificationRule | null;
  channels: NotificationChannel[];
  projects?: Project[];
  onSaved?: () => void;
  onDeleted?: () => void;
}) {
  const save = useSaveRule();
  const del = useDeleteRule();
  const [draft, setDraft] = useState<NotificationRuleInput>(() =>
    rule ? { ...rule } : emptyRule(channels),
  );
  useEffect(() => {
    if (rule) setDraft({ ...rule });
  }, [rule]);
  const problem = validateRule(draft);
  const set = <K extends keyof NotificationRuleInput>(k: K, v: NotificationRuleInput[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  const toggleIn = <T,>(list: T[], v: T, on: boolean) =>
    on ? [...new Set([...list, v])] : list.filter((x) => x !== v);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (problem) return;
    const {
      projectId,
      minSeverity,
      events,
      channelIds,
      digestEnabled,
      digestHour,
      timezone,
      quietStart,
      quietEnd,
    } = draft;
    save.mutate(
      {
        ...(rule ? { id: rule.id } : {}),
        rule: {
          projectId,
          minSeverity,
          events,
          channelIds,
          digestEnabled,
          digestHour,
          timezone,
          quietStart: quietStart || null,
          quietEnd: quietEnd || null,
        },
      },
      { onSuccess: () => onSaved?.() },
    );
  };

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Applies to" hint="Project rules take priority over the organization default.">
          <Select
            value={draft.projectId ?? ''}
            onChange={(e) => set('projectId', e.target.value || null)}
            disabled={Boolean(rule)}
          >
            <option value="">All projects (organization default)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Minimum severity"
          hint="Lower-severity events are only included in the digest."
        >
          <Select
            value={draft.minSeverity}
            onChange={(e) => set('minSeverity', e.target.value as Severity)}
          >
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]} and above
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <fieldset>
        <legend className="text-sm font-medium">Send to</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {channels.map((c) => (
            <Checkbox
              key={c.id}
              checked={draft.channelIds.includes(c.id)}
              onChange={(on) => set('channelIds', toggleIn(draft.channelIds, c.id, on))}
              label={`${c.name} (${CHANNEL_LABEL[c.kind]})`}
            />
          ))}
          {!channels.length && (
            <p className="text-sm text-slate-600 dark:text-slate-400">
              No channels yet — add one above.
            </p>
          )}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-sm font-medium">Events</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {NOTIFICATION_KINDS.filter((k) => k !== 'digest').map((k) => (
            <Checkbox
              key={k}
              checked={draft.events.includes(k)}
              onChange={(on) => set('events', toggleIn(draft.events, k, on))}
              label={NOTIFICATION_KIND_LABEL[k]}
            />
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Timezone">
          <Select value={draft.timezone ?? 'UTC'} onChange={(e) => set('timezone', e.target.value)}>
            {timezoneOptions().map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Quiet hours start"
          optional
          hint="Non-critical messages wait until quiet hours end."
        >
          <Input
            type="time"
            value={draft.quietStart ?? ''}
            onChange={(e) => set('quietStart', e.target.value || null)}
          />
        </Field>
        <Field label="Quiet hours end" optional>
          <Input
            type="time"
            value={draft.quietEnd ?? ''}
            onChange={(e) => set('quietEnd', e.target.value || null)}
          />
        </Field>
      </div>

      <div className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
        <Toggle
          label="Daily digest"
          description="One summary of open PRs, risks and overlaps each day."
          checked={draft.digestEnabled}
          onChange={(v) => set('digestEnabled', v)}
        />
        {draft.digestEnabled && (
          <Field label="Send digest at" hint="Local time in the timezone above.">
            <Select
              value={String(draft.digestHour)}
              onChange={(e) => set('digestHour', Number(e.target.value))}
              className="max-w-40"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      {problem && <Alert tone="warning">{problem}</Alert>}
      {save.isError && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" loading={save.isPending} disabled={Boolean(problem)}>
          {rule ? 'Save rule' : 'Create rule'}
        </Button>
        {rule && (
          <ConfirmButton
            title="Delete this rule?"
            message="Notifications covered by this rule will fall back to the organization default."
            confirmLabel="Delete"
            onConfirm={() =>
              del
                .mutateAsync(rule.id)
                .then(() => onDeleted?.())
                .catch(() => undefined)
            }
            loading={del.isPending}
          >
            Delete rule
          </ConfirmButton>
        )}
        {save.isSuccess && <InlineResult ok>Saved</InlineResult>}
      </div>
    </form>
  );
}
