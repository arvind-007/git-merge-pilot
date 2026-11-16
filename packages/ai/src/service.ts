import {
  AI_TASKS,
  createLogger,
  decrypt,
  TaskModelsSchema,
  type AiMode,
  type AiTask,
  type AiUsageSummary,
  type Logger,
  type PrReport,
  type TaskModels,
} from '@gmp/core';
import {
  aiProviders,
  aiSettings,
  aiUsage,
  organizations,
  type AiProviderRow,
  type AiSettingsRow,
  type Database,
} from '@gmp/db';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import {
  AI_RELATIONSHIPS_JSON_SCHEMA,
  AI_REPORT_JSON_SCHEMA,
  AI_TRIAGE_JSON_SCHEMA,
  AiRelationshipVerdictsSchema,
  AiReportOutputSchema,
  AiTriageOutputSchema,
} from './ai-output.ts';
import { monthWindow } from './budget.ts';
import { buildDeterministicReport } from './deterministic.ts';
import { mergeAiReport, sanitizeAiText } from './merge.ts';
import {
  DEFAULT_ANTHROPIC_MODELS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  estimateCostUsd,
  hasModelPrice,
  normalizeModelId,
  type ModelPrice,
} from './pricing.ts';
import {
  buildReportPrompt,
  DEFAULT_MAX_INPUT_TOKENS,
  DIGEST_SYSTEM_PROMPT,
  RELATIONSHIP_SYSTEM_PROMPT,
  TRIAGE_SYSTEM_PROMPT,
} from './prompt.ts';
import { createProvider } from './providers/index.ts';
import type { ReportInput } from './report-input.ts';
import {
  buildDigestMessage,
  buildRelationshipMessage,
  buildTriageMessage,
  deterministicTriage,
  renderDeterministicDigest,
  type ConfirmedRelationship,
  type DigestInput,
  type RelationshipCandidate,
  type TriageInput,
  type TriageResult,
} from './tasks.ts';
import {
  AiError,
  type AiCompletionRequest,
  type AiCompletionResult,
  type AiProvider,
  type ProviderConfig,
} from './types.ts';

export interface BudgetStatus {
  spentUsd: number;
  capUsd: number;
  /** Percent of the cap spent (100 when the cap is 0). */
  pct: number;
  exhausted: boolean;
  /** True when pct ≥ alert threshold. */
  alert: boolean;
  alertThresholdPct: number;
  periodStart: Date;
  periodEnd: Date;
  timeZone: string;
}

export interface AiServiceOptions {
  db: Database;
  orgId: string;
  logger?: Logger;
  /** Builds provider adapters from decrypted config (override in tests with a fake). */
  providerFactory?: (config: ProviderConfig & { providerId: string }) => AiProvider;
  /** Master key for decrypting provider API keys (defaults to core's configured key / MASTER_KEY). */
  masterKey?: Buffer;
  now?: () => Date;
  /** Extra model prices (merged over the built-in table). */
  prices?: Record<string, ModelPrice>;
  /** Price applied to unknown models (default 0 with a warning). */
  fallbackPrice?: ModelPrice;
}

export interface RepoAiTarget {
  aiMode?: AiMode | null;
}

export interface GenerateReportResult {
  report: PrReport;
  /** Null when no AI call was made. */
  usage: AiUsageSummary | null;
}

interface TaskTarget {
  providerId: string;
  providerKind: AiProviderRow['kind'];
  model: string;
  maxOutputTokens: number;
}

interface UsageContext {
  pullRequestId?: string | null;
  analysisId?: string | null;
}

interface LoadedState {
  settings: AiSettingsRow | null;
  taskModels: TaskModels;
  providers: AiProviderRow[];
  timezone: string;
  budget: BudgetStatus;
}

const AI_TASK_EFFORT: Record<AiTask, AiCompletionRequest['effort']> = {
  triage: 'low',
  digest: 'low',
  pr_report: 'medium',
  deep_analysis: 'high',
};

