# git-merge-pilot — Design (MVP)

Status: approved by owner 2026-11-14 ("go with your recommendations"). This document is the **build contract** for all implementers. Product name is always `git-merge-pilot` (never "MergePilot").

## 1. Intent

A self-hosted, open-source (Apache-2.0) GitHub PR intelligence platform. A project manager clones it, runs it, connects GitHub via a GitHub App created in one click, groups repositories into projects, and gets an evidence-backed, plain-language report for every PR: summary, business impact, breaking changes, security, cross-PR overlap, merge readiness and risk. It **never writes to GitHub** (read-only permissions; no comments, approvals or merges).

Primary reader is non-developer: every report leads with plain language; technical evidence (file/line links) follows. Always distinguish **verified facts** (from deterministic analysis / GitHub data) from **potential concerns** (AI inference). Never claim a PR is "secure".

### Goals (MVP)

Easy first-time setup; GitHub App connection; dynamic projects; dynamic repo selection; multi-repo monitoring via webhooks; AI PR reports; breaking-change detection; security analysis; cross-PR overlap detection (incl. cross-repo via contracts); merge readiness + risk scores; incremental analysis; dashboard; daily digest; encrypted credentials.

### Non-goals (MVP)

SaaS/multi-tenant UI (but schema is tenant-ready), GitHub Enterprise Server (base URL configurable only), GitHub write actions, Jira/Linear, Telegram, natural-language assistant (Phase 2), full dependency graph visualisation (Phase 2), SSO.

### Anti-goals

Hardcoded repos/orgs/languages; speculative relationships shown as confirmed conflicts; silent failure (budget exhaustion, webhook failure, AI failure must be visible); repo content able to steer the AI or trigger actions; code sent to an AI provider without explicit admin opt-in.

## 2. Decisions

| Area                 | Decision                                                                                                                                                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenancy              | Self-hosted, one organization per install, multiple users. **Every tenant-owned table has `org_id`** (FK organizations). All queries filter by `org_id`.                                                                                                                                              |
| Roles                | `admin` (everything) and `member` (only projects they are a member of).                                                                                                                                                                                                                               |
| Language             | TypeScript (strict, ESM), Node 22, pnpm workspaces.                                                                                                                                                                                                                                                   |
| Backend              | Fastify 5.                                                                                                                                                                                                                                                                                            |
| Frontend             | React 18 + Vite + React Router + TanStack Query + Tailwind CSS. Built SPA served by the server at `/`.                                                                                                                                                                                                |
| DB                   | Postgres 16 (+pgvector image, extension optional), Drizzle ORM + drizzle-kit SQL migrations.                                                                                                                                                                                                          |
| Queue                | pg-boss (Postgres-backed). Retries with exponential backoff, singleton keys for dedup.                                                                                                                                                                                                                |
| GitHub               | GitHub App via **Manifest flow**; Octokit (`@octokit/app`, `@octokit/rest`, `@octokit/graphql`, `@octokit/webhooks`).                                                                                                                                                                                 |
| Parsing              | `web-tree-sitter` (WASM) for TS/JS, Python, Go, Java; regex fallback for others.                                                                                                                                                                                                                      |
| Scanners             | Built-in regex secret + risky-pattern rules always; `gitleaks` and `semgrep` used if binaries exist on PATH (shipped in Docker image). GitHub code-scanning / Dependabot / secret-scanning alerts read when permission granted.                                                                       |
| AI                   | Provider interface; adapters: `anthropic` (official `@anthropic-ai/sdk`) and `openai-compatible` (official `openai` SDK with configurable baseURL — covers OpenAI, Azure, OpenRouter, Ollama, vLLM, LiteLLM).                                                                                         |
| Model defaults       | triage/digest: `claude-haiku-5-5`; pr_report: `claude-sonnet-5-5`; deep (cross-PR / high risk): `claude-opus-5-5`. All admin-configurable per task.                                                                                                                                                   |
| AI data policy       | AI disabled until admin explicitly enables it in setup after seeing data-flow screen. Per-repo `ai_mode`: `full` \| `metadata_only` \| `off`. Per-repo `exclude_paths` globs. Secrets always redacted before prompts.                                                                                 |
| Budget               | Monthly cap (default $100), alert at 80%, at 100% AI calls are skipped and reports are produced from deterministic analysis with a visible "AI budget reached" banner.                                                                                                                                |
| Auth                 | Local email+password (argon2id). Bootstrap via one-time `SETUP_TOKEN` printed on first boot. Users invited via expiring links. DB-backed sessions, httpOnly SameSite=Lax cookie (`Secure` when PUBLIC_URL is https). CSRF: mutating requests require header `x-gmp-csrf` matching session csrf token. |
| Notifications        | in-app, email (SMTP via nodemailer), Slack (incoming webhook URL). Daily digest.                                                                                                                                                                                                                      |
| Packaging            | One Docker image (commands `server` / `worker`), docker-compose with `postgres`, `server`, `worker`, volume `repo-cache`. Dev: `pnpm dev`.                                                                                                                                                            |
| Webhook reachability | Public URL, or built-in smee.io relay (`SMEE_URL`), plus reconciliation polling every 15 min as safety net.                                                                                                                                                                                           |
| License              | Apache-2.0.                                                                                                                                                                                                                                                                                           |

