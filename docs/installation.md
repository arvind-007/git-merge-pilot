# Installation

You can run git-merge-pilot in two ways:

- **Docker Compose**, recommended for real use. One image runs the server and the worker, next to a Postgres container.
- **From source**, for development or evaluation without building the image.

Both use the same environment variables. See [configuration.md](configuration.md).

## Requirements

| Component | Version / notes                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| Docker    | Engine 24+ with Compose v2 (Docker path)                                                                                  |
| Node.js   | 22.x (source path, and optionally to run `scripts/init-env.mjs`)                                                          |
| pnpm      | the version pinned in `package.json` `packageManager` (source path)                                                       |
| Postgres  | 16. The compose files use `pgvector/pgvector:pg16`; the pgvector extension is optional                                    |
| Memory    | 1 GB minimum, 2 GB+ recommended (semgrep and repository indexing are the heaviest)                                        |
| Disk      | a few GB for the repository cache (`REPO_CACHE_DIR`) plus database growth                                                 |
| Network   | outbound HTTPS to GitHub (and to your AI provider, SMTP and Slack if used); inbound HTTPS for webhooks or a smee.io relay |

## Option A: Docker Compose

```bash
git clone <repository url> git-merge-pilot
cd git-merge-pilot
node scripts/init-env.mjs          # creates .env with MASTER_KEY + SESSION_SECRET
```

Edit `.env`:

- `PUBLIC_URL`: the URL users and GitHub use to reach the server, for example `https://gmp.example.com`. For a laptop, keep `http://localhost:3000` and set `SMEE_URL`.
- `SMEE_URL`: optional. A channel from <https://smee.io/new> when GitHub cannot reach `PUBLIC_URL`.
- `LOG_LEVEL`: optional.

You don't need to change `DATABASE_URL` or `REPO_CACHE_DIR`. `docker-compose.yml` overrides them for the containers so they point at the bundled Postgres and the `repo-cache` volume.

For anything beyond a local trial, choose a database password **before the first start**:

```bash
export POSTGRES_PASSWORD='<long random value>'   # or put it in a shell profile / compose .env
```

Start the stack:

```bash
docker compose up -d --build
docker compose ps
```

Compose starts these services:

| Service    | What it does                                                                             |
| ---------- | ---------------------------------------------------------------------------------------- |
| `postgres` | Postgres 16 with a `pgdata` volume and a health check                                    |
| `migrate`  | one-shot: applies pending migrations, then exits. Safe to run repeatedly (advisory lock) |
| `server`   | API, web UI and webhook endpoint on port 3000 (`GET /healthz`)                           |
| `worker`   | background jobs: sync, analysis, notifications, digest, polling, retention               |

`server` and `worker` only start after `migrate` has completed successfully. Both share the `repo-cache` volume, mounted at `/data/repos`.

On first boot the server prints a one-time **setup link** with the setup token built in:

```bash
docker compose logs server | grep -o 'http[^ ]*/setup?token=[^ ]*'
```

Open that link and continue with the [setup guide](setup-guide.md). To choose the token yourself instead, set `GMP_SETUP_TOKEN` (16+ characters) in `.env` before the first start.

### The image

The `Dockerfile` is a multi-stage build on `node:22-bookworm-slim`.

- The web SPA is built with Vite. `server`, `worker` and the migration CLI are bundled with tsup. The workspace packages are inlined, and npm dependencies are installed as production-only, hoisted `node_modules`. The image does not need `tsx` or TypeScript at runtime.
- `git`, `gitleaks` and `semgrep` are included:
  - `gitleaks` is a pinned release binary for the target architecture, checksum-verified.
  - `semgrep` is installed with pip into a virtualenv at `/opt/semgrep`.
- It runs as the non-root `node` user, with `tini` as PID 1.
- The entrypoint accepts `server` (default), `worker`, `migrate`, or any other command to exec.
- `HEALTHCHECK` calls `GET /healthz` when the container runs the server, and is a no-op for the other roles.

Build arguments:

| Arg                | Default   | Purpose                                                                                                     |
| ------------------ | --------- | ----------------------------------------------------------------------------------------------------------- |
| `GITLEAKS_VERSION` | `8.28.0`  | gitleaks release to download                                                                                |
| `SEMGREP_VERSION`  | `1.100.0` | semgrep version installed with pip                                                                          |
| `INSTALL_SEMGREP`  | `true`    | set to `false` for a smaller image. Built-in rules still run, and semgrep is skipped when it is not on PATH |
| `PNPM_VERSION`     | `12.18.0` | pnpm used during the build                                                                                  |

```bash
docker build -t git-merge-pilot:local --build-arg INSTALL_SEMGREP=false .
docker run --rm git-merge-pilot:local help
```

### Upgrading

```bash
git pull
docker compose up -d --build     # migrate runs again automatically before server/worker start
```

Take a database backup before upgrading. See [backup-recovery.md](backup-recovery.md).

## Option B: from source

```bash
pnpm install
pnpm init-env                                    # .env pointing at localhost:54329
docker compose -f docker-compose.dev.yml up -d   # dev Postgres only
pnpm db:migrate
pnpm dev
```

`pnpm dev` runs these in parallel:

- server on `:3000`, with `tsx watch`
- worker, with `tsx watch`
- Vite dev server on `:5173`, which proxies `/api` and `/healthz` to `:3000`

Open `http://localhost:5173/setup` during development. `pnpm dev` sets `WEB_URL=http://localhost:5173` (from `apps/server/dev.env`; a `WEB_URL` in `.env` overrides it), so after you create or install the GitHub App, the callbacks on `PUBLIC_URL` (`:3000`) send you back to the Vite UI. To use the server-served build, run `pnpm --filter @gmp/web build` and open `http://localhost:3000/setup`.

gitleaks and semgrep are optional when running from source. Install them on your `PATH` to enable them. Otherwise only the built-in rules run.

Production-style build without Docker. The bundles inline the `@gmp/*` workspace packages but keep npm packages external, so they need a **hoisted** `node_modules` (the same layout the Docker image uses); with pnpm's default isolated layout they fail with `ERR_MODULE_NOT_FOUND`:

```bash
pnpm install --config.node-linker=hoisted
pnpm build                          # web SPA, server, worker and the migrate CLI
node packages/db/dist/migrate-cli.js
node apps/server/dist/index.js      # and in another process:
node apps/worker/dist/index.js
```

Run `pnpm install` again (without the flag) to return to the default layout for development.

## Verifying the install

- `curl -fsS $PUBLIC_URL/healthz` returns success.
- **Settings → System status** shows queue depth, failed jobs, webhook backlog, last webhook delivery, GitHub rate limit and AI budget.
- After the GitHub App is installed, opening or updating a PR in a monitored repository produces a report within a minute or two.

If something is wrong, see [troubleshooting.md](troubleshooting.md).
