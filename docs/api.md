# REST API

The server exposes a JSON API under `/api`. It is used by the web UI and is available for automation. This page describes the endpoints the server implements. Request and response bodies are validated with zod, and invalid input returns `400` with field-level issues.

## Conventions

- **Authentication.** Session cookie, set by `POST /api/auth/login`: httpOnly, SameSite=Lax, and `Secure` when `PUBLIC_URL` is https. Endpoints require a session unless marked otherwise.
- **CSRF.** Every mutating request (`POST`, `PUT`, `PATCH`, `DELETE`) needs the header `x-gmp-csrf: <csrfToken>`. The token is returned by `GET /api/auth/me` and on login. Webhook and setup requests are exempt: setup is authenticated by the setup token.
- **Roles.** `admin` can do everything. `member` can only read data for projects they belong to, and gets `404` or empty lists for anything else. Endpoints marked **admin** return `403` for members.
- **Errors.** `{ "error": string, "message": string, "code": string, "issues"?: { path, message }[] }` with the matching HTTP status (`code` is a stable machine-readable identifier such as `validation_error`). Stack traces and secrets are never returned in production.
- **Secrets are write-only.** Responses show `"configured": true` instead of a value.
- **Auditing.** All admin mutations write an `audit_log` entry.
- **Rate limits.** There is a global limit, with stricter limits on `/api/auth/login` and `/api/setup/*`. When a limit is hit, the server returns `429` with `retry-after`.

## Health

| Method | Path       | Auth | Description                                                             |
| ------ | ---------- | ---- | ----------------------------------------------------------------------- |
| GET    | `/healthz` | none | Liveness. `200` `{ status: "ok", version }` when the process is serving |

## Setup

These endpoints work without auth until setup is complete. Creating the admin requires the setup token.

| Method | Path                  | Description                                                                                                                                                                                          |
| ------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/setup/status`   | `{ completed, adminCreated, step, setupTokenRequired, completedAt }`                                                                                                                                 |
| POST   | `/api/setup/admin`    | `{ setupToken, name, email, password, timezone, orgName? }` (`orgName` defaults to "My organization"). Creates the org and the first admin, and starts a session. Returns `{ user, org, csrfToken }` |
| PUT    | `/api/setup/step`     | admin: `{ step }`. Remembers the wizard step (1–7)                                                                                                                                                   |
| POST   | `/api/setup/complete` | admin: marks setup complete (the wizard's "Start monitoring" step)                                                                                                                                   |

## Auth

| Method | Path                      | Description                                                           |
| ------ | ------------------------- | --------------------------------------------------------------------- |
| POST   | `/api/auth/login`         | `{ email, password }` → session cookie and `{ user, org, csrfToken }` |
| POST   | `/api/auth/logout`        | Revokes the session                                                   |
| GET    | `/api/auth/me`            | Current user, role, org and `csrfToken`                               |
| POST   | `/api/auth/invite/accept` | `{ token, name, password }`. Accepts an invite link                   |

## GitHub

| Method | Path                                            | Auth     | Description                                                                                                                                                                                       |
| ------ | ----------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/github/status`                            | session  | App connection, installations, permissions, last delivery                                                                                                                                         |
| POST   | `/api/github/manifest`                          | admin    | Returns `{ postUrl, manifest }`. The browser POSTs the manifest to GitHub                                                                                                                         |
| GET    | `/api/github/manifest/callback?code=`           | redirect | Converts the manifest code into App credentials (stored encrypted), then redirects to the UI                                                                                                      |
| GET    | `/api/github/install/callback?installation_id=` | redirect | Records the installation, then redirects to the UI                                                                                                                                                |
| POST   | `/api/github/sync-installations`                | admin    | Re-reads installations and their repositories from GitHub                                                                                                                                         |
| GET    | `/api/github/repositories`                      | admin    | Repositories available through the installations                                                                                                                                                  |
| POST   | `/api/github/webhook`                           | **none** | Requires a valid `X-Hub-Signature-256` over the raw body. Stores the delivery once per `X-GitHub-Delivery`, enqueues it, returns `202` `{ ok, duplicate, deliveryId }` (`401` on a bad signature) |
| DELETE | `/api/github/app`                               | admin    | Disconnects: deletes stored App credentials. History is kept                                                                                                                                      |