## 3. Repository layout

```
package.json, pnpm-workspace.yaml, tsconfig.base.json, vitest.workspace.ts, .env.example, LICENSE, README.md
docker-compose.yml          # prod-like: postgres, server, worker
docker-compose.dev.yml      # postgres only (port 54329) for local dev & tests
Dockerfile
scripts/init-env.mjs        # generates .env with MASTER_KEY, SESSION_SECRET
packages/core     @gmp/core      config, logger, crypto, redaction, shared types & zod schemas
packages/db       @gmp/db        drizzle schema, migrations, client, migrate script
packages/github   @gmp/github    GitHub App, webhooks, discovery, PR snapshot fetch
packages/analysis @gmp/analysis  deterministic analysis: diff, symbols, contracts, breaking, security, overlap, scoring
packages/ai       @gmp/ai        providers, prompts, report generation, budget/usage
packages/notify   @gmp/notify    channels, dispatcher, digest
apps/server       @gmp/server    Fastify API, auth, setup, webhook endpoint, serves web
apps/worker       @gmp/worker    pg-boss job handlers
apps/web          @gmp/web       React SPA
docs/                            user + operator documentation
```

Each package: `src/index.ts` public API only; tests in `src/**/*.test.ts` (vitest). Packages are consumed as TS source via workspace (`"main": "src/index.ts"`, `"exports": {".": "./src/index.ts"}`) and run with `tsx` in dev; production build uses `tsup` per app bundling workspace packages.

## 4. Environment (`@gmp/core` config, zod-validated)

```
DATABASE_URL            postgres://...
PUBLIC_URL              https://gmp.example.com   (used for webhook + callbacks)
PORT                    3000
MASTER_KEY              base64 32 bytes — encrypts all stored credentials (BACK IT UP)
SESSION_SECRET          base64 >=32 bytes
GITHUB_API_URL          default https://api.github.com
GITHUB_WEB_URL          default https://github.com
SMEE_URL                optional webhook relay for local use
REPO_CACHE_DIR          default ./.data/repos
LOG_LEVEL               default info
NODE_ENV
```

Everything else (GitHub App credentials, AI keys, SMTP, Slack) is configured in the UI and stored encrypted in DB.

## 5. `@gmp/core` public API

