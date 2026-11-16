# Deployment

git-merge-pilot needs these things:

- one **server** process (HTTP)
- one or more **worker** processes
- a **Postgres 16** database
- a persistent directory for the **repository cache**
- **inbound HTTPS** for GitHub webhooks, or a smee.io relay for non-public installs

## VPS with Docker Compose (recommended)

A small VPS is enough for most teams: 2 vCPU, 4 GB RAM and 40 GB disk.

```bash
# on the server
git clone <repository url> /opt/git-merge-pilot && cd /opt/git-merge-pilot
node scripts/init-env.mjs        # or create .env by hand (see configuration.md)
```

Then:

1. Set `PUBLIC_URL=https://gmp.example.com` in `.env`.
2. Choose a database password. Compose reads `POSTGRES_PASSWORD` from your shell, or from a compose-level env file:

   ```bash
   echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env
   ```

   Values in `.env` are used both for `${...}` substitution in `docker-compose.yml` and as container environment.

3. Bind the app to localhost only, so it's reachable only through the reverse proxy:

   ```bash
   echo "GMP_BIND=127.0.0.1" >> .env
   docker compose up -d --build
   ```

### Reverse proxy with TLS (Caddy)

Caddy obtains and renews Let's Encrypt certificates automatically. Point a DNS record at the server, then use this `/etc/caddy/Caddyfile`:

```caddyfile
gmp.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000 {
		header_up X-Forwarded-Proto {scheme}
	}
	# GitHub webhook bodies can be large (big PRs); allow up to 25 MB.
	request_body {
		max_size 25MB
	}
}
```

```bash
sudo systemctl reload caddy
curl -fsS https://gmp.example.com/healthz
```

If you prefer to run Caddy in the same compose project, add a service like this:

```yaml
caddy:
  image: caddy:2
  ports: ['80:80', '443:443']
  volumes:
    - ./Caddyfile:/etc/caddy/Caddyfile:ro
    - caddy-data:/data
  depends_on: [server]
```

Then use `reverse_proxy server:3000` in the Caddyfile, and add `caddy-data:` under `volumes`.

nginx or Traefik work just as well. Forward `Host` and `X-Forwarded-Proto`, allow request bodies of about 25 MB, and don't buffer or alter the body of `/api/github/webhook`, because the signature covers the raw bytes.

### Operations

| Task                   | Command                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| Logs                   | `docker compose logs -f server worker`                            |
| Upgrade                | `git pull && docker compose up -d --build` (migrations run first) |
| Run migrations by hand | `docker compose run --rm migrate`                                 |
| Restart                | `docker compose restart server worker`                            |
| Status                 | **Settings → System status** in the UI, `docker compose ps`       |
| Backups                | see [backup-recovery.md](backup-recovery.md)                      |

## Fly.io

- Build from the `Dockerfile`. Run two process groups from the same image:

  ```toml
  [processes]
    server = "server"
    worker = "worker"

  [http_service]
    internal_port = 3000
    processes = ["server"]
    force_https = true
    [[http_service.checks]]
      path = "/healthz"
      interval = "30s"
      timeout = "5s"
  ```

- **Release command:**

  ```toml
  [deploy]
    release_command = "migrate"
  ```

- **Postgres:** use Fly Postgres or any managed Postgres 16, and set `DATABASE_URL` as a secret.
- **Secrets:** `fly secrets set MASTER_KEY=... SESSION_SECRET=... PUBLIC_URL=https://<app>.fly.dev DATABASE_URL=...`
- **Repository cache:** mount a volume at `/data/repos` for the worker. The cache can be rebuilt, so an ephemeral disk also works, at the cost of re-cloning after restarts.

## Railway

- Create a Postgres service and two services from this repository, both using the Dockerfile:
  - **server**: start command `server`, public domain, health check path `/healthz`
  - **worker**: start command `worker`, no public domain
- Set `DATABASE_URL` from the Postgres service reference, and set `MASTER_KEY`, `SESSION_SECRET` and `PUBLIC_URL` (the server's public domain, with https) on both services.
- Run migrations as a pre-deploy command (`migrate`) on the server service. Migrations are advisory-locked, so running them from more than one place is safe.
- Attach a volume at `/data/repos` to the worker if available.

## Other platforms (Kubernetes, Nomad, ECS)

- **Image:** use one image for everything. Start each role with the args `server`, `worker` or `migrate`.
- **Probes:** HTTP `GET /healthz` on port 3000 for the server, for both liveness and readiness. The worker has no HTTP port. Monitor it through `/api/system/status` and its logs.
- **Migrations:** run `migrate` as an init container or a pre-deploy job before rolling out new versions.
- **Filesystem:** the root filesystem can be read-only, apart from `/data/repos` and `/tmp`.

## Scaling

| Concern                  | Guidance                                                                                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| More repositories or PRs | Add **worker** replicas. pg-boss distributes jobs with `SKIP LOCKED`. Singleton keys stop the same PR and SHA from being analysed twice                                                             |
| Server                   | Stateless (sessions live in Postgres). Run 2+ replicas behind the proxy for availability                                                                                                            |
| smee relay               | Development only. With several server replicas, every replica would relay, but dedup on delivery id keeps processing correct                                                                        |
| Postgres                 | The main bottleneck at scale. Give it RAM and fast disk. Each process uses a small pool (default 10 connections). Use PgBouncer (session mode) if you run many replicas                             |
| GitHub rate limits       | Installation tokens get 5,000+ requests per hour. Throttling and retry are built in. The reconciliation poll and indexing are the biggest consumers. Rate-limit status is on the system status page |
| Repo cache disk          | Shallow default-branch clones. Size it at roughly the sum of your repositories' checkout sizes. Shared between server and worker in compose                                                         |
| AI cost                  | Controlled by the monthly budget, per-task model choice and per-repo `ai_mode`                                                                                                                      |
| Memory                   | semgrep and tree-sitter indexing of large repositories are the heaviest. Give workers 1–2 GB each                                                                                                   |