/**
 * Org-scoped AI facade (design §9). Reads ai_settings / ai_providers, enforces consent, per-repo ai_mode and the
 * monthly budget, records ai_usage, and always falls back to deterministic output when AI is unavailable or fails.
 */
export class AiService {
  private readonly db: Database;
  readonly orgId: string;
  private readonly logger: Logger;
  private readonly providerFactory: NonNullable<AiServiceOptions['providerFactory']>;
  private readonly masterKey: Buffer | undefined;
  private readonly now: () => Date;
  private readonly prices: Record<string, ModelPrice> | undefined;
  private readonly fallbackPrice: ModelPrice | undefined;
  private state: LoadedState | null = null;
  private readonly providerCache = new Map<string, AiProvider>();

  constructor(opts: AiServiceOptions) {
    this.db = opts.db;
    this.orgId = opts.orgId;
    this.logger = opts.logger ?? createLogger('ai', { bindings: { orgId: opts.orgId } });
    this.providerFactory = opts.providerFactory ?? ((cfg) => createProvider(cfg));
    this.masterKey = opts.masterKey;
    this.now = opts.now ?? (() => new Date());
    this.prices = opts.prices;
    this.fallbackPrice = opts.fallbackPrice;
  }

  /** Creates the service and loads settings/budget so `isEnabledFor` can be used synchronously. */
  static async create(opts: AiServiceOptions): Promise<AiService> {
    const svc = new AiService(opts);
    await svc.refresh();
    return svc;
  }

  /** (Re)loads settings, providers, org timezone and the current-month spend. */
  async refresh(): Promise<void> {
    const [settingsRows, providerRows, orgRows] = await Promise.all([
      this.db.select().from(aiSettings).where(eq(aiSettings.orgId, this.orgId)).limit(1),
      this.db.select().from(aiProviders).where(eq(aiProviders.orgId, this.orgId)),
      this.db
        .select({ timezone: organizations.timezone })
        .from(organizations)
        .where(eq(organizations.id, this.orgId))
        .limit(1),
    ]);
    const settings = settingsRows[0] ?? null;
    const parsedModels = TaskModelsSchema.safeParse(settings?.taskModels ?? {});
    if (!parsedModels.success)
      this.logger.warn('ai_settings.task_models is invalid; using defaults');
    const timezone = orgRows[0]?.timezone ?? 'UTC';
    const budget = await this.computeBudget(settings, timezone);
    this.state = {
      settings,
      taskModels: parsedModels.success ? parsedModels.data : {},
      providers: providerRows,
      timezone,
      budget,
    };
    this.providerCache.clear();
  }

  private async ensureLoaded(): Promise<LoadedState> {
    if (!this.state) await this.refresh();
    return this.state!;
  }