```ts
loadConfig(env?): Config
createLogger(name): pino.Logger            // redacts keys matching /token|secret|key|password|authorization/i
encrypt(plain: string): string             // AES-256-GCM, MASTER_KEY; output "v1:<iv>:<tag>:<ct>" base64 parts
decrypt(blob: string): string
redactSecrets(text: string): { text: string; redactions: number }   // known token formats, PEM blocks, high-entropy assignments
// enums (as const arrays + types)
Severity = 'critical'|'high'|'medium'|'low'|'info'
RiskLevel = 'critical'|'high'|'medium'|'low'
Recommendation = 'ready_to_merge'|'merge_after_checks'|'needs_clarification'|'changes_required'|'escalate'
FindingCategory = 'security'|'breaking_change'|'integration'|'testing'|'deployment'|'database'|'regression'|'other'
RiskDimension = 'security'|'breaking_change'|'integration'|'regression'|'database'|'deployment'
RelationshipType = 'same_file'|'same_symbol'|'contract_change'|'shared_table'|'shared_config'|'duplicate_work'|'depends_on'
RelationshipConfidence = 'confirmed'|'likely'|'possible'
AiTask = 'triage'|'pr_report'|'deep_analysis'|'digest'
// zod schemas + inferred types:
EvidenceSchema { repo: string; path?: string; line?: number; endLine?: number; url?: string; snippet?: string; source: 'diff'|'index'|'github'|'scanner'|'ai' }
FindingSchema  { fingerprint: string; category; severity; title; description (plain language); technicalDetail?; whatMightBreak?; affected?: string[]; recommendation?; evidence: Evidence[]; verified: boolean; source: 'rule'|'scanner'|'github'|'ai'; ruleId? }
RiskScoreSchema { dimension; score: 0..100; level: RiskLevel; rationale: string; evidence: Evidence[] }
MergeReadinessSchema { recommendation; blockers: string[]; checks: {name; status:'pass'|'fail'|'pending'|'unknown'; detail}[]; rationale }
PrReportSchema {
  executiveSummary; businessImpact; technicalSummary;
  affectedAreas: { modules: string[]; services: string[]; apis: string[]; databaseTables: string[]; sharedComponents: string[]; integrations: string[]; configuration: string[]; infrastructure: string[] };
  breakingChanges: Finding[]; security: Finding[]; integrationImpact: Finding[];
  overlappingWork: { prRef: string; type: RelationshipType; confidence; summary; suggestedCoordination? }[];
  testing: { testsAdded: string[]; testsModified: string[]; missingTests: string[]; ciSummary: string };
  deployment: { migrations: string[]; envChanges: string[]; configChanges: string[]; ordering: string[]; notes: string };
  rollback: { difficulty: 'easy'|'moderate'|'hard'; notes: string };
  recommendedActions: string[];
  riskScores: RiskScore[]; overallRisk: RiskLevel; mergeReadiness: MergeReadiness;
  confidence: { score: 0..100; rationale: string };
  generatedBy: 'ai'|'deterministic';   // 'deterministic' when AI off/budget/failed
  limitations: string[];                // e.g. "AI disabled for this repo", "diff truncated"
}
```

## 6. Database (`@gmp/db`) — all tables have `id uuid pk default gen_random_uuid()`, `created_at`, `updated_at` timestamptz; tenant tables have `org_id`.