## Repositories

| Method | Path                               | Description                                                                      |
| ------ | ---------------------------------- | -------------------------------------------------------------------------------- |
| GET    | `/api/repositories`                | Monitored and known repositories (members see only their projects' repositories) |
| GET    | `/api/repositories/:id`            | Repository with its profile (discovered and overrides)                           |
| PATCH  | `/api/repositories/:id`            | admin: `{ monitoringEnabled?, aiMode?, excludePaths?, profileOverrides? }`       |
| POST   | `/api/repositories/:id/rediscover` | admin: queues `repo.discover` and then `repo.index`                              |
| GET    | `/api/repositories/:id/overview`   | Dashboard for one repository                                                     |

## Projects

| Method | Path                             | Description                                                                       |
| ------ | -------------------------------- | --------------------------------------------------------------------------------- |
| GET    | `/api/projects`                  | List of accessible projects                                                       |
| POST   | `/api/projects`                  | admin: `{ name, description?, settings?, repositoryIds?, memberIds? }`            |
| GET    | `/api/projects/:id`              | Project details                                                                   |
| PATCH  | `/api/projects/:id`              | admin: update the name, description or settings (risk thresholds, analysis depth) |
| DELETE | `/api/projects/:id`              | admin                                                                             |
| POST   | `/api/projects/:id/repositories` | admin: add repositories `{ repositoryId }` or `{ repositoryIds }`                 |
| DELETE | `/api/projects/:id/repositories` | admin: remove repositories, JSON body `{ repositoryId }` or `{ repositoryIds }`   |
| POST   | `/api/projects/:id/members`      | admin: add members `{ userId }` or `{ userIds }`                                  |
| DELETE | `/api/projects/:id/members`      | admin: remove members, JSON body `{ userId }` or `{ userIds }`                    |
| POST   | `/api/projects/:id/pause`        | admin: pause processing for the project's PRs                                     |
| POST   | `/api/projects/:id/resume`       | admin                                                                             |
| GET    | `/api/projects/:id/overview`     | Project dashboard: open PRs by risk, findings, overlaps                           |

## Pull requests

| Method | Path                               | Description                                                                                    |
| ------ | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| GET    | `/api/pull-requests`               | Filters: `projectId`, `repositoryId`, `state` (`open`/`closed`/`merged`), `risk`, `author`     |
| GET    | `/api/pull-requests/:id`           | The PR, its latest analysis (with the `PrReport`), findings, relationships, checks and reviews |
| GET    | `/api/pull-requests/:id/analyses`  | Analysis history (per head SHA and kind)                                                       |
| POST   | `/api/pull-requests/:id/reanalyze` | admin: queues a full re-analysis                                                               |

The `report` object follows `PrReportSchema` in `@gmp/core`:

- `executiveSummary`, `businessImpact`, `technicalSummary`
- `affectedAreas`
- `breakingChanges`, `security`, `integrationImpact` (arrays of findings)
- `overlappingWork`, `testing`, `deployment`, `rollback`, `recommendedActions`
- `riskScores`, `overallRisk`, `mergeReadiness`, `confidence`
- `generatedBy` (`ai` or `deterministic`)
- `limitations`

Each finding has these fields:

- `fingerprint`, `category`, `severity`, `title`, `description`
- `technicalDetail?`, `whatMightBreak?`, `affected?`, `recommendation?`
- `evidence[]`: each item has `repo`, `path`, `line`, `url`, `snippet` and `source`
- `verified`, `source`, `ruleId?`

## Dashboard

| Method | Path               | Description                                                                 |
| ------ | ------------------ | --------------------------------------------------------------------------- |
| GET    | `/api/overview`    | Global overview: open PRs, risk distribution, recent findings               |
| GET    | `/api/risk-center` | High and critical PRs, open security and breaking findings, active overlaps |
| GET    | `/api/developers`  | Per-author activity, open PRs, review load                                  |

## AI settings

| Method | Path                                  | Description                                                                                                                                                                                                               |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/settings/ai`                    | Enabled flag, consent, task models, budget and status                                                                                                                                                                     |
| PUT    | `/api/settings/ai`                    | admin: any of `{ enabled, consent, taskModels, monthlyBudgetUsd, alertThresholdPct, maxInputTokensPerCall }`. `taskModels` maps `triage`/`pr_report`/`deep_analysis`/`digest` to `{ providerId, model, maxOutputTokens }` |
| GET    | `/api/settings/ai/providers`          | Providers (keys shown as `configured`)                                                                                                                                                                                    |
| POST   | `/api/settings/ai/providers`          | admin: `{ name, kind: 'anthropic'\|'openai_compatible', baseUrl?, apiKey, enabled? }` (key is write-only: responses show `apiKeyConfigured`)                                                                              |
| PATCH  | `/api/settings/ai/providers/:id`      | admin: `{ name?, baseUrl?, apiKey?, enabled? }`                                                                                                                                                                           |
| DELETE | `/api/settings/ai/providers/:id`      | admin                                                                                                                                                                                                                     |
| POST   | `/api/settings/ai/providers/:id/test` | admin: runs a minimal completion, returns `{ ok, error? }`                                                                                                                                                                |
| GET    | `/api/usage`                          | admin: AI usage and cost by month, task and model                                                                                                                                                                         |

## Notifications

| Method | Path                                           | Description                                                                                                           |
| ------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/settings/notification-channels`          | Channels (secrets shown as `configured`)                                                                              |
| POST   | `/api/settings/notification-channels`          | admin: `{ kind: 'email'\|'slack'\|'in_app', name, config, enabled }`                                                  |
| PATCH  | `/api/settings/notification-channels/:id`      | admin                                                                                                                 |
| DELETE | `/api/settings/notification-channels/:id`      | admin                                                                                                                 |
| POST   | `/api/settings/notification-channels/:id/test` | admin: sends a test message, returns `{ ok, error? }`                                                                 |
| GET    | `/api/settings/notification-rules`             | Rules (the org default and per project)                                                                               |
| POST   | `/api/settings/notification-rules`             | admin: `{ projectId?, minSeverity, events, channelIds, digestEnabled, digestHour, timezone, quietStart?, quietEnd? }` |
| PATCH  | `/api/settings/notification-rules/:id`         | admin                                                                                                                 |
| DELETE | `/api/settings/notification-rules/:id`         | admin                                                                                                                 |
| GET    | `/api/notifications`                           | The current user's in-app notifications (`?unread=true` for unread only)                                              |
| POST   | `/api/notifications/:id/read`                  | Marks a notification as read                                                                                          |

Notification kinds:

- `pr_analyzed`, `pr_updated_meaningfully`
- `high_risk`, `security_finding`, `breaking_change`
- `overlap_detected`, `clarification_needed`
- `digest`
- `budget_alert`, `webhook_failure`

## Users

| Method | Path                     | Description                                                           |
| ------ | ------------------------ | --------------------------------------------------------------------- |
| GET    | `/api/users`             | admin: `{ users, invites }` (pending invites)                         |
| POST   | `/api/users/invite`      | admin: `{ email, role }` → `{ inviteUrl, expiresAt }` (expiring link) |
| DELETE | `/api/users/invites/:id` | admin: revokes a pending invite                                       |
| PATCH  | `/api/users/:id`         | admin: `{ role?, disabled? }`                                         |

## System

| Method | Path                 | Description                                                                                             |
| ------ | -------------------- | ------------------------------------------------------------------------------------------------------- |
| GET    | `/api/system/status` | Queue depth, failed jobs, webhook backlog, last delivery, GitHub rate limit, AI budget                  |
| GET    | `/api/audit-log`     | admin: the audit trail, newest first. `?limit=&before=<nextCursor>&action=` → `{ entries, nextCursor }` |

## Example: using the API from a script

```bash
BASE=https://gmp.example.com
# log in and keep the cookie
curl -sc jar -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"..."}' $BASE/api/auth/login
CSRF=$(curl -sb jar $BASE/api/auth/me | jq -r .csrfToken)
# list high-risk open PRs
curl -sb jar "$BASE/api/pull-requests?state=open&risk=high"
# trigger re-analysis (admin)
curl -sb jar -X POST -H "x-gmp-csrf: $CSRF" $BASE/api/pull-requests/<id>/reanalyze
```
