# syntax=docker/dockerfile:1.7
#
# git-merge-pilot: one image, three commands.
#   docker run IMAGE server    Fastify API + web UI (port 3000, GET /healthz)
#   docker run IMAGE worker    pg-boss job handlers
#   docker run IMAGE migrate   apply database migrations, then exit
#
# Build strategy (see docs/deployment.md):
#   - The web SPA is built with Vite into apps/web/dist.
#   - server and worker are bundled with tsup (workspace @gmp/* packages are inlined,
#     npm dependencies stay external) into apps/*/dist/index.js.
#   - The migrate CLI is bundled the same way into packages/db/dist/migrate-cli.js and
#     finds packages/db/drizzle next to it.
#   - Production npm dependencies are installed with a hoisted node_modules so that
#     external imports from inlined workspace code resolve from /app/node_modules.
#   - The runtime keeps the monorepo layout (/app/apps/..., /app/packages/...) so
#     relative paths such as apps/web/dist behave exactly as in development.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG PNPM_VERSION=12.18.0

# ---------------------------------------------------------------------------
# base: node + pnpm
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN npm install -g "pnpm@${PNPM_VERSION}" && pnpm --version
WORKDIR /app

# ---------------------------------------------------------------------------
# build: full install, build web, bundle server/worker/migrate
# ---------------------------------------------------------------------------
FROM base AS build
# Toolchain for native modules (argon2) in case no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile
RUN pnpm --filter @gmp/web run build \
 && pnpm --filter @gmp/server run build \
 && pnpm --filter @gmp/worker run build \
 && pnpm --filter @gmp/db run build \
 && test -f apps/web/dist/index.html \
 && test -f apps/server/dist/index.js \
 && test -f apps/worker/dist/index.js \
 && test -f packages/db/dist/migrate-cli.js
# Collect runtime files (no node_modules) into /out.
RUN mkdir -p /out \
 && tar -cf - --exclude=node_modules \
      package.json packages \
      apps/server/package.json apps/server/dist \
      apps/worker/package.json apps/worker/dist \
      apps/web/dist \
    | tar -xf - -C /out

# ---------------------------------------------------------------------------
# prod-deps: production dependencies only, hoisted layout
# ---------------------------------------------------------------------------
FROM base AS prod-deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/github/package.json packages/github/
COPY packages/analysis/package.json packages/analysis/
COPY packages/ai/package.json packages/ai/
COPY packages/notify/package.json packages/notify/
COPY apps/server/package.json apps/server/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile --prod --node-linker=hoisted

# ---------------------------------------------------------------------------
# tools: gitleaks (pinned release binary, checksum verified)
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS gitleaks
ARG GITLEAKS_VERSION=8.28.0
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) GL_ARCH=x64 ;; \
      arm64) GL_ARCH=arm64 ;; \
      *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    base="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}"; \
    file="gitleaks_${GITLEAKS_VERSION}_linux_${GL_ARCH}.tar.gz"; \
    cd /tmp; \
    curl -fsSLO "${base}/${file}"; \
    curl -fsSLO "${base}/gitleaks_${GITLEAKS_VERSION}_checksums.txt"; \
    grep " ${file}\$" "gitleaks_${GITLEAKS_VERSION}_checksums.txt" | sha256sum -c -; \
    tar -xzf "${file}" gitleaks; \
    install -m 0755 gitleaks /usr/local/bin/gitleaks; \
    /usr/local/bin/gitleaks version

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG SEMGREP_VERSION=1.100.0
ARG INSTALL_SEMGREP=true

LABEL org.opencontainers.image.title="git-merge-pilot" \
      org.opencontainers.image.description="Self-hosted, read-only GitHub PR intelligence platform" \
      org.opencontainers.image.licenses="Apache-2.0"

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates tini python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*

# semgrep in an isolated virtualenv (optional: --build-arg INSTALL_SEMGREP=false)
RUN set -eux; \
    if [ "${INSTALL_SEMGREP}" = "true" ]; then \
      python3 -m venv /opt/semgrep; \
      /opt/semgrep/bin/pip install --no-cache-dir --upgrade pip; \
      /opt/semgrep/bin/pip install --no-cache-dir "semgrep==${SEMGREP_VERSION}"; \
      ln -s /opt/semgrep/bin/semgrep /usr/local/bin/semgrep; \
      semgrep --version; \
    fi

COPY --from=gitleaks /usr/local/bin/gitleaks /usr/local/bin/gitleaks

ENV NODE_ENV=production \
    PORT=3000 \
    REPO_CACHE_DIR=/data/repos \
    GMP_MIGRATIONS_DIR=/app/packages/db/drizzle \
    GMP_WEB_DIST=/app/apps/web/dist \
    SEMGREP_SEND_METRICS=off \
    SEMGREP_ENABLE_VERSION_CHECK=0

WORKDIR /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /out/ ./
RUN mkdir -p /data/repos && chown -R node:node /data

COPY --chmod=0755 <<'EOF' /usr/local/bin/gmp
#!/bin/sh
# git-merge-pilot container entrypoint: server | worker | migrate | <any command>
set -e
role="${1:-server}"
case "$role" in
  server)
    shift || true
    echo server > /tmp/gmp-role
    exec node --enable-source-maps /app/apps/server/dist/index.js "$@"
    ;;
  worker)
    shift || true
    echo worker > /tmp/gmp-role
    exec node --enable-source-maps /app/apps/worker/dist/index.js "$@"
    ;;
  migrate)
    shift || true
    echo migrate > /tmp/gmp-role
    exec node --enable-source-maps /app/packages/db/dist/migrate-cli.js "$@"
    ;;
  -h|--help|help)
    echo "usage: <server|worker|migrate> (default: server), or any command to exec"
    ;;
  *)
    exec "$@"
    ;;
esac
EOF

COPY --chmod=0755 <<'EOF' /usr/local/bin/gmp-healthcheck
#!/bin/sh
# Only the server exposes HTTP. Worker/migrate containers report healthy while running.
role="$(cat /tmp/gmp-role 2>/dev/null || echo server)"
[ "$role" = "server" ] || exit 0
exec node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
EOF

USER node
VOLUME ["/data/repos"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/usr/local/bin/gmp-healthcheck"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/gmp"]
CMD ["server"]