- `organizations` (name, timezone, settings jsonb)
- `users` (org_id, email unique per org, name, password_hash, role admin|member, disabled bool, timezone, last_login_at)
- `sessions` (user_id, token_hash unique, csrf_token, expires_at, ip, user_agent)
- `invites` (org_id, email, role, token_hash, expires_at, accepted_at, created_by)
- `system_state` (single row: setup_token_hash, setup_completed_at, setup_step)
- `github_apps` (org_id, app_id, slug, name, client_id, client_secret_enc, private_key_enc, webhook_secret_enc, html_url, owner_login)
- `installations` (org_id, github_app_id, installation_id unique, account_login, account_type, repository_selection, permissions jsonb, suspended_at)
- `repositories` (org_id, installation_id fk, github_id unique per org, owner, name, full_name, private, default_branch, archived, monitoring_enabled bool default true, ai_mode default 'full', exclude_paths text[], last_discovered_at, last_polled_at)
- `repository_profiles` (repository_id unique, discovered jsonb, overrides jsonb, head_sha) — languages, frameworks, build tools, package managers, test frameworks, ci workflows, security tools, codeowners, pr template, contributing, architecture docs, packages (monorepo)
- `projects` (org_id, name, description, paused bool, settings jsonb — risk thresholds, analysis depth)
- `project_repositories` (project_id, repository_id, unique pair)
- `project_members` (project_id, user_id, unique pair)
- `pull_requests` (org_id, repository_id, github_id, number, title, body, state open|closed|merged, draft, author_login, assignees text[], requested_reviewers text[], labels text[], base_ref, head_ref, head_sha, base_sha, mergeable_state, review_decision, additions, deletions, changed_files, html_url, opened_at, closed_at, merged_at, last_event_at, linked_issues jsonb) unique (repository_id, number)
- `pr_files` (pull_request_id, head_sha, path, previous_path, status, additions, deletions)
- `pr_commits` (pull_request_id, sha, message, author_login, committed_at)
- `pr_reviews` (pull_request_id, github_id, reviewer_login, state, submitted_at, body)
- `pr_checks` (pull_request_id, head_sha, name, status, conclusion, url, completed_at)
- `webhook_deliveries` (org_id nullable, delivery_id unique, event, action, installation_id, repository_full_name, payload jsonb, status received|queued|processed|ignored|failed, attempts, error, received_at, processed_at)
- `pr_events` (org_id, pull_request_id, type, actor_login, data jsonb, occurred_at, delivery_id) — history timeline
- `analyses` (org_id, pull_request_id, head_sha, base_sha, previous_analysis_id, kind full|incremental|readiness_only, status queued|running|completed|failed|skipped, report jsonb (PrReport), overall_risk, recommendation, confidence, generated_by, footprint jsonb, ai_usage jsonb, error, started_at, completed_at) unique(pull_request_id, head_sha, kind)
- `findings` (org_id, analysis_id, pull_request_id, fingerprint, category, severity, title, data jsonb (Finding), lifecycle new|unchanged|resolved, verified)
- `pr_relationships` (org_id, pr_a_id, pr_b_id (pr_a_id < pr_b_id), type, confidence, summary, evidence jsonb, active bool) unique(pr_a_id, pr_b_id, type)
- `code_symbols` (org_id, repository_id, ref_sha, path, name, kind function|class|method|interface|type|const, signature, exported bool, start_line, end_line)
- `code_contracts` (org_id, repository_id, ref_sha, kind http_route|graphql|proto|event|env_var|db_table|queue_topic, identifier, role provider|consumer, path, line)
- `ai_providers` (org_id, name, kind anthropic|openai_compatible, base_url, api_key_enc, enabled)
- `ai_settings` (org_id unique, enabled bool default false, consent_at, consent_by, task_models jsonb {task: {providerId, model, maxOutputTokens}}, monthly_budget_usd numeric default 100, alert_threshold_pct default 80, max_input_tokens_per_call default 120000)
- `ai_usage` (org_id, task, provider_kind, model, input_tokens, output_tokens, cache_read_tokens, cost_usd numeric, pull_request_id, analysis_id, occurred_at)
- `notification_channels` (org_id, kind email|slack|in_app, name, config_enc (json encrypted: smtp/slack url), enabled)
- `notification_rules` (org_id, project_id nullable (null = org default), min_severity, events text[], channel_ids uuid[], digest_enabled, digest_hour int, timezone, quiet_start, quiet_end)
- `notifications` (org_id, user_id nullable, project_id, pull_request_id, kind, severity, title, body, url, dedup_key, channel_kind, status pending|sent|deferred|failed|read, send_after, sent_at, read_at) unique(dedup_key, channel_kind, user_id)
- `audit_log` (org_id, user_id, action, target_type, target_id, ip, data jsonb, occurred_at)

`@gmp/db` exports: `createDb(url) → { db, pool, close() }`, `schema` (all tables), `migrate(url)`, type helpers. Migrations in `packages/db/drizzle/` generated by drizzle-kit and committed. Script `pnpm db:migrate`.

