import { Ban, CheckCircle2, FlaskConical, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { errorMessage } from '../api/client.ts';
import {
  useAiProviders,
  useCreateAiProvider,
  useDeleteAiProvider,
  useTestAiProvider,
  useUpdateAiSettings,
} from '../api/hooks.ts';
import {
  AI_TASKS,
  type AiProvider,
  type AiProviderKind,
  type AiSettings,
  type AiTask,
  type Repository,
  type ModelPriceConfig,
  type TaskModels,
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
} from '../components/ui.tsx';
import { AI_MODE_LABEL, AI_TASK_LABEL, DEFAULT_TASK_MODELS } from '../lib/format.ts';
import { AiModeRadios } from './repos.tsx';

/** Exactly what leaves the server when AI is on. Kept as data so it is testable and reviewable. */
export const DATA_SENT_FULL = [
  'Pull request title, description, labels, branch names and author/reviewer usernames',
  'Titles of linked issues and of related pull requests',
  'File paths changed in the pull request',
  'The changed lines of code (diff hunks) — only for repositories set to “Full”, after removing excluded paths',
  'Names and signatures of changed functions, classes and API routes',
  'Results of the automated checks (findings, risk scores, CI status)',
  'A short repository profile: languages, frameworks, build and test tools',
] as const;

export const DATA_SENT_METADATA_ONLY = [
  'Pull request title, description, labels, branch names and usernames',
  'File paths and names of changed functions, routes and tables',
  'Automated check results and CI status',
  'No code: the diff and file contents are never sent',
] as const;

export const DATA_NEVER_SENT = [
  'Anything from repositories set to “Off”',
  'Files matching a repository’s excluded paths',
  'Secrets detected in code or text (API keys, tokens, private keys, passwords) — they are replaced with [REDACTED] first',
  'Full repository contents (only the parts of a pull request that changed)',
  'Your GitHub App credentials, AI keys, SMTP passwords or Slack webhook URLs',
  'git-merge-pilot user accounts, emails and passwords',
] as const;

export function DataFlowExplainer() {
  return (
    <div className="space-y-4 text-sm">
      <p className="text-slate-700 dark:text-slate-300">
        When AI is on, git-merge-pilot sends parts of each pull request{' '}
        <strong>directly from your server to the AI provider you configure</strong> to write the
        plain-language report. The provider’s own data-retention policy applies. Nothing is sent
        until you enable it here.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <h3 className="flex items-center gap-1.5 font-semibold">
            <CheckCircle2 className="size-4 text-indigo-600" aria-hidden /> Sent in “Full” mode
          </h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-700 dark:text-slate-300">
            {DATA_SENT_FULL.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <h3 className="flex items-center gap-1.5 font-semibold">
            <CheckCircle2 className="size-4 text-sky-600" aria-hidden /> Sent in “Metadata only”
            mode
          </h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-700 dark:text-slate-300">
            {DATA_SENT_METADATA_ONLY.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      </div>
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900 dark:bg-emerald-950/40">
        <h3 className="flex items-center gap-1.5 font-semibold text-emerald-900 dark:text-emerald-200">
          <Ban className="size-4" aria-hidden /> Never sent
        </h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-emerald-900 dark:text-emerald-100">
          {DATA_NEVER_SENT.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </div>
      <p className="text-slate-600 dark:text-slate-400">
        Repository text is treated as data, never as instructions: the AI has no tools and cannot
        act on GitHub. AI output is shown as “Potential concern”, separate from verified facts.
      </p>
    </div>
  );
}

/**
 * Consent screen: explains the data flow, lets the admin choose per-repo AI mode and requires an explicit
 * acknowledgement before AI can be enabled.
 */
export function DataFlowConsent({
  repos,
  onRepoModeChange,
  onEnable,
  onSkip,
  enabling,
  error,
}: {
  repos: Repository[];
  onRepoModeChange: (repo: Repository, mode: Repository['aiMode']) => void;
  onEnable: () => void;
  onSkip?: () => void;
  enabling?: boolean;
  error?: string | null;
}) {
  const [agreed, setAgreed] = useState(false);
  return (
    <div className="space-y-6">
      <DataFlowExplainer />
      {repos.length > 0 && (
        <div className="space-y-3">
          <h3 className="font-semibold">Choose per repository</h3>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            You can change this any time in the repository’s settings.
          </p>
          <ul className="space-y-4">
            {repos.map((r) => (
              <li
                key={r.id}
                className="rounded-lg border border-slate-200 p-3 dark:border-slate-700"
              >
                <div className="mb-2 text-sm font-medium break-all">
                  {r.fullName} <Badge tone="gray">{AI_MODE_LABEL[r.aiMode]}</Badge>
                </div>
                <AiModeRadios
                  value={r.aiMode}
                  onChange={(m) => onRepoModeChange(r, m)}
                  name={`consent-mode-${r.id}`}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-900 dark:bg-indigo-950/40">
        <Checkbox
          checked={agreed}
          onChange={setAgreed}
          label="I understand what will be sent to the AI provider and I am allowed to share it."
          description="Required to turn AI on. Recorded with your name and the time in the audit log."
        />
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={onEnable}
          disabled={!agreed}
          loading={enabling ?? false}
          icon={<ShieldCheck className="size-4" aria-hidden />}
        >
          Enable AI analysis
        </Button>
        {onSkip && (
          <Button variant="secondary" onClick={onSkip}>
            Keep AI off for now
          </Button>
        )}
      </div>
    </div>
  );
}

const KIND_LABEL: Record<AiProviderKind, string> = {
  anthropic: 'Anthropic (Claude)',
  openai_compatible: 'OpenAI-compatible (OpenAI, Azure, OpenRouter, Ollama, vLLM, LiteLLM…)',
};

export function ProviderForm({ onCreated }: { onCreated?: (p: AiProvider) => void }) {
  const create = useCreateAiProvider();
  const [kind, setKind] = useState<AiProviderKind>('anthropic');
  const [name, setName] = useState('Anthropic');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const needsBaseUrl = kind === 'openai_compatible';

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      { kind, name: name.trim(), apiKey, baseUrl: baseUrl.trim() || null },
      {
        onSuccess: (p) => {
          setApiKey('');
          onCreated?.(p);
        },
      },
    );
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Provider type">
          <Select
            value={kind}
            onChange={(e) => {
              const k = e.target.value as AiProviderKind;
              setKind(k);
              setName(k === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible');
            }}
          >
            {(Object.keys(KIND_LABEL) as AiProviderKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Display name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field
          label="Base URL"
          optional={!needsBaseUrl}
          hint={
            needsBaseUrl
              ? 'e.g. https://api.openai.com/v1 or http://localhost:11434/v1'
              : 'Only needed for a proxy or gateway.'
          }
        >
          <Input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            required={needsBaseUrl}
            placeholder="https://…"
          />
        </Field>
        <Field label="API key" hint="Stored encrypted on your server. It is never shown again.">
          <Input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            required={kind === 'anthropic'}
          />
        </Field>
      </div>
      {create.isError && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
      <Button
        type="submit"
        loading={create.isPending}
        disabled={
          !name.trim() || (kind === 'anthropic' && !apiKey) || (needsBaseUrl && !baseUrl.trim())
        }
        icon={<Plus className="size-4" aria-hidden />}
      >
        Add provider
      </Button>
    </form>
  );
}

function ProviderRow({ provider }: { provider: AiProvider }) {
  const test = useTestAiProvider();
  const del = useDeleteAiProvider();
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 p-3">
      <div className="min-w-0">
        <div className="font-medium">{provider.name}</div>
        <div className="text-xs break-all text-slate-600 dark:text-slate-400">
          {KIND_LABEL[provider.kind].split(' (')[0]}
          {provider.baseUrl ? ` · ${provider.baseUrl}` : ''} · key{' '}
          {provider.apiKeyConfigured ? 'configured' : 'missing'}
        </div>
        {test.data && (
          <div className="mt-1">
            <InlineResult ok={test.data.ok}>
              {test.data.ok
                ? `Connection works${test.data.latencyMs ? ` (${test.data.latencyMs} ms)` : ''}`
                : (test.data.error ?? 'Test failed')}
            </InlineResult>
          </div>
        )}
        {test.isError && (
          <div className="mt-1">
            <InlineResult ok={false}>{errorMessage(test.error)}</InlineResult>
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => test.mutate(provider.id)}
          loading={test.isPending}
          icon={<FlaskConical className="size-4" aria-hidden />}
        >
          Test
        </Button>
        <ConfirmButton
          title={`Remove ${provider.name}?`}
          message="Tasks using this provider will stop using AI until you pick another provider."
          confirmLabel="Remove"
          onConfirm={() => del.mutateAsync(provider.id).catch(() => undefined)}
          loading={del.isPending}
          icon={<Trash2 className="size-4" aria-hidden />}
        >
          Remove
        </ConfirmButton>
      </div>
    </li>
  );
}

export function ProviderManager() {
  const providers = useAiProviders();
  const [adding, setAdding] = useState(false);
  const list = providers.data ?? [];
  return (
    <div className="space-y-4">
      {providers.isError && <Alert tone="danger">{errorMessage(providers.error)}</Alert>}
      {list.length > 0 && (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
          {list.map((p) => (
            <ProviderRow key={p.id} provider={p} />
          ))}
        </ul>
      )}
      {adding || (!providers.isPending && list.length === 0) ? (
        <ProviderForm onCreated={() => setAdding(false)} />
      ) : (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setAdding(true)}
          icon={<Plus className="size-4" aria-hidden />}
        >
          Add another provider
        </Button>
      )}
    </div>
  );
}

export function defaultTaskModels(providers: AiProvider[], current: TaskModels): TaskModels {
  const first = providers[0];
  const out: TaskModels = { ...current };
  if (!first) return out;
  for (const task of AI_TASKS) {
    if (out[task] && providers.some((p) => p.id === out[task]?.providerId)) continue;
    const d = DEFAULT_TASK_MODELS[task];
    out[task] = {
      providerId: first.id,
      model: first.kind === 'anthropic' ? d.anthropic : '',
      maxOutputTokens: d.maxOutputTokens,
    };
  }
  return out;
}

/** Model per task + monthly budget. Saves via PUT /api/settings/ai. */
export function ModelsAndBudgetForm({
  settings,
  onSaved,
  submitLabel = 'Save AI settings',
}: {
  settings: AiSettings;
  onSaved?: () => void;
  submitLabel?: string;
}) {
  const providers = useAiProviders();
  const save = useUpdateAiSettings();
  const list = providers.data ?? [];
  const [models, setModels] = useState<TaskModels>(settings.taskModels ?? {});
  const [budget, setBudget] = useState(String(settings.monthlyBudgetUsd ?? 100));
  const [alertPct, setAlertPct] = useState(String(settings.alertThresholdPct ?? 80));
  const [maxTokens, setMaxTokens] = useState(String(settings.maxInputTokensPerCall ?? 120000));

  const providerIds = list.map((p) => p.id).join(',');
  useEffect(() => {
    if (list.length) setModels((m) => defaultTaskModels(list, m));
  }, [providerIds]);

  const setTask = (task: AiTask, patch: Partial<NonNullable<TaskModels[AiTask]>>) =>
    setModels((m) => {
      const cur = m[task] ?? {
        providerId: list[0]?.id ?? '',
        model: '',
        maxOutputTokens: DEFAULT_TASK_MODELS[task].maxOutputTokens,
      };
      return { ...m, [task]: { ...cur, ...patch } };
    });

  /** Sets one price field; a price is only kept when both input and output are filled in. */
  const setPrice = (task: AiTask, field: 'inputPerMTok' | 'outputPerMTok', raw: string) =>
    setModels((m) => {
      const cur = m[task];
      if (!cur) return m;
      const value = raw.trim() === '' ? undefined : Number(raw);
      const draft = { ...(cur.price ?? {}), [field]: value } as Partial<ModelPriceConfig>;
      const { price: _old, ...rest } = cur;
      const empty = draft.inputPerMTok === undefined && draft.outputPerMTok === undefined;
      return { ...m, [task]: empty ? rest : { ...rest, price: draft as ModelPriceConfig } };
    });
  const incompletePrice = AI_TASKS.some((t) => {
    const p = models[t]?.price;
    return (
      p !== undefined &&
      !(
        Number.isFinite(p.inputPerMTok) &&
        p.inputPerMTok >= 0 &&
        Number.isFinite(p.outputPerMTok) &&
        p.outputPerMTok >= 0
      )
    );
  });

  const budgetNum = Number(budget);
  const pctNum = Number(alertPct);
  const tokensNum = Number(maxTokens);
  const invalid =
    !Number.isFinite(budgetNum) ||
    budgetNum < 0 ||
    !Number.isFinite(pctNum) ||
    pctNum < 1 ||
    pctNum > 100 ||
    !Number.isInteger(tokensNum) ||
    tokensNum < 1000;
  const missingModel = list.length > 0 && AI_TASKS.some((t) => !models[t]?.model.trim());

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (invalid) return;
    save.mutate(
      {
        taskModels: models,
        monthlyBudgetUsd: budgetNum,
        alertThresholdPct: pctNum,
        maxInputTokensPerCall: tokensNum,
      },
      { onSuccess: () => onSaved?.() },
    );
  };

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div>
        <h3 className="font-semibold">Model per task</h3>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Smaller models are cheaper for frequent tasks; larger models are used only for deep,
          high-risk analysis.
        </p>
        {list.length === 0 ? (
          <Alert tone="info" className="mt-3">
            Add an AI provider first.
          </Alert>
        ) : (
          <div className="mt-3 space-y-3">
            {AI_TASKS.map((task) => {
              const cfg = models[task];
              return (
                <fieldset
                  key={task}
                  className="grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-[1fr_1fr_8rem] lg:grid-cols-[1fr_1fr_8rem_9rem_9rem] dark:border-slate-700"
                >
                  <legend className="px-1 text-sm font-medium">{AI_TASK_LABEL[task]}</legend>
                  <Field label="Provider">
                    <Select
                      value={cfg?.providerId ?? ''}
                      onChange={(e) => setTask(task, { providerId: e.target.value })}
                    >
                      {list.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Model">
                    <Input
                      value={cfg?.model ?? ''}
                      onChange={(e) => setTask(task, { model: e.target.value })}
                      placeholder={DEFAULT_TASK_MODELS[task].anthropic}
                      required
                    />
                  </Field>
                  <Field label="Max output tokens">
                    <Input
                      type="number"
                      min={256}
                      max={64000}
                      value={cfg?.maxOutputTokens ?? DEFAULT_TASK_MODELS[task].maxOutputTokens}
                      onChange={(e) => setTask(task, { maxOutputTokens: Number(e.target.value) })}
                    />
                  </Field>
                  <Field
                    label="Input price (USD / 1M tokens)"
                    hint="Needed for models not in the built-in price list."
                  >
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={cfg?.price?.inputPerMTok ?? ''}
                      onChange={(e) => setPrice(task, 'inputPerMTok', e.target.value)}
                    />
                  </Field>
                  <Field label="Output price (USD / 1M tokens)">
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={cfg?.price?.outputPerMTok ?? ''}
                      onChange={(e) => setPrice(task, 'outputPerMTok', e.target.value)}
                    />
                  </Field>
                </fieldset>
              );
            })}
          </div>
        )}
      </div>
      <div>
        <h3 className="font-semibold">Monthly budget</h3>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          When the budget is reached, AI calls stop and reports continue from automated analysis,
          with a visible notice.
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <Field label="Monthly budget (USD)">
            <Input
              type="number"
              min={0}
              step="1"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
          </Field>
          <Field label="Alert at (% of budget)">
            <Input
              type="number"
              min={1}
              max={100}
              value={alertPct}
              onChange={(e) => setAlertPct(e.target.value)}
            />
          </Field>
          <Field
            label="Max input tokens per call"
            hint="Larger diffs are trimmed, most important files first."
          >
            <Input
              type="number"
              min={1000}
              step={1000}
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
            />
          </Field>
        </div>
      </div>
      {settings.unpricedModels && settings.unpricedModels.length > 0 && (
        <Alert tone="warning" title="AI is skipped for models without a price">
          No price is known for {settings.unpricedModels.join(', ')}. Their spend cannot be counted
          against the monthly budget, so AI is not used for those tasks until you enter the
          model&apos;s input and output price above.
        </Alert>
      )}
      {incompletePrice && (
        <Alert tone="warning">
          Enter both the input and the output price, or leave both empty.
        </Alert>
      )}
      {invalid && (
        <Alert tone="warning">
          Check the budget values: budget ≥ 0, alert between 1 and 100, max tokens ≥ 1000.
        </Alert>
      )}
      {save.isError && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          loading={save.isPending}
          disabled={invalid || missingModel || incompletePrice}
        >
          {submitLabel}
        </Button>
        {missingModel && (
          <span className="text-sm text-amber-700 dark:text-amber-400">
            Enter a model name for every task.
          </span>
        )}
        {save.isSuccess && <InlineResult ok>Saved</InlineResult>}
      </div>
    </form>
  );
}
