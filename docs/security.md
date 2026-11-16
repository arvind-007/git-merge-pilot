# Security

This page describes how git-merge-pilot protects your code, credentials and users, and exactly what data leaves your server. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Design principles

- **Read-only towards GitHub.** The GitHub App has only read permissions. git-merge-pilot never comments, approves, merges or pushes.
- **Least privilege.** There is no administration, members or organization permission. Optional security permissions degrade gracefully.
- **Opt-in AI.** No code or PR text goes to an AI provider until an admin explicitly enables AI after seeing the data-flow screen.
- **Repository content is untrusted.** It can never steer the AI or trigger an action.
- **Honest output.** Reports separate verified facts from AI-inferred potential concerns, and never claim that a PR is "secure".
- **No silent failure.** Webhook failures, AI failures and budget exhaustion are visible in the UI and the logs.

## Threat model

| Asset                                             | Threats                                                                          | Mitigations                                                                                                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub App private key, webhook and client secret | DB dump or backup leak; log leak; API leak                                       | AES-256-GCM encryption with `MASTER_KEY` (kept out of the DB); pino key redaction and value redaction; write-only API fields (`"configured": true`)                           |
| AI, SMTP and Slack credentials                    | Same                                                                             | Same                                                                                                                                                                          |
| Source code and PR content                        | Exfiltration through the AI provider; prompt injection; leakage in notifications | Consent gate, per-repo `ai_mode`, `exclude_paths`, secret redaction, untrusted-data wrapping, no tools for the model; notifications contain summaries and links, not code     |
| Webhook endpoint                                  | Forged deliveries; replay; flooding                                              | HMAC-SHA256 verification (timing-safe) before parsing; dedup on `X-GitHub-Delivery`; rate limiting; fast `202` with queueing                                                  |
| User accounts                                     | Credential stuffing; session theft; CSRF                                         | argon2id hashing; stricter rate limits on login and setup; httpOnly SameSite=Lax cookies (`Secure` on https); `x-gmp-csrf` header for mutations; DB-backed revocable sessions |
| Setup bootstrap                                   | Takeover of a fresh install                                                      | One-time setup token printed only to the server log, stored hashed, invalid after use                                                                                         |
| Authorization                                     | Members viewing other projects                                                   | Every query filtered by `org_id` and, for members, by `accessibleRepositoryIds(user)`                                                                                         |
| Web UI                                            | XSS via PR titles, bodies or AI output                                           | React text rendering only; markdown through a sanitising renderer with raw HTML disabled; Helmet CSP                                                                          |
| Worker host                                       | Malicious repository content attacking scanners                                  | Repositories are never built or executed. Shallow clones are only parsed (tree-sitter WASM) and scanned. The container runs as non-root                                       |
| Operations                                        | Misconfiguration, accidental exposure                                            | Errors never return stacks or secrets in production; audit log for all admin mutations                                                                                        |

**Out of scope:**

- a compromised host or a compromised Postgres superuser
- a malicious admin
- confidentiality towards the AI provider you chose once AI is enabled. That is governed by your contract with the provider. Use a local model for full isolation.

## Credential encryption and `MASTER_KEY`

- `MASTER_KEY` is 32 random bytes, base64-encoded, supplied by environment variable. It is never stored in the database.
- Stored secrets are encrypted with **AES-256-GCM**, using a random 96-bit IV per value. The format is `v1:<iv>:<tag>:<ciphertext>`. Tampering or a wrong key makes decryption fail, rather than returning garbage. The values encrypted this way are:
  - the GitHub App private key, client secret and webhook secret
  - AI API keys
  - notification channel configs (SMTP credentials, Slack webhook URLs)
- `SESSION_SECRET` (≥ 32 random bytes) is separate from `MASTER_KEY`.
- **Back up `MASTER_KEY` separately from your database backups.** A database backup without the key cannot decrypt credentials, which is the point. Losing the key means re-connecting GitHub and re-entering every secret. See [backup-recovery.md](backup-recovery.md).
- **Rotation:** `MASTER_KEY` rotation is not automated in the MVP. To rotate it:
  1. Disconnect GitHub and remove providers and channels.
  2. Change the key.
  3. Reconnect and re-enter the secrets.

## Webhook verification