## 7. `@gmp/github` public API

```ts
buildAppManifest({ publicUrl, appName, org? }): { manifest: object; postUrl: string }   // read-only permissions below
convertManifestCode(code): Promise<{ appId, slug, name, clientId, clientSecret, pem, webhookSecret, htmlUrl, ownerLogin }>
createGitHubClient(appCreds: { appId, privateKey, apiUrl? }): GitHubClient
GitHubClient.installationOctokit(installationId): Octokit                // cached, throttling + retry plugins
GitHubClient.listInstallations(), listInstallationRepos(installationId)
verifyWebhookSignature(secret, rawBody, signatureHeader): boolean        // sha256 HMAC, timing-safe
normalizeWebhook(event, payload): NormalizedEvent | null                 // pr_opened|pr_updated|pr_synchronized|pr_edited|pr_closed|pr_merged|pr_reopened|review_submitted|review_comment|issue_comment|check_updated|status_updated|push|installation_changed|installation_repos_changed
discoverRepository(octokit, owner, repo, ref?): Promise<RepositoryProfile>   // via contents/trees API: languages, manifests, CI, codeowners, docs, templates, monorepo packages
fetchPullRequestSnapshot(octokit, owner, repo, number): Promise<PrSnapshot>  // pr meta, files (with patch), commits, reviews, review comments count, checks+statuses, linked issues (closing refs via GraphQL), reviewDecision, mergeable_state, code scanning / dependabot alerts if permitted (graceful 403)
compareCommits(octokit, owner, repo, base, head): Promise<{ status: 'ahead'|'diverged'|..., files }>
getFileContent(octokit, owner, repo, path, ref): Promise<string|null>
listOpenPullRequests(octokit, owner, repo): Promise<PrSummary[]>
ensureRepoClone(cacheDir, installationToken, fullName, ref): Promise<string>  // shallow clone/fetch for indexing
```

App permissions (manifest): `metadata:read, contents:read, pull_requests:read, issues:read, checks:read, statuses:read, actions:read, security_events:read, vulnerability_alerts:read`. Events: `pull_request, pull_request_review, pull_request_review_comment, issue_comment, check_run, check_suite, status, push, installation, installation_repositories, repository`. No write permissions.

## 8. `@gmp/analysis` public API (pure/deterministic, no network)

```ts
parseUnifiedDiff(patch): DiffHunk[]            // added/removed lines with line numbers
detectLanguage(path): string
extractSymbols(lang, source): Symbol[]         // tree-sitter; regex fallback
extractContracts(path, source): Contract[]     // http routes (express/fastify/koa/nest/flask/fastapi/django/gin/echo/spring), graphql types, proto services, env var reads, SQL/migration tables, queue topic literals; role provider|consumer (fetch/axios/http client URL literals)
analyzeChanges(input: { repo; files: {path, status, patch?, before?, after?}[]; profile }): ChangeFacts
   // ChangeFacts: touchedSymbols (added/removed/modified with old/new signature), contractsChanged, migrations, envVarsAdded/removed, dependencyChanges, testsAdded/modified, workflowChanges, configChanges, permissionChanges, packagesTouched
detectBreakingChanges(facts): Finding[]        // removed/renamed exports, signature changes, route removal/method change, schema drops/renames/NOT NULL adds, env var removals, event payload/proto field changes, auth middleware changes — verified=true with evidence
runSecurityScan(input: { files, workdir? }): Promise<Finding[]>   // builtin rules (secrets, sqli concat, exec with input, eval, innerHTML/dangerouslySetInnerHTML, disabled TLS verify, weak crypto md5/sha1/DES, logging secrets, CORS *, workflow pull_request_target + checkout of head, permissions: write-all), plus gitleaks/semgrep when available
computeFootprint(facts): Footprint             // files, symbols, contracts, tables, envVars, packages
detectRelationships(pr: {id, repo, footprint, title, body, linkedIssues}, others: same[], consumers: ContractIndex): Relationship[]
   // same_file (confirmed if overlapping hunks else likely), same_symbol, contract_change (provider change vs consumer in other repo/PR), shared_table, shared_config, depends_on ("depends on #n", same linked issue). duplicate_work candidates flagged 'possible' for AI confirmation.
scoreRisk(input: { facts, findings, relationships, checks, reviewDecision, mergeableState, projectSettings }): { riskScores: RiskScore[]; overallRisk; mergeReadiness }
diffFindings(previous: Finding[], current: Finding[]): { new, unchanged, resolved }  // by fingerprint
fingerprint(parts: string[]): string
```