  private async computeBudget(
    settings: AiSettingsRow | null,
    timezone: string,
  ): Promise<BudgetStatus> {
    const { start, end, timeZone } = monthWindow(this.now(), timezone);
    const rows = await this.db
      .select({ spent: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float8`.mapWith(Number) })
      .from(aiUsage)
      .where(
        and(
          eq(aiUsage.orgId, this.orgId),
          gte(aiUsage.occurredAt, start),
          lt(aiUsage.occurredAt, end),
        ),
      );
    const spentUsd = Math.round((rows[0]?.spent ?? 0) * 1e6) / 1e6;
    const capUsd = settings?.monthlyBudgetUsd ?? 100;
    const alertThresholdPct = settings?.alertThresholdPct ?? 80;
    const pct = capUsd > 0 ? (spentUsd / capUsd) * 100 : 100;
    return {
      spentUsd,
      capUsd,
      pct: Math.round(pct * 100) / 100,
      exhausted: capUsd <= 0 || spentUsd >= capUsd,
      alert: pct >= alertThresholdPct,
      alertThresholdPct,
      periodStart: start,
      periodEnd: end,
      timeZone,
    };
  }

  /** Current-month spend vs. cap, computed from ai_usage in the org timezone. Always queries fresh. */
  async budgetStatus(): Promise<BudgetStatus> {
    const state = await this.ensureLoaded();
    const budget = await this.computeBudget(state.settings, state.timezone);
    state.budget = budget;
    return budget;
  }

  private resolveTask(task: AiTask): TaskTarget | null {
    const state = this.state;
    if (!state) return null;
    const enabledProviders = state.providers.filter((p) => p.enabled);
    const cfg = state.taskModels[task];
    if (cfg) {
      const row = enabledProviders.find((p) => p.id === cfg.providerId);
      if (!row) return null;
      return {
        providerId: row.id,
        providerKind: row.kind,
        model: cfg.model,
        maxOutputTokens: cfg.maxOutputTokens,
      };
    }
    // No explicit config: an enabled Anthropic provider with the default model for the task,
    // else reuse the model configured for another task on the same provider.
    const anthropic = enabledProviders.find((p) => p.kind === 'anthropic');
    if (anthropic) {
      return {
        providerId: anthropic.id,
        providerKind: 'anthropic',
        model: DEFAULT_ANTHROPIC_MODELS[task],
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS[task],
      };
    }
    const fallbackOrder: AiTask[] =
      task === 'deep_analysis'
        ? ['pr_report', 'triage', 'digest']
        : ['pr_report', 'deep_analysis', 'triage', 'digest'];
    for (const other of fallbackOrder) {
      const o = state.taskModels[other];
      const row = o && enabledProviders.find((p) => p.id === o.providerId);
      if (o && row) {
        return {
          providerId: row.id,
          providerKind: row.kind,
          model: o.model,
          maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS[task],
        };
      }
    }
    return null;
  }

  /**
   * Why AI cannot be used for this repo/task, as a plain-language limitation, or null when it can.
   * Uses the state loaded by `refresh()`/`create()`.
   */
  disabledReason(repo: RepoAiTarget | null, task: AiTask = 'pr_report'): string | null {
    const s = this.state;
    if (!s) return 'AI settings have not been loaded.';
    if (!s.settings?.enabled)
      return 'AI is not enabled for this organization; the report was produced from automated analysis only.';
    if (!s.settings.consentAt)
      return 'AI data-sharing consent has not been given; the report was produced from automated analysis only.';
    if (repo && (repo.aiMode ?? 'full') === 'off')
      return 'AI is disabled for this repository; the report was produced from automated analysis only.';
    if (s.budget.exhausted)
      return 'AI budget reached for this month; the report was produced from automated analysis only.';
    const target = this.resolveTask(task);
    if (!target)
      return 'No enabled AI provider/model is configured for this task; the report was produced from automated analysis only.';
    if (!this.isPriced(target.model))
      return `No price is configured for the AI model "${target.model}", so its spend cannot be counted against the monthly budget and AI is not used; the report was produced from automated analysis only. An administrator can set the model's price in Settings → AI.`;
    return null;
  }

  /** Built-in prices, prices passed in and prices configured per task model (admin). */
  private allPrices(): Record<string, ModelPrice> {
    const out: Record<string, ModelPrice> = { ...(this.prices ?? {}) };
    for (const cfg of Object.values(this.state?.taskModels ?? {})) {
      if (cfg?.price) {
        out[cfg.model] = cfg.price;
        out[normalizeModelId(cfg.model)] = cfg.price;
      }
    }
    return out;
  }

  private isPriced(model: string): boolean {
    return Boolean(this.fallbackPrice) || hasModelPrice(model, this.allPrices());
  }

  /**
   * Configured models without a known price. AI calls with them are skipped (spend could not be
   * enforced against the budget); shown on the AI settings and status pages.
   */
  unpricedModels(): string[] {
    const out = new Set<string>();
    for (const task of AI_TASKS) {
      const target = this.resolveTask(task);
      if (target && !this.isPriced(target.model)) out.add(target.model);
    }
    return [...out];
  }

  /** Org enabled + consent + repo ai_mode != off + budget remaining + a provider configured (cached state). */
  isEnabledFor(repo: RepoAiTarget | null, task: AiTask = 'pr_report'): boolean {
    return this.disabledReason(repo, task) === null;
  }

  private getProvider(target: TaskTarget): AiProvider {
    const cached = this.providerCache.get(target.providerId);
    if (cached) return cached;
    const row = this.state?.providers.find((p) => p.id === target.providerId);
    if (!row) throw new AiError('not_configured', 'AI provider not found');
    let apiKey = '';
    if (row.apiKeyEnc) {
      try {
        apiKey = decrypt(row.apiKeyEnc, this.masterKey);
      } catch (err) {
        throw new AiError(
          'not_configured',
          'AI provider API key could not be decrypted (check MASTER_KEY)',
          { cause: err },
        );
      }
    }
    const provider = this.providerFactory({
      providerId: row.id,
      kind: row.kind,
      apiKey,
      baseUrl: row.baseUrl,
    });
    this.providerCache.set(row.id, provider);
    return provider;
  }

  private async recordUsage(
    task: AiTask,
    target: TaskTarget,
    model: string,
    usage: AiCompletionResult['usage'],
    ctx: UsageContext,
  ): Promise<number> {
    const prices = this.allPrices();
    // Providers may answer with a dated/aliased id; fall back to the configured model's price.
    const pricedModel = hasModelPrice(model, prices) ? model : target.model;
    const costUsd = estimateCostUsd(pricedModel, usage, {
      logger: this.logger,
      prices,
      ...(this.fallbackPrice ? { fallback: this.fallbackPrice } : {}),
    });
    try {
      await this.db.insert(aiUsage).values({
        orgId: this.orgId,
        task,
        providerKind: target.providerKind,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        costUsd,
        pullRequestId: ctx.pullRequestId ?? null,
        analysisId: ctx.analysisId ?? null,
        occurredAt: this.now(),
      });
      if (this.state) {
        const b = this.state.budget;
        const spentUsd = b.spentUsd + costUsd;
        const pct = b.capUsd > 0 ? (spentUsd / b.capUsd) * 100 : 100;
        this.state.budget = {
          ...b,
          spentUsd,
          pct: Math.round(pct * 100) / 100,
          exhausted: b.capUsd <= 0 || spentUsd >= b.capUsd,
          alert: pct >= b.alertThresholdPct,
        };
      }
    } catch (err) {
      this.logger.error({ err, task, model }, 'failed to record AI usage');
    }
    return costUsd;
  }

  /**
   * Runs one AI call for a task: re-checks the budget, resolves provider/model, records usage (also for failed
   * calls that consumed tokens). Throws AiError on any failure.
   */
  private async run(
    task: AiTask,
    build: (target: TaskTarget) => Omit<AiCompletionRequest, 'model' | 'maxOutputTokens'>,
    ctx: UsageContext,
  ): Promise<{ result: AiCompletionResult; usage: AiUsageSummary }> {
    const budget = await this.budgetStatus();
    if (budget.exhausted) throw new AiError('not_configured', 'AI budget exhausted');
    const target = this.resolveTask(task);
    if (!target) throw new AiError('not_configured', `no AI model configured for task ${task}`);
    if (!this.isPriced(target.model))
      throw new AiError('not_configured', `no price configured for AI model ${target.model}`);
    const provider = this.getProvider(target);
    const req: AiCompletionRequest = {
      effort: AI_TASK_EFFORT[task],
      ...build(target),
      model: target.model,
      maxOutputTokens: target.maxOutputTokens,
    };
    try {
      const result = await provider.complete(req);
      const model = result.model ?? target.model;
      const costUsd = await this.recordUsage(task, target, model, result.usage, ctx);
      return {
        result,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cacheReadTokens,
          costUsd,
          calls: 1,
          model,
        },
      };
    } catch (err) {
      if (err instanceof AiError && err.usage) {
        await this.recordUsage(task, target, err.model ?? target.model, err.usage, ctx);
      }
      throw err;
    }
  }

  private failureNote(err: unknown): string {
    if (err instanceof AiError) {
      switch (err.code) {
        case 'refusal':
          return 'The AI provider declined to analyse this PR; the report was produced from automated analysis only.';
        case 'max_tokens':
          return 'The AI response was cut off before completion; the report was produced from automated analysis only.';
        case 'invalid_json':
        case 'empty_response':
          return 'The AI response could not be used; the report was produced from automated analysis only.';
        case 'not_configured':
          return 'AI is not available for this PR; the report was produced from automated analysis only.';
        case 'api_error':
          return 'The AI provider could not be reached; the report was produced from automated analysis only.';
      }
    }
    return 'AI analysis failed; the report was produced from automated analysis only.';
  }

  /**
   * Produces the PR report: AI narrative merged onto deterministic facts when AI is enabled for the repo,
   * otherwise (or on any failure) the deterministic report. Never throws for AI problems.
   */
  async generateReport(input: ReportInput): Promise<GenerateReportResult> {
    await this.ensureLoaded();
    await this.budgetStatus();
    const reason = this.disabledReason(input.repo, 'pr_report');
    if (reason) return { report: buildDeterministicReport(input, { reason }), usage: null };

    const maxInputTokens = this.state?.settings?.maxInputTokensPerCall ?? DEFAULT_MAX_INPUT_TOKENS;
    const prompt = buildReportPrompt(input, { maxInputTokens });
    let usage: AiUsageSummary | null = null;
    try {
      const out = await this.run(
        'pr_report',
        () => ({
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }],
          jsonSchema: AI_REPORT_JSON_SCHEMA,
          jsonSchemaName: 'pr_report',
          cacheSystem: true,
        }),
        { pullRequestId: input.pullRequestId ?? null, analysisId: input.analysisId ?? null },
      );
      usage = out.usage;
      const parsed = AiReportOutputSchema.safeParse(out.result.json);
      if (!parsed.success)
        throw new AiError('invalid_json', 'AI report output failed schema validation');
      const report = mergeAiReport(input, parsed.data, { limitations: prompt.limitations });
      return { report, usage };
    } catch (err) {
      this.logger.warn(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message, code: (err as AiError).code }
              : String(err),
          pr: input.pr.number,
        },
        'AI report generation failed; using deterministic report',
      );
      const report = buildDeterministicReport(input, { reason: this.failureNote(err) });
      return { report, usage };
    }
  }

  /** Decides whether new changes warrant regenerating the narrative. Falls back to rule-based triage. */
  async triage(input: TriageInput): Promise<TriageResult> {
    await this.ensureLoaded();
    const fallback = deterministicTriage(input);
    // Rule-based answers that are certain need no AI call.
    if ((input.newFindings ?? 0) > 0 || input.changedFiles.length === 0) return fallback;
    if (!this.isEnabledFor(input.repo, 'triage')) return fallback;
    try {
      const msg = buildTriageMessage(input, {
        maxInputTokens: this.state?.settings?.maxInputTokensPerCall ?? DEFAULT_MAX_INPUT_TOKENS,
      });
      const out = await this.run(
        'triage',
        () => ({
          system: TRIAGE_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: msg.user }],
          jsonSchema: AI_TRIAGE_JSON_SCHEMA,
          jsonSchemaName: 'triage',
          cacheSystem: true,
        }),
        { pullRequestId: input.pullRequestId ?? null, analysisId: input.analysisId ?? null },
      );
      const parsed = AiTriageOutputSchema.safeParse(out.result.json);
      if (!parsed.success)
        throw new AiError('invalid_json', 'AI triage output failed schema validation');
      return {
        meaningful: parsed.data.meaningful,
        reason: sanitizeAiText(parsed.data.reason, 500),
        generatedBy: 'ai',
      };
    } catch (err) {
      this.logger.warn({ err: errSummary(err) }, 'AI triage failed; using rule-based triage');
      return fallback;
    }
  }

  /**
   * Reviews duplicate-work / semantic-overlap candidates with the deep model. Returns the candidates judged related
   * (confidence never above the static candidate's; AI cannot raise it). When AI is unavailable for either PR's repo
   * the candidates are returned unchanged.
   */
  async confirmRelationships(
    candidates: RelationshipCandidate[],
  ): Promise<ConfirmedRelationship[]> {
    await this.ensureLoaded();
    if (candidates.length === 0) return [];
    const eligible: number[] = [];
    const passthrough: ConfirmedRelationship[] = [];
    candidates.forEach((c, i) => {
      if (
        this.isEnabledFor(c.prA.repo, 'deep_analysis') &&
        this.isEnabledFor(c.prB.repo, 'deep_analysis')
      )
        eligible.push(i);
      else passthrough.push({ ...c });
    });
    if (eligible.length === 0) return passthrough;
    const batch = eligible.map((i) => candidates[i]!);
    try {
      const msg = buildRelationshipMessage(batch, {
        maxInputTokens: this.state?.settings?.maxInputTokensPerCall ?? DEFAULT_MAX_INPUT_TOKENS,
      });
      const out = await this.run(
        'deep_analysis',
        () => ({
          system: RELATIONSHIP_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: msg.user }],
          jsonSchema: AI_RELATIONSHIPS_JSON_SCHEMA,
          jsonSchemaName: 'relationships',
          cacheSystem: true,
        }),
        {},
      );
      const parsed = AiRelationshipVerdictsSchema.safeParse(out.result.json);
      if (!parsed.success)
        throw new AiError('invalid_json', 'AI relationship output failed schema validation');
      const verdicts = new Map(parsed.data.verdicts.map((v) => [v.index, v]));
      const reviewed: ConfirmedRelationship[] = [];
      batch.forEach((c, idx) => {
        const v = verdicts.get(idx);
        if (!v) {
          reviewed.push({ ...c });
          return;
        }
        if (!v.related) return;
        // AI review may keep, lower or drop a candidate, never raise it: duplicate work found
        // only by AI inference stays 'possible' (design §8, §16).
        const confidence = lowerConfidence(c.confidence, v.confidence);
        reviewed.push({
          ...c,
          confidence,
          summary: sanitizeAiText(v.summary, 600) || c.summary,
          ai: { related: true, rationale: sanitizeAiText(v.rationale, 800) },
        });
      });
      return [...passthrough, ...reviewed];
    } catch (err) {
      this.logger.warn(
        { err: errSummary(err) },
        'AI relationship confirmation failed; keeping static candidates',
      );
      return [...passthrough, ...batch.map((c) => ({ ...c }))];
    }
  }

  /** Writes the digest narrative (plain text). Falls back to a deterministic digest. */
  async writeDigest(input: DigestInput): Promise<string> {
    await this.ensureLoaded();
    const fallback = renderDeterministicDigest(input);
    if (
      !this.isEnabledFor(null, 'digest') ||
      input.items.every((i) => i.aiMode === 'off') ||
      input.items.length === 0
    )
      return fallback;
    try {
      const msg = buildDigestMessage(input);
      const out = await this.run(
        'digest',
        () => ({
          system: DIGEST_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: msg.user }],
          cacheSystem: true,
        }),
        {},
      );
      const text = sanitizeAiText(out.result.text, 6_000);
      return text || fallback;
    } catch (err) {
      this.logger.warn({ err: errSummary(err) }, 'AI digest failed; using deterministic digest');
      return fallback;
    }
  }
}

const CONFIDENCE_RANK = { possible: 0, likely: 1, confirmed: 2 } as const;

/** The less certain of two confidences. */
export function lowerConfidence<C extends keyof typeof CONFIDENCE_RANK>(a: C, b: C): C {
  return CONFIDENCE_RANK[b] < CONFIDENCE_RANK[a] ? b : a;
}

function errSummary(err: unknown) {
  return err instanceof Error
    ? { name: err.name, message: err.message, code: (err as Partial<AiError>).code }
    : String(err);
}
