import { Lock, RefreshCw, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { errorMessage } from '../api/client.ts';
import { useRediscoverRepository, useUpdateRepository } from '../api/hooks.ts';
import {
  AI_MODES,
  type AiMode,
  type Repository,
  type RepositoryDetail,
  type RepositoryProfileData,
} from '../api/types.ts';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Field,
  InlineResult,
  Input,
  Textarea,
  Toggle,
} from '../components/ui.tsx';
import { AI_MODE_HINT, AI_MODE_LABEL, linesToList, timeAgo } from '../lib/format.ts';

/** Searchable multi-select of repositories. */
export function RepoSelector({
  repos,
  selected,
  onChange,
  label = 'Repositories',
}: {
  repos: Pick<Repository, 'id' | 'fullName' | 'private' | 'archived'>[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  label?: string;
}) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return repos.filter((r) => !needle || r.fullName.toLowerCase().includes(needle));
  }, [repos, q]);
  const allFilteredSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.id));

  const toggleAll = () => {
    const next = new Set(selected);
    for (const r of filtered) {
      if (allFilteredSelected) next.delete(r.id);
      else next.add(r.id);
    }
    onChange(next);
  };

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-slate-800 dark:text-slate-200">{label}</legend>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400"
            aria-hidden
          />
          <Input
            aria-label="Search repositories"
            placeholder="Search repositories…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-8"
            type="search"
          />
        </div>
        <Button size="sm" variant="secondary" onClick={toggleAll} disabled={!filtered.length}>
          {allFilteredSelected ? 'Clear' : 'Select'} {q ? 'matching' : 'all'}
        </Button>
      </div>
      <div className="text-xs text-slate-600 dark:text-slate-400" aria-live="polite">
        {selected.size} of {repos.length} selected
      </div>
      <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
        {filtered.map((r) => (
          <li key={r.id} className="px-3 py-2">
            <Checkbox
              checked={selected.has(r.id)}
              onChange={(v) => {
                const next = new Set(selected);
                if (v) next.add(r.id);
                else next.delete(r.id);
                onChange(next);
              }}
              label={
                <span className="inline-flex flex-wrap items-center gap-1.5 break-all">
                  {r.fullName}
                  {r.private && <Lock className="size-3.5 text-slate-400" aria-label="private" />}
                  {r.archived && <Badge>archived</Badge>}
                </span>
              }
            />
          </li>
        ))}
        {!filtered.length && (
          <li className="px-3 py-4 text-sm text-slate-600 dark:text-slate-400">
            No repositories match “{q}”.
          </li>
        )}
      </ul>
    </fieldset>
  );
}