Risk scoring rules: each dimension 0–100 from weighted signals; level thresholds critical ≥80, high ≥60, medium ≥30, else low. Overall = highest dimension level, bumped to at least `high` if any critical/high verified security finding. Merge readiness (first match wins): critical security or critical breaking without mitigation → `escalate`; failing required checks or `review_decision=CHANGES_REQUESTED` → `changes_required`; open questions/AI-flagged ambiguities → `needs_clarification`; pending checks, missing approvals, migrations, cross-repo dependencies, high risk → `merge_after_checks` with explicit blockers; else `ready_to_merge`. Every score has rationale + evidence.

## 9. `@gmp/ai` public API

```ts
interface AiProvider { kind; complete(req: { model; system: string; messages; jsonSchema?: object; maxOutputTokens; cacheSystem?: boolean }): Promise<{ text; json?; usage: { inputTokens; outputTokens; cacheReadTokens } }> }
createProvider(config: { kind, apiKey, baseUrl? }): AiProvider
estimateCostUsd(model, usage): number         // price table for known models, configurable fallback
class AiService { constructor({ db, orgId, logger });
  isEnabledFor(repo): boolean;                 // org enabled + consent + repo ai_mode != off + budget remaining
  triage(input): Promise<{ meaningful: boolean; reason }>
  generateReport(input: ReportInput): Promise<{ report: PrReport; usage }>   // merges deterministic facts/findings/scores; AI may add concerns (verified=false) and adjust scores ±15 with rationale; output validated with PrReportSchema; on failure → deterministic report
  confirmRelationships(candidates): Promise<Relationship[]>                 // duplicate_work / semantic overlap, deep model
  writeDigest(input): Promise<string>
  budgetStatus(): Promise<{ spentUsd; capUsd; pct; exhausted }>
}
buildDeterministicReport(input: ReportInput): PrReport    // no AI; used when AI off/failed/exhausted
```

Prompt-injection defense: fixed system prompt; all repo/PR content wrapped as `<untrusted_data id="{random}">…</untrusted_data id="{random}">` with explicit instruction that it is data, never instructions; no tools given to model; output must validate against JSON schema; output strings are rendered as text (never HTML) in UI; secrets redacted (`redactSecrets`) and `exclude_paths` removed before building prompts; `metadata_only` sends paths, symbol names, PR text but no code bodies. Large diffs: prioritized truncation (security/contract/migration files first) with a `limitations` note. Anthropic adapter: structured output via `output_config.format` JSON schema, prompt caching on system + repo profile, refusal stop_reason handled → deterministic fallback.

## 10. `@gmp/notify` public API

```ts
dispatch({ db, orgId, event: { kind, severity, projectId, pullRequestId?, title, body, url, dedupKey } }): Promise<void>
   // resolves rules (project then org default), min severity, quiet hours (defer non-critical via send_after), dedup by dedup_key, writes notifications rows; channel send happens in flushPending
flushPending({ db, orgId, now }): Promise<number>     // sends due notifications via channels
buildDigest({ db, orgId, projectId?, since, until }): Promise<DigestData>
renderDigest(data, format: 'email_html'|'text'|'slack'): string
channels: sendEmail(smtpConfig, msg), sendSlack(webhookUrl, msg)
testChannel(channel): Promise<{ ok; error? }>
```

