# Troubleshooting

Start with **Settings → System status** (`GET /api/system/status`). It shows:

- queue depth and failed jobs
- the webhook backlog and the last delivery
- the GitHub rate limit
- the AI budget

Then check the logs:

```bash
docker compose logs --tail=200 server worker
# more detail
LOG_LEVEL=debug docker compose up -d server worker
```

Logs are redacted: tokens, keys and passwords appear as `[REDACTED]`. You can paste them into an issue, but do check them first.

## Startup

**`ConfigError: invalid environment: MASTER_KEY, ...`**
A required variable is missing or malformed. The error lists the names of the problem variables. `MASTER_KEY` must be base64 that decodes to exactly 32 bytes, so generate it with `openssl rand -base64 32` or `pnpm init-env`. See [configuration.md](configuration.md).

**The `migrate` service exits non-zero, and `server`/`worker` never start**
Run `docker compose logs migrate`. Common causes:

- Postgres isn't reachable: check `POSTGRES_PASSWORD` consistency.
- The Postgres volume was created earlier with a different password. The password is set only when the volume is first initialized. Either keep the old password, or reset with `docker compose down -v`, which **deletes data**.

**`Could not find drizzle migrations`**
This only happens with custom builds. Set `GMP_MIGRATIONS_DIR` to the `packages/db/drizzle` directory.

**Container is `unhealthy`**
The server health check calls `GET /healthz` on `PORT`. Check that the server is listening, and that `PORT` matches the container port (3000 in compose).

## Setup

<a id="lost-setup-token"></a>
**I lost the setup token**
The token is printed when the server starts and setup isn't complete yet. Try `docker compose logs server | grep -i "setup token"`. If the logs are gone, restart the server (`docker compose restart server`). While setup is incomplete, a new token is issued and printed on boot, and the old one becomes invalid.

**The setup page says setup is already complete**
An admin account exists. Log in at `/login`. The MVP has no self-service password reset. Another admin can invite you again under **Settings → Users** with a new email address. If no admin can log in at all, you have to repair the database by hand. Ask in an issue, and don't include any secrets.

## GitHub

**The manifest flow returns an error, or the callback fails**

- `PUBLIC_URL` must exactly match the URL in your browser. Scheme, host and port all matter, because the callback is `PUBLIC_URL/api/github/manifest/callback`.
- Manifest codes expire after about an hour and can only be used once. Start again from the wizard.
- If the name is already taken on GitHub, change it on the confirmation page.

**The App is installed, but no repositories appear**
Click **Sync installations**. On GitHub, check that the installation includes the repositories: **Settings → Applications → Installed GitHub Apps → Configure**.

**No webhooks are arriving**

- On GitHub, open **App settings → Advanced → Recent deliveries**. It shows the response code for each delivery.
- **Connection failures:** GitHub can't reach `PUBLIC_URL`. Use a public HTTPS URL, or set `SMEE_URL` and update the App's webhook URL to the smee channel.
- **`401` responses:** the signature check failed. The webhook secret on GitHub and in git-merge-pilot don't match. Update one of them (see [github-app.md](github-app.md#reauthorize-rotate-and-disconnect)). Also make sure your reverse proxy doesn't modify request bodies.
- **`413` responses:** the proxy's body size limit is too small. Allow about 25 MB.
- Missed deliveries are picked up by the 15-minute reconciliation poll. Reports may be late, but they aren't lost.

**PRs are updated, but reports aren't**

- Check that the repository is monitored, is in a project, and that the project isn't paused.
- Look for failed `pr.sync` or `pr.analyze` jobs on the system status page.
- Use **Re-analyze** on the PR (admin).

**The Security tab says "code scanning alerts unavailable"**
The installation didn't grant `security_events` or `vulnerability_alerts`, or the feature isn't enabled on the repository. This is optional: the other checks still run.

**GitHub rate limits are exhausted**
Large organizations with many repositories can hit the hourly limit during initial indexing. Work slows down and resumes automatically. Fewer monitored repositories, or staggered onboarding, helps.

## AI

**Reports say "Generated without AI"**
That's expected when any of these is true:

- AI is disabled, or consent was not given
- the repository's `ai_mode` is `off`
- the monthly budget is reached (an "AI budget reached" banner is shown)
- the AI call failed or returned output that didn't pass validation

The **Limitations** section of the report says which one applies. Provider errors are logged with the provider kind and model.

**The provider test fails**

- Anthropic: check the key and the model id.
- OpenAI-compatible: check that `baseUrl` ends with `/v1` (or your provider's equivalent) and that the model name exists there. For Azure, the model is your deployment name.
- Local Ollama or vLLM from Docker: `localhost` refers to the container. Use the compose service name, or `host.docker.internal`.

**Local models often fall back to deterministic reports**
The model can't produce valid JSON for the schema. Use a larger instruction-tuned model, increase `maxOutputTokens`, or reduce `maxInputTokensPerCall`.

**Costs look wrong**
Costs are estimates from a built-in price table. Unknown models use the fallback price, which is 0 if unset.

## Notifications

**Email or Slack tests fail**

- SMTP: check the host, the port (587 with STARTTLS, or 465 with `secure`), the credentials and the from address. Some providers require an app password.
- Slack: the URL must be an **incoming webhook** URL (`https://hooks.slack.com/services/...`).

**No notifications are arriving**

- Check the rule's minimum severity (default `high`) and its selected events and channels.
- Quiet hours defer non-critical notifications until they end.
- Notifications are sent only on **meaningful change**, and duplicates are suppressed.
- Failed sends are shown on the notifications and system status pages.

**The digest arrives at the wrong time**
The digest hour is interpreted in the rule's timezone, falling back to the organization's timezone. The digest job checks every 15 minutes, so allow up to 15 minutes of delay.

## Scanners

**gitleaks or semgrep findings never appear**
The Docker image includes both. From source, install them on `PATH`. Run `docker compose exec worker gitleaks version` and `docker compose exec worker semgrep --version` to check. The built-in rules always run, whether or not the scanners are installed.

## Database

**Disk usage keeps growing**
Webhook payloads are pruned after 30 days. Analysis history is kept. Check the largest tables:

```sql
SELECT relname, pg_size_pretty(pg_total_relation_size(relid))
FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 10;
```

## Still stuck?

Open an issue with:

- your version or commit
- the deployment method
- the redacted logs
- the relevant system status output

Security problems go through [SECURITY.md](../SECURITY.md), not public issues.
