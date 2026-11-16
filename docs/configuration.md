# Configuration

git-merge-pilot reads a small set of **environment variables**. Everything else is configured in the UI and stored in the database, with secrets encrypted:

- GitHub App credentials
- AI providers and keys
- SMTP and Slack
- projects, notification rules and budgets

The environment is validated at startup. If a variable is missing or invalid, the process exits with an error that lists the variable **names**, never their values.

## Variables

| Variable          | Required | Default                  | Description                                                                                                                                                                                                                                      |
| ----------------- | -------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`    | yes      | none                     | Postgres connection string, for example `postgres://gmp:secret@postgres:5432/gmp`. In `docker-compose.yml` it is set for you from `POSTGRES_*`                                                                                                   |
| `PUBLIC_URL`      | yes      | none                     | The base URL users and GitHub use, for example `https://gmp.example.com`. Used for webhook, manifest and installation callback URLs and links in notifications. With `https`, session cookies are marked `Secure`. Any trailing slash is removed |
| `WEB_URL`         | no       | `PUBLIC_URL`             | Where users open the web UI, if not `PUBLIC_URL`. GitHub callbacks redirect there, and invite and setup links use it. `pnpm dev` sets it to `http://localhost:5173`. The smee channel URL is never shown in the UI or API                        |
| `PORT`            | no       | `3000`                   | HTTP port of the server                                                                                                                                                                                                                          |
| `MASTER_KEY`      | yes      | none                     | **base64 of exactly 32 random bytes.** Encrypts all stored credentials with AES-256-GCM. **Back it up.** Changing it makes stored credentials unreadable                                                                                         |
| `SESSION_SECRET`  | yes      | none                     | base64 of at least 32 random bytes. Used for session and cookie signing                                                                                                                                                                          |
| `GITHUB_API_URL`  | no       | `https://api.github.com` | GitHub REST and GraphQL base. For GHES: `https://<host>/api/v3` (untested)                                                                                                                                                                       |
| `GITHUB_WEB_URL`  | no       | `https://github.com`     | GitHub web base, used for the manifest flow and links                                                                                                                                                                                            |
| `SMEE_URL`        | no       | none                     | A smee.io channel URL. When set, the server relays webhooks from it, and the App manifest uses it as its webhook URL. For local or private installs                                                                                              |
| `GMP_SETUP_TOKEN` | no       | generated and printed    | Choose the one-time setup token yourself (16+ characters). When set, it is never printed to the log; enter it on the setup page. Ignored once an admin exists                                                                                    |
| `REPO_CACHE_DIR`  | no       | `./.data/repos`          | Where shallow clones for indexing are kept. Resolved to an absolute path. In Docker it is `/data/repos`, on the `repo-cache` volume                                                                                                              |
| `LOG_LEVEL`       | no       | `info`                   | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`                                                                                                                                                                                   |
| `NODE_ENV`        | no       | `development`            | `development`, `production` or `test`. Production hides error details in API responses                                                                                                                                                           |

### Operational variables (optional)

| Variable                        | Default       | Description                                                                                                                                                                                                     |
| ------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOST`                          | `0.0.0.0`     | Interface the server listens on                                                                                                                                                                                 |
| `TRUST_PROXY`                   | off           | `true`, or a comma-separated list of proxy IPs/CIDRs, when running behind a reverse proxy (client IPs, https)                                                                                                   |
| `GMP_AUTO_MIGRATE`              | `true`        | Server and worker apply pending migrations on start. Set `false` when you run `migrate` separately                                                                                                              |
| `GMP_WEB_DIST`                  | auto-detected | Directory of the built web UI (`apps/web/dist`). The server serves it at `/`                                                                                                                                    |
| `GMP_TREE_SITTER_WASM_DIR`      | auto-detected | Directory holding the `tree-sitter-*.wasm` grammars, if they cannot be resolved from `node_modules`                                                                                                             |
| `GMP_SLACK_EXTRA_WEBHOOK_HOSTS` | none          | Comma-separated extra hosts accepted as Slack-compatible incoming webhooks. By default only `hooks.slack.com` and `hooks.slack-gov.com` are allowed, so a channel cannot point the server at internal addresses |

### Variables used only by the Docker and Compose setup

| Variable             | Default                            | Description                                                                     |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| `POSTGRES_USER`      | `gmp`                              | Database user for the bundled Postgres                                          |
| `POSTGRES_PASSWORD`  | `gmp`                              | **Change it** for anything beyond a local trial. Set it before the first start  |
| `POSTGRES_DB`        | `gmp`                              | Database name                                                                   |
| `GMP_IMAGE`          | `git-merge-pilot:local`            | Image tag that compose builds or uses                                           |
| `GMP_HOST_PORT`      | `3000`                             | Host port mapped to the server                                                  |
| `GMP_BIND`           | `0.0.0.0`                          | Host interface to bind. Use `127.0.0.1` behind a reverse proxy on the same host |
| `GMP_MIGRATIONS_DIR` | `/app/packages/db/drizzle` (image) | Override for where the SQL migrations are found                                 |

### Variables used only by tests

| Variable            | Default                                                                     | Description                                      |
| ------------------- | --------------------------------------------------------------------------- | ------------------------------------------------ |
| `TEST_DATABASE_URL` | falls back to `DATABASE_URL`, then `postgres://gmp:gmp@localhost:54329/gmp` | Server on which tests create throwaway databases |

## Generating secrets

`pnpm init-env`, or `node scripts/init-env.mjs`, creates `.env` from `.env.example` with fresh secrets. It never overwrites an existing `.env`, and it never prints the secrets.

To generate them by hand:

```bash
openssl rand -base64 32    # MASTER_KEY (must decode to exactly 32 bytes)
openssl rand -base64 48    # SESSION_SECRET
```

## How `.env` is loaded

- `pnpm dev`, `pnpm db:migrate`: the nearest `.env` is loaded. Variables already set in the environment take precedence.
- Docker Compose: `.env` is passed through `env_file`. Compose then overrides `DATABASE_URL`, `REPO_CACHE_DIR`, `NODE_ENV` and `PORT` for the containers.
- Other platforms (Fly.io, Railway, Kubernetes): set the variables through the platform's secret or config mechanism. Don't bake `.env` into images. `.dockerignore` excludes it.

## Settings stored in the database (configured in the UI)

| Area          | Where                    | Notes                                                                                                |
| ------------- | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| GitHub App    | Settings → GitHub        | Private key, client secret, webhook secret: encrypted                                                |
| Repositories  | Settings → Repositories  | `monitoring_enabled`, `ai_mode`, `exclude_paths`, profile overrides                                  |
| Projects      | Projects                 | Repositories, members, paused, settings (risk thresholds, analysis depth)                            |
| AI            | Settings → AI            | Enabled, consent, providers (keys encrypted), task models, monthly budget, alert %, max input tokens |
| Notifications | Settings → Notifications | Channels (configs encrypted), rules, digest hour, quiet hours                                        |
| Users         | Settings → Users         | Roles, invites, disable                                                                              |
| Organization  | Settings                 | Name, timezone                                                                                       |