1. The raw request body is captured before any JSON parsing.
2. `X-Hub-Signature-256` is checked against the HMAC-SHA256 of the raw body, using the App's webhook secret and a constant-time compare. Requests that are missing a signature or fail the check get `401`, and are not processed.
3. The delivery is stored with a unique `delivery_id`, so redelivery and replay of the same delivery are no-ops. The server enqueues `webhook.process` and returns `202` straight away.
4. Webhook payloads are deleted after 30 days. The delivery metadata row is kept for status and debugging.

## Prompt-injection defenses

- **Fixed system prompt.** Repository and PR content is never placed in the system prompt.
- **Untrusted-data wrapping.** All repository and PR content is wrapped as `<untrusted_data id="{random}">…</untrusted_data id="{random}">`, with a per-call random id and explicit instructions that it is data and never instructions. An attacker can't guess the id to close the block early.
- **No tools.** The model can't call functions, fetch URLs or take actions. Its only output is a JSON report.
- **Schema validation.** Output must validate against the report schema. Invalid output is discarded, and the report falls back to deterministic analysis.
- **Bounded influence:**
  - AI findings are always `verified: false` and are shown as **Potential concern**.
  - AI can move a deterministic risk score by at most ±15, with a rationale.
  - Verified findings can't be removed by the AI.
- **Output rendered as text.** It is never rendered as HTML.
- **Pre-prompt filtering.** `exclude_paths` are removed and secrets are redacted (`redactSecrets`) before a prompt is built. `metadata_only` sends no code bodies.

## Data flow: exactly what leaves your server

| Destination                          | When                                                             | What is sent                                                                                                                                                                                                                                           | What is never sent                                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub** (`GITHUB_API_URL`)        | always, while connected                                          | Authenticated **read** requests: App JWT and installation tokens, REST and GraphQL queries, git fetch for shallow clones. Manifest conversion during setup                                                                                             | Any write: comments, reviews, statuses, merges, pushes                                                                                  |
| **AI provider** (your choice)        | only after admin consent and with AI enabled; per repo `ai_mode` | `full`: PR title, body and metadata, commit messages, repo profile, deterministic findings, **redacted** diffs and snippets. `metadata_only`: the same, but with paths and symbol or contract names instead of code. Digest: summaries of analysed PRs | Repos with `ai_mode=off`; files matching `exclude_paths`; detected secrets; your stored credentials; user data other than GitHub logins |
| **SMTP server** (if configured)      | notifications and digest by email                                | Recipient address, notification title, plain-language summary, severity, link to the report                                                                                                                                                            | Code, diffs, credentials                                                                                                                |
| **Slack** (if configured)            | notifications and digest                                         | The same as email, posted to the incoming webhook                                                                                                                                                                                                      | Code, diffs, credentials                                                                                                                |
| **smee.io** (only if `SMEE_URL` set) | each webhook                                                     | GitHub sends the webhook payload, which contains PR metadata and may include commit and diff metadata, to the public relay                                                                                                                             | Use only for development or evaluation                                                                                                  |
| Anything else                        | never                                                            | No telemetry, analytics or phone-home. semgrep runs with metrics off in the image                                                                                                                                                                      |                                                                                                                                         |

## Retention

| Data                                                                       | Retention                                                                                                                   |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Webhook payloads (`webhook_deliveries.payload`)                            | 30 days, cleared by `retention.cleanup`. Metadata rows are kept                                                             |
| Sessions                                                                   | Until expiry. Expired sessions are deleted daily                                                                            |
| Repository clones (`REPO_CACHE_DIR`)                                       | Shallow clones of default branches, refreshed on index. Safe to delete at any time; they are recreated                      |
| PRs, analyses, findings, relationships, notifications, AI usage, audit log | Kept indefinitely in the MVP for history. Prune with SQL if needed, or delete repositories or projects (child rows cascade) |
| Logs                                                                       | Written to stdout. Retention is up to your log collector. Secrets are redacted at the source                                |

## Hardening checklist

- [ ] Serve over **HTTPS**. Set `PUBLIC_URL=https://...` so cookies get `Secure`.
- [ ] Don't expose Postgres. Compose doesn't publish its port.
- [ ] Use a strong `POSTGRES_PASSWORD`.
- [ ] Store `MASTER_KEY` in a secret manager and back it up offline.
- [ ] Restrict who can reach `/setup` until setup is complete.
- [ ] Use `metadata_only` or `off` for highly sensitive repositories, and add `exclude_paths`.
- [ ] Prefer a local model if code must not leave your network.
- [ ] Review the **audit log** periodically.
- [ ] Keep the image up to date (`git pull && docker compose up -d --build`).
