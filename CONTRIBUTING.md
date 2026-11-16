# Contributing to git-merge-pilot

Thanks for helping! git-merge-pilot is an Apache-2.0 project. By contributing, you agree that your contributions are licensed under the same terms.

## Ground rules

- **Read-only towards GitHub.** Never add code that writes to GitHub: comments, reviews, statuses, merges or pushes. Never add new GitHub App permissions without discussing it first.
- **Nothing hard-coded.** No repository, organization, developer or language names in code or tests. Use fixtures with neutral names.
- **Verified vs potential.** Deterministic findings carry evidence and `verified: true`. Anything inferred by AI is `verified: false`. Don't blur the two.
- **Repository content is untrusted.** Anything derived from a repository or PR that reaches an AI prompt goes through redaction, `exclude_paths` and untrusted-data wrapping. It must never be rendered as HTML.
- **No secrets in logs or responses.** Use the shared logger from `@gmp/core`, which redacts automatically. Return `"configured": true` instead of secret values.
- **Never call real GitHub or AI APIs in tests.** Use nock fixtures and fake providers.

## Development setup

Requirements: Node 22, pnpm (the version in `package.json` `packageManager`), and Docker.

```bash
pnpm install
pnpm init-env                                     # .env with generated MASTER_KEY / SESSION_SECRET
docker compose -f docker-compose.dev.yml up -d    # Postgres on localhost:54329
pnpm db:migrate
pnpm dev                                          # server :3000, worker, web :5173
```

## Repository layout

| Path                | Package                                                        |
| ------------------- | -------------------------------------------------------------- |
| `packages/core`     | `@gmp/core`: config, logger, crypto, redaction, enums, schemas |
| `packages/db`       | `@gmp/db`: Drizzle schema and migrations                       |
| `packages/github`   | `@gmp/github`                                                  |
| `packages/analysis` | `@gmp/analysis`: pure, no network                              |
| `packages/ai`       | `@gmp/ai`                                                      |
| `packages/notify`   | `@gmp/notify`                                                  |
| `apps/server`       | `@gmp/server`: Fastify API                                     |
| `apps/worker`       | `@gmp/worker`: pg-boss jobs                                    |
| `apps/web`          | `@gmp/web`: React SPA                                          |

The design document in `docs/superpowers/specs/` is the architectural contract. Larger changes should start as an issue that discusses any deviation from it.

## Conventions

- **TypeScript:** strict, ESM. Inside packages, relative imports use the `.ts` extension. Each package exposes its public API only through `src/index.ts`.
- **Validation:** zod at every boundary (HTTP, env, AI output, JSON columns).
- **Tenancy:** every query on a tenant table filters by `org_id`. Member access goes through `accessibleRepositoryIds(user)`.
- **Database changes:** edit `packages/db/src/schema.ts`, run `pnpm db:generate`, and commit the generated SQL in `packages/db/drizzle/`. Migrations must be additive and safe to run on a live database.
- **Jobs:** handlers must be idempotent. Use singleton keys for deduplication.
- **Formatting:** run Prettier (`pnpm format`). Lint with ESLint (`pnpm lint`).

## Tests

```bash
pnpm test                       # all packages (vitest projects)
pnpm --filter @gmp/analysis test
pnpm typecheck
pnpm lint
pnpm format:check
```

Database tests create throwaway databases on the dev Postgres server (`TEST_DATABASE_URL`, or by default `postgres://gmp:gmp@localhost:54329/gmp`). Unit tests live next to the code as `src/**/*.test.ts`.

What to test:

- analysis rules: include both a true positive and a near-miss that must not fire
- scoring and readiness rules
- redaction and prompt wrapping
- webhook normalisation
- notification dedup and quiet hours

## Pull requests

1. Fork the repository and create a branch.
2. Keep each PR focused. Include tests, and update docs in `docs/` when behaviour, configuration or the API changes.
3. Make sure CI passes: lint, format, typecheck, tests, web build, Docker build.
4. Describe what changed, why, and how you verified it.

Use Conventional Commit-style messages, for example `feat(analysis): detect proto field removals`.

## Adding things

- **A security rule:** add it to the built-in rules in `@gmp/analysis`. Give it a stable `ruleId`, a plain-language description and a recommendation, plus tests. Keep false positives low, because PMs read these.
- **A language or framework for contracts:** extend `extractContracts` and add fixtures.
- **An AI provider:** prefer the `openai_compatible` adapter. Add a new adapter only when the API isn't compatible.
- **A notification channel:** implement it in `@gmp/notify`, store its config with `encryptJson`, and add a `testChannel` path.

## Reporting security issues

Please don't open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