Kinds: `pr_analyzed, high_risk, security_finding, breaking_change, overlap_detected, pr_updated_meaningfully, clarification_needed, digest, budget_alert, webhook_failure`. Meaningful-change only: notify when risk level rises, a new high/critical finding appears, or a new confirmed/likely relationship appears.

## 11. `@gmp/worker` jobs (pg-boss queue names)

| Queue               | Trigger                                                                       | Behaviour                                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webhook.process`   | server after storing delivery                                                 | normalize; ignore if repo not monitored or project paused; upsert PR, record pr_event; enqueue follow-ups                                                                                             |
| `repo.discover`     | repo added, push to default branch (debounced 10 min)                         | discoverRepository → repository_profiles                                                                                                                                                              |
| `repo.index`        | after discover; push to default branch                                        | shallow clone, extract symbols + contracts for supported langs → code_symbols/code_contracts (replace by ref)                                                                                         |
| `pr.sync`           | PR events, reconcile                                                          | fetchPullRequestSnapshot → upsert files/commits/reviews/checks                                                                                                                                        |
| `pr.analyze`        | after sync when head_sha changed or no analysis; singletonKey `pr:{id}:{sha}` | incremental if previous analysis exists and compare is `ahead`; triage (AI) decides whether to regenerate narrative; deterministic analysis always; report; findings lifecycle; relationships; notify |
| `pr.readiness`      | review/check/status events                                                    | recompute mergeReadiness only (no AI), new analysis kind readiness_only                                                                                                                               |
| `overlap.recompute` | after analyze                                                                 | update relationships for other open PRs in org touching same footprint                                                                                                                                |
| `notify.flush`      | every minute                                                                  | flushPending                                                                                                                                                                                          |
| `digest.daily`      | every 15 min checks rules whose local digest hour passed and not sent today   | buildDigest → (AI writeDigest if enabled) → dispatch                                                                                                                                                  |
| `reconcile.poll`    | every 15 min                                                                  | for each monitored repo list open PRs; enqueue pr.sync for any whose updated_at/head_sha differs (covers missed webhooks)                                                                             |
| `retention.cleanup` | daily                                                                         | delete webhook payloads > 30 days, sessions expired                                                                                                                                                   |

All handlers idempotent; webhook dedup by `delivery_id` unique; pg-boss retryLimit 5, retryBackoff true; failures recorded and shown on status page.

## 12. Server API (`/api`, JSON, zod-validated, session auth unless noted)

- Setup (no auth until setup complete; requires setup token): `GET /api/setup/status`, `POST /api/setup/admin` {setupToken, orgName, email, name, password, timezone}
- Auth: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/invite/accept`
- GitHub: `GET /api/github/status`, `POST /api/github/manifest` → {postUrl, manifest} (admin), `GET /api/github/manifest/callback?code` (redirect), `GET /api/github/install/callback?installation_id` (redirect), `POST /api/github/sync-installations`, `GET /api/github/repositories` (available repos), `POST /api/github/webhook` (no auth, signature verified, raw body, stores delivery then enqueues, returns 202 fast), `DELETE /api/github/app` (disconnect: deletes stored creds)
- Repositories: `GET /api/repositories`, `GET/PATCH /api/repositories/:id` (monitoring_enabled, ai_mode, exclude_paths, profile overrides), `POST /api/repositories/:id/rediscover`
- Projects: CRUD `/api/projects`, `POST/DELETE /api/projects/:id/repositories`, `POST/DELETE /api/projects/:id/members`, `POST /api/projects/:id/pause|resume`, `GET /api/projects/:id/overview`
- PRs: `GET /api/pull-requests?projectId&repositoryId&state&risk&author`, `GET /api/pull-requests/:id` (pr + latest analysis + findings + relationships + checks + reviews), `GET /api/pull-requests/:id/analyses` (history), `POST /api/pull-requests/:id/reanalyze` (admin)
- Dashboard: `GET /api/overview`, `GET /api/risk-center`, `GET /api/developers`, `GET /api/repositories/:id/overview`
- AI: `GET/PUT /api/settings/ai` (consent, task models, budget), `GET/POST/DELETE /api/settings/ai/providers`, `POST /api/settings/ai/providers/:id/test`, `GET /api/usage`
- Notifications: CRUD `/api/settings/notification-channels` (+ `/test`), CRUD `/api/settings/notification-rules`, `GET /api/notifications`, `POST /api/notifications/:id/read`
- Users: `GET /api/users`, `POST /api/users/invite`, `PATCH /api/users/:id` (role/disable) — admin
- System: `GET /api/system/status` (queue depth, failed jobs, webhook backlog, last delivery, rate limit, AI budget), `GET /api/audit-log` (admin), `GET /healthz`
  Member users only see data for projects they belong to (enforced in a shared `accessibleRepositoryIds(user)` helper). All admin mutations write `audit_log`. `@fastify/rate-limit` global + stricter on login/setup. `@fastify/helmet` CSP. Errors never leak secrets/stack in production.