export function AiModeRadios({
  value,
  onChange,
  name,
}: {
  value: AiMode;
  onChange: (m: AiMode) => void;
  name: string;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-slate-800 dark:text-slate-200">
        What may be sent to the AI provider
      </legend>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        {AI_MODES.map((m) => (
          <label
            key={m}
            className={`flex cursor-pointer gap-2 rounded-lg border p-3 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-indigo-500 ${value === m ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/50' : 'border-slate-200 dark:border-slate-700'}`}
          >
            <input
              type="radio"
              name={name}
              value={m}
              checked={value === m}
              onChange={() => onChange(m)}
              className="mt-0.5 accent-indigo-600"
            />
            <span>
              <span className="font-medium">{AI_MODE_LABEL[m]}</span>
              <span className="mt-0.5 block text-xs text-slate-600 dark:text-slate-400">
                {AI_MODE_HINT[m]}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Monitoring toggle, AI mode, exclude paths. */
export function RepoSettingsForm({ repo }: { repo: Repository }) {
  const update = useUpdateRepository();
  const [monitoring, setMonitoring] = useState(repo.monitoringEnabled);
  const [aiMode, setAiMode] = useState<AiMode>(repo.aiMode);
  const [exclude, setExclude] = useState((repo.excludePaths ?? []).join('\n'));
  useEffect(() => {
    setMonitoring(repo.monitoringEnabled);
    setAiMode(repo.aiMode);
    setExclude((repo.excludePaths ?? []).join('\n'));
  }, [repo]);

  const save = () =>
    update.mutate({
      id: repo.id,
      patch: { monitoringEnabled: monitoring, aiMode, excludePaths: linesToList(exclude) },
    });

  return (
    <div className="space-y-5">
      <Toggle
        label="Monitor this repository"
        description="When off, new pull requests and updates in this repository are ignored."
        checked={monitoring}
        onChange={setMonitoring}
      />
      <AiModeRadios value={aiMode} onChange={setAiMode} name={`ai-mode-${repo.id}`} />
      <Field
        label="Paths never sent to AI"
        optional
        hint="One glob per line, e.g. secrets/**, *.pem, infra/terraform/**. Matching files are left out of AI prompts (automated checks still run)."
      >
        <Textarea
          value={exclude}
          onChange={(e) => setExclude(e.target.value)}
          rows={4}
          className="font-mono text-xs"
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={save} loading={update.isPending}>
          Save repository settings
        </Button>
        {update.isSuccess && <InlineResult ok>Saved</InlineResult>}
        {update.isError && <InlineResult ok={false}>{errorMessage(update.error)}</InlineResult>}
      </div>
    </div>
  );
}

const LIST_FIELDS: Array<{ key: keyof RepositoryProfileData & string; label: string }> = [
  { key: 'frameworks', label: 'Frameworks' },
  { key: 'buildTools', label: 'Build tools' },
  { key: 'packageManagers', label: 'Package managers' },
  { key: 'testFrameworks', label: 'Test frameworks' },
  { key: 'ciWorkflows', label: 'CI workflows' },
  { key: 'securityTools', label: 'Security tools' },
  { key: 'architectureDocs', label: 'Architecture docs' },
];

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Shows what was discovered and lets an admin override list fields. */
export function ProfileEditor({
  repo,
  compact = false,
}: {
  repo: RepositoryDetail;
  compact?: boolean;
}) {
  const update = useUpdateRepository();
  const rediscover = useRediscoverRepository();
  const discovered = repo.profile?.discovered ?? {};
  const overrides = repo.profile?.overrides ?? {};
  const initial = () =>
    Object.fromEntries(
      LIST_FIELDS.map((f) => [f.key, asStrings(overrides[f.key]).join(', ')]),
    ) as Record<string, string>;
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const overridesKey = JSON.stringify(overrides);
  useEffect(() => {
    const o = JSON.parse(overridesKey) as RepositoryProfileData;
    setDraft(Object.fromEntries(LIST_FIELDS.map((f) => [f.key, asStrings(o[f.key]).join(', ')])));
  }, [overridesKey]);

  const languages = Object.entries(discovered.languages ?? {}).sort((a, b) => b[1] - a[1]);
  const totalBytes = languages.reduce((s, [, n]) => s + n, 0) || 1;

  const save = () => {
    const next: RepositoryProfileData = { ...overrides };
    for (const f of LIST_FIELDS) {
      const list = linesToList(draft[f.key] ?? '');
      if (list.length) next[f.key] = list;
      else delete next[f.key];
    }
    update.mutate({ id: repo.id, patch: { profileOverrides: next } });
  };

  if (!repo.profile) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-slate-600 dark:text-slate-400">
          This repository has not been scanned yet. Discovery reads its languages, frameworks, CI
          and docs so reports understand its structure.
        </p>
        <Button
          size="sm"
          variant="secondary"
          loading={rediscover.isPending}
          onClick={() => rediscover.mutate(repo.id)}
          icon={<RefreshCw className="size-4" aria-hidden />}
        >
          Scan now
        </Button>
        {rediscover.isSuccess && (
          <InlineResult ok>Scan queued — check back in a minute.</InlineResult>
        )}
        {rediscover.isError && (
          <InlineResult ok={false}>{errorMessage(rediscover.error)}</InlineResult>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {languages.length > 0 && (
        <div>
          <div className="text-sm font-medium">Languages</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {languages.slice(0, 8).map(([lang, bytes]) => (
              <Badge key={lang} tone="blue">
                {lang} {Math.round((bytes / totalBytes) * 100)}%
              </Badge>
            ))}
          </div>
        </div>
      )}
      <div className={`grid gap-4 ${compact ? '' : 'sm:grid-cols-2'}`}>
        {LIST_FIELDS.map((f) => {
          const found = asStrings(discovered[f.key]);
          return (
            <Field
              key={f.key}
              label={f.label}
              optional
              hint={
                found.length
                  ? `Discovered: ${found.join(', ')}`
                  : 'Nothing discovered. Add values if you know them.'
              }
            >
              <Input
                value={draft[f.key] ?? ''}
                placeholder={
                  found.length ? 'Leave empty to use discovered values' : 'Comma-separated'
                }
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              />
            </Field>
          );
        })}
      </div>
      {Array.isArray(discovered.packages) && discovered.packages.length > 0 && (
        <div className="text-sm">
          <span className="font-medium">Packages (monorepo): </span>
          <span className="text-slate-700 dark:text-slate-300">
            {discovered.packages.map((p) => p.name).join(', ')}
          </span>
        </div>
      )}
      <div className="text-xs text-slate-500 dark:text-slate-400">
        Last scanned {timeAgo(repo.lastDiscoveredAt)}
        {repo.profile.headSha ? ` at ${repo.profile.headSha.slice(0, 7)}` : ''}. Overrides replace
        discovered values for that field.
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={save} loading={update.isPending} size="sm">
          Save overrides
        </Button>
        <Button
          size="sm"
          variant="secondary"
          loading={rediscover.isPending}
          onClick={() => rediscover.mutate(repo.id)}
          icon={<RefreshCw className="size-4" aria-hidden />}
        >
          Re-scan repository
        </Button>
        {update.isSuccess && <InlineResult ok>Saved</InlineResult>}
        {update.isError && <InlineResult ok={false}>{errorMessage(update.error)}</InlineResult>}
        {rediscover.isSuccess && <InlineResult ok>Scan queued</InlineResult>}
        {rediscover.isError && (
          <InlineResult ok={false}>{errorMessage(rediscover.error)}</InlineResult>
        )}
      </div>
    </div>
  );
}

export function NoReposHelp() {
  return (
    <Alert tone="info" title="No repositories yet">
      Repositories appear here once the GitHub App is installed on them. Open GitHub settings to
      install the app or grant it access to more repositories, then refresh.
    </Alert>
  );
}