## 13. Web UI

Routes: `/setup` (wizard: 1 admin account → 2 connect GitHub (create app via manifest, install) → 3 select repos & create first project → 4 AI provider, data-flow consent screen, models, budget → 5 notifications → 6 review discovered repo profiles → 7 start monitoring), `/login`, `/` global overview, `/projects`, `/projects/:id`, `/repositories/:id`, `/pull-requests/:id` (report with tabs: Summary, Risk, Breaking changes, Security, Related PRs, Tests & deploy, History), `/risk` risk center, `/developers`, `/notifications`, `/settings/*` (GitHub, repositories, AI, notifications, users, system status, audit log). Plain-language first; badges for verified fact vs potential concern; every evidence item links to GitHub (file/line). Responsive (works at 375px). No HTML rendering of model/repo text (React text only; markdown rendered with sanitising renderer that disallows raw HTML).

## 14. Security model summary

Webhook HMAC verified with timing-safe compare before any parsing beyond raw body; credentials AES-256-GCM encrypted with MASTER_KEY; secrets never logged (pino redaction) or returned by API (write-only fields return `"configured": true`); least-privilege read-only GitHub App; session cookies httpOnly; CSRF header; argon2id; rate limiting; audit log; input validation with zod everywhere; repo content untrusted (prompt-injection defense §9); outbound AI data governed by consent + ai_mode + exclude_paths + redaction; documented data flow in `docs/security.md`; retention cleanup.

## 15. Testing

Vitest unit tests per package (analysis rules, diff parsing, scoring, crypto, redaction, signature verification, webhook normalization, prompt building/injection wrapping, notification dedup/quiet hours). Integration test (`apps/worker` / `apps/server`) against real Postgres from docker-compose.dev.yml: webhook POST → delivery stored → job → snapshot from mocked GitHub (nock/msw fixtures) → analysis with fake AI provider → findings, relationships, notification rows. Web: typecheck + build; a few component tests. CI workflow `.github/workflows/ci.yml` runs lint, typecheck, tests with a postgres service.

## 16. Known limitations (MVP)

Symbol-level analysis only for TS/JS, Python, Go, Java; cross-repo consumer detection relies on literal route/topic/env names; semantic duplicate-work detection is AI-assisted and marked "possible"; branch protection read via `mergeable_state` + `reviewDecision` (no admin permission requested); GitHub Enterprise Server untested; single org per install.

## 17. Roadmap

- Phase 2: dependency graph visualisation, developer & task intelligence, merge sequence recommendations, historical intelligence, NL assistant, release impact, Telegram + advanced notifications, Jira/Linear, GitHub SSO, Helm chart.
- Future: regression prediction, deployment intelligence, review-comment suggestions, optional controlled GitHub write actions, multi-tenant SaaS.

## Approaches considered

- **TypeScript monorepo, Postgres-only infra (chosen):** one language, Octokit first-party, pg-boss avoids Redis; simplest self-host.
- Python FastAPI + Celery/Redis + React: richer AI ecosystem but two languages and an extra service.
- Go backend: easiest ops, slower UI/AI iteration.
