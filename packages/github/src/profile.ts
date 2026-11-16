/**
 * Pure repository-profile detection: given the list of paths in a git tree and
 * the contents of a selected subset of files, detect frameworks, build tools,
 * package managers, test frameworks, CI, security tooling, ownership docs and
 * monorepo packages. No network access; `discoverRepository` feeds it.
 *
 * Nothing here is specific to any repository, org or language beyond the
 * well-known ecosystem conventions listed in the tables below.
 */
import { minimatch } from 'minimatch';
import {
  normalizePyName,
  parseCodeowners,
  parseGemfile,
  parseGoMod,
  parseGoWork,
  parseGradleSettings,
  parsePnpmWorkspace,
  parsePom,
  parseRequirementsTxt,
  parseTomlLite,
  pep508Name,
} from './parsers.ts';
import type { TomlDocument } from './parsers.ts';
import type { CodeownersRule, RepositoryProfile, WorkspacePackage } from './types.ts';
import { isObject } from './util.ts';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Directories never inspected (vendored / generated / dependency caches). */
const EXCLUDED_DIR_RE =
  /(^|\/)(node_modules|bower_components|vendor|third_party|third-party|\.git|\.hg|\.svn|dist|build|out|target|\.next|\.nuxt|\.svelte-kit|\.turbo|\.cache|coverage|__pycache__|\.venv|venv|\.tox|\.mypy_cache|\.gradle|\.idea|\.vscode|Pods|Carthage|\.terraform|\.yarn|\.pnpm-store)(\/|$)/;

/** Directories that hold fixtures/examples rather than real packages (heuristic package detection only). */
const NON_PACKAGE_DIR_RE =
  /(^|\/)(tests?|__tests__|spec|specs|fixtures?|__fixtures__|testdata|test-data|examples?|samples?|demos?|benchmarks?|e2e|docs?|scripts|tools|templates?)(\/|$)/i;

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function depth(path: string): number {
  let d = 0;
  for (const ch of path) if (ch === '/') d++;
  return d;
}

function isExcluded(path: string): boolean {
  return EXCLUDED_DIR_RE.test(path);
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

// ---------------------------------------------------------------------------
// File selection
// ---------------------------------------------------------------------------

/** Manifests that define a package/module in their directory. */
const PRIMARY_MANIFEST_RE =
  /(^|\/)(package\.json|pyproject\.toml|setup\.py|go\.mod|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|Cargo\.toml|[^/]+\.csproj|[^/]+\.fsproj|pubspec\.yaml|mix\.exs|Package\.swift)$/;

/** Additional files whose content is read when present. */
const CONTENT_FILE_RE = /(^|\/)(requirements[^/]*\.txt|Pipfile|setup\.cfg|project\.json)$/;

/** Root-level files whose content drives workspace/monorepo detection. */
const ROOT_CONTENT_FILES = new Set([
  'pnpm-workspace.yaml',
  'lerna.json',
  'rush.json',
  'go.work',
  'settings.gradle',
  'settings.gradle.kts',
  '.pre-commit-config.yaml',
  '.gitlab-ci.yml',
  'Jenkinsfile',
  'nx.json',
]);

const WORKFLOW_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
export const CODEOWNERS_LOCATIONS = [
  '.github/CODEOWNERS',
  'CODEOWNERS',
  'docs/CODEOWNERS',
] as const;

/**
 * Chooses which files' contents discovery should read, in priority order:
 * root workspace/config files, effective CODEOWNERS, workflows, then manifests
 * by depth. Bounded by `maxFiles`.
 */
export function selectDiscoveryFiles(paths: readonly string[], maxFiles = 150): string[] {
  const pathSet = new Set(paths);
  const root: string[] = [];
  const workflows: string[] = [];
  const manifests: string[] = [];
  for (const p of paths) {
    if (isExcluded(p)) continue;
    if (ROOT_CONTENT_FILES.has(p)) root.push(p);
    else if (WORKFLOW_RE.test(p)) workflows.push(p);
    else if ((PRIMARY_MANIFEST_RE.test(p) || CONTENT_FILE_RE.test(p)) && depth(p) <= 6)
      manifests.push(p);
  }
  const codeowners = CODEOWNERS_LOCATIONS.find((loc) => pathSet.has(loc));
  manifests.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  workflows.sort();
  root.sort();
  const ordered = [
    ...root,
    ...(codeowners ? [codeowners] : []),
    // Root manifests first, then workflows (security tool detection), then nested manifests.
    ...manifests.filter((m) => depth(m) === 0),
    ...workflows.slice(0, 40),
    ...manifests.filter((m) => depth(m) > 0),
  ];
  return [...new Set(ordered)].slice(0, Math.max(0, maxFiles));
}

// ---------------------------------------------------------------------------
// Detection tables
// ---------------------------------------------------------------------------

const NPM_FRAMEWORKS: Record<string, string> = {
  react: 'react',
  next: 'nextjs',
  vue: 'vue',
  nuxt: 'nuxt',
  svelte: 'svelte',
  '@sveltejs/kit': 'sveltekit',
  '@angular/core': 'angular',
  express: 'express',
  fastify: 'fastify',
  koa: 'koa',
  '@nestjs/core': 'nestjs',
  '@hapi/hapi': 'hapi',
  hono: 'hono',
  '@remix-run/node': 'remix',
  '@remix-run/react': 'remix',
  'react-router': 'react-router',
  'react-router-dom': 'react-router',
  astro: 'astro',
  gatsby: 'gatsby',
  electron: 'electron',
  'react-native': 'react-native',
  expo: 'expo',
  'solid-js': 'solid',
  'ember-source': 'ember',
  '@apollo/server': 'apollo-graphql',
  'apollo-server': 'apollo-graphql',
  graphql: 'graphql',
  '@trpc/server': 'trpc',
  prisma: 'prisma',
  '@prisma/client': 'prisma',
  typeorm: 'typeorm',
  sequelize: 'sequelize',
  'drizzle-orm': 'drizzle',
  mongoose: 'mongoose',
  knex: 'knex',
  '@grpc/grpc-js': 'grpc',
  'socket.io': 'socket.io',
  'pg-boss': 'pg-boss',
  bullmq: 'bullmq',
  kafkajs: 'kafka',
  amqplib: 'rabbitmq',
};

const NPM_BUILD_TOOLS: Record<string, string> = {
  vite: 'vite',
  webpack: 'webpack',
  rollup: 'rollup',
  esbuild: 'esbuild',
  tsup: 'tsup',
  parcel: 'parcel',
  turbo: 'turborepo',
  nx: 'nx',
  typescript: 'typescript',
  '@babel/core': 'babel',
  '@swc/core': 'swc',
  'react-scripts': 'create-react-app',
  '@rspack/core': 'rspack',
  'drizzle-kit': 'drizzle-kit',
};

const NPM_TEST_FRAMEWORKS: Record<string, string> = {
  jest: 'jest',
  vitest: 'vitest',
  mocha: 'mocha',
  jasmine: 'jasmine',
  ava: 'ava',
  '@playwright/test': 'playwright',
  playwright: 'playwright',
  cypress: 'cypress',
  karma: 'karma',
  tap: 'tap',
  uvu: 'uvu',
  supertest: 'supertest',
  nock: 'nock',
  msw: 'msw',
};

const PY_FRAMEWORKS: Record<string, string> = {
  django: 'django',
  flask: 'flask',
  fastapi: 'fastapi',
  starlette: 'starlette',
  tornado: 'tornado',
  aiohttp: 'aiohttp',
  pyramid: 'pyramid',
  sanic: 'sanic',
  celery: 'celery',
  sqlalchemy: 'sqlalchemy',
  alembic: 'alembic',
  djangorestframework: 'django-rest-framework',
  streamlit: 'streamlit',
  grpcio: 'grpc',
  graphene: 'graphql',
  strawberry: 'graphql',
  'strawberry-graphql': 'graphql',
  pydantic: 'pydantic',
};

const PY_TEST_FRAMEWORKS: Record<string, string> = {
  pytest: 'pytest',
  nose: 'nose',
  nose2: 'nose',
  hypothesis: 'hypothesis',
  tox: 'tox',
  behave: 'behave',
  'pytest-django': 'pytest',
  'pytest-asyncio': 'pytest',
};

const PY_BUILD_BACKENDS: Record<string, string> = {
  setuptools: 'setuptools',
  hatchling: 'hatch',
  'flit-core': 'flit',
  flit: 'flit',
  'poetry-core': 'poetry',
  maturin: 'maturin',
  'pdm-backend': 'pdm',
  'scikit-build-core': 'scikit-build',
};

const GO_FRAMEWORKS: Array<[string, string]> = [
  ['github.com/gin-gonic/gin', 'gin'],
  ['github.com/labstack/echo', 'echo'],
  ['github.com/gofiber/fiber', 'fiber'],
  ['github.com/go-chi/chi', 'chi'],
  ['github.com/gorilla/mux', 'gorilla-mux'],
  ['google.golang.org/grpc', 'grpc'],
  ['connectrpc.com/connect', 'connect-rpc'],
  ['gorm.io/gorm', 'gorm'],
  ['github.com/beego/beego', 'beego'],
  ['github.com/gobuffalo/buffalo', 'buffalo'],
  ['github.com/99designs/gqlgen', 'graphql'],
  ['github.com/jackc/pgx', 'pgx'],
  ['entgo.io/ent', 'ent'],
];

const GO_TEST_FRAMEWORKS: Array<[string, string]> = [
  ['github.com/stretchr/testify', 'testify'],
  ['github.com/onsi/ginkgo', 'ginkgo'],
  ['github.com/onsi/gomega', 'gomega'],
];

/** Substring matches against pom.xml / build.gradle content. */
const JVM_FRAMEWORKS: Array<[RegExp, string]> = [
  [/spring-boot/, 'spring-boot'],
  [/org\.springframework/, 'spring'],
  [/io\.quarkus/, 'quarkus'],
  [/io\.micronaut/, 'micronaut'],
  [/io\.dropwizard/, 'dropwizard'],
  [/io\.ktor/, 'ktor'],
  [/io\.vertx/, 'vertx'],
  [/hibernate/, 'hibernate'],
  [/org\.flywaydb|flyway-core/, 'flyway'],
  [/liquibase/, 'liquibase'],
  [/io\.grpc/, 'grpc'],
  [/com\.android\.(application|library)/, 'android'],
];

const JVM_TEST_FRAMEWORKS: Array<[RegExp, string]> = [
  [/junit-jupiter|org\.junit\.jupiter/, 'junit5'],
  [/junit:junit|<artifactId>junit<\/artifactId>/, 'junit'],
  [/testng/, 'testng'],
  [/mockito/, 'mockito'],
  [/kotest/, 'kotest'],
  [/spock/, 'spock'],
  [/testcontainers/, 'testcontainers'],
];

const RUBY_FRAMEWORKS: Record<string, string> = {
  rails: 'rails',
  sinatra: 'sinatra',
  hanami: 'hanami',
  grape: 'grape',
  sidekiq: 'sidekiq',
  activerecord: 'activerecord',
};
const RUBY_TEST_FRAMEWORKS: Record<string, string> = {
  rspec: 'rspec',
  'rspec-rails': 'rspec',
  minitest: 'minitest',
  cucumber: 'cucumber',
  capybara: 'capybara',
};

const PHP_FRAMEWORKS: Array<[RegExp, string]> = [
  [/^laravel\/framework$/, 'laravel'],
  [/^symfony\/(framework-bundle|symfony|http-kernel)$/, 'symfony'],
  [/^slim\/slim$/, 'slim'],
  [/^cakephp\/cakephp$/, 'cakephp'],
  [/^yiisoft\/yii2$/, 'yii'],
  [/^codeigniter4\/framework$/, 'codeigniter'],
  [/^laminas\/laminas-mvc$/, 'laminas'],
  [/^doctrine\/orm$/, 'doctrine'],
];
const PHP_TEST_FRAMEWORKS: Array<[RegExp, string]> = [
  [/^phpunit\/phpunit$/, 'phpunit'],
  [/^pestphp\/pest$/, 'pest'],
  [/^behat\/behat$/, 'behat'],
  [/^codeception\/codeception$/, 'codeception'],
];

const RUST_FRAMEWORKS: Record<string, string> = {
  'actix-web': 'actix',
  axum: 'axum',
  rocket: 'rocket',
  warp: 'warp',
  tokio: 'tokio',
  diesel: 'diesel',
  sqlx: 'sqlx',
  tauri: 'tauri',
  tonic: 'grpc',
  leptos: 'leptos',
  yew: 'yew',
  'sea-orm': 'sea-orm',
};

/** Lockfile / marker file → package manager. Matched on basename at depth ≤ 1. */
const LOCKFILE_MANAGERS: Record<string, string> = {
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'yarn.lock': 'yarn',
  'pnpm-lock.yaml': 'pnpm',
  'bun.lockb': 'bun',
  'bun.lock': 'bun',
  'poetry.lock': 'poetry',
  'Pipfile.lock': 'pipenv',
  Pipfile: 'pipenv',
  'uv.lock': 'uv',
  'pdm.lock': 'pdm',
  'Gemfile.lock': 'bundler',
  Gemfile: 'bundler',
  'composer.json': 'composer',
  'Cargo.toml': 'cargo',
  'go.mod': 'go-modules',
  'packages.lock.json': 'nuget',
  'pubspec.yaml': 'pub',
  'mix.exs': 'mix',
  'Package.swift': 'swiftpm',
  'environment.yml': 'conda',
  'pom.xml': 'maven',
  'build.gradle': 'gradle',
  'build.gradle.kts': 'gradle',
};

/** Basename / path → build tool. */
const BUILD_TOOL_FILES: Array<[RegExp, string]> = [
  [/(^|\/)(GNUmakefile|[Mm]akefile)$/, 'make'],
  [/(^|\/)(WORKSPACE|WORKSPACE\.bazel|MODULE\.bazel|BUILD\.bazel)$/, 'bazel'],
  [/(^|\/)CMakeLists\.txt$/, 'cmake'],
  [/(^|\/)meson\.build$/, 'meson'],
  [/(^|\/)[Jj]ustfile$/, 'just'],
  [/(^|\/)Taskfile\.ya?ml$/, 'task'],
  [/(^|\/)build\.gradle(\.kts)?$/, 'gradle'],
  [/(^|\/)pom\.xml$/, 'maven'],
  [/(^|\/)[^/]+\.(sln|csproj|fsproj)$/, 'dotnet'],
  [/(^|\/)Earthfile$/, 'earthly'],
  [/(^|\/)tsconfig(\.[^/]+)?\.json$/, 'typescript'],
  [/(^|\/)vite\.config\.[cm]?[jt]s$/, 'vite'],
  [/(^|\/)webpack\.config\.[cm]?[jt]s$/, 'webpack'],
  [/(^|\/)rollup\.config\.[cm]?[jt]s$/, 'rollup'],
  [/(^|\/)turbo\.json$/, 'turborepo'],
  [/(^|\/)nx\.json$/, 'nx'],
  [/(^|\/)Rakefile$/, 'rake'],
  [/(^|\/)(babel\.config\.[cm]?js|\.babelrc)$/, 'babel'],
  [/(^|\/)setup\.py$/, 'setuptools'],
];

/** Config file → test framework. */
const TEST_CONFIG_FILES: Array<[RegExp, string]> = [
  [/(^|\/)jest\.config\.[cm]?[jt]s(on)?$/, 'jest'],
  [/(^|\/)vitest\.(config|workspace)\.[cm]?[jt]s$/, 'vitest'],
  [/(^|\/)playwright\.config\.[cm]?[jt]s$/, 'playwright'],
  [/(^|\/)cypress\.(config\.[cm]?[jt]s|json)$/, 'cypress'],
  [/(^|\/)karma\.conf\.[cm]?[jt]s$/, 'karma'],
  [/(^|\/)\.mocharc(\.[a-z]+)?$/, 'mocha'],
  [/(^|\/)(pytest\.ini|conftest\.py)$/, 'pytest'],
  [/(^|\/)tox\.ini$/, 'tox'],
  [/(^|\/)phpunit\.xml(\.dist)?$/, 'phpunit'],
  [/(^|\/)\.rspec$/, 'rspec'],
  [/_test\.go$/, 'go-test'],
  [/(^|\/)src\/test\/java\//, 'junit'],
];

const INFRA_FILES: Array<[RegExp, string]> = [
  [/(^|\/)(Dockerfile|[^/]+\.Dockerfile|Containerfile)$/, 'docker'],
  [/(^|\/)(docker-)?compose(\.[^/]+)?\.ya?ml$/, 'docker-compose'],
  [/\.tf$/, 'terraform'],
  [/(^|\/)Chart\.yaml$/, 'helm'],
  [/(^|\/)kustomization\.ya?ml$/, 'kustomize'],
  [/(^|\/)(k8s|kubernetes|kube|manifests)\/[^/]+\.ya?ml$/, 'kubernetes'],
  [/(^|\/)Pulumi\.ya?ml$/, 'pulumi'],
  [/(^|\/)serverless\.ya?ml$/, 'serverless'],
  [/(^|\/)cdk\.json$/, 'aws-cdk'],
  [/(^|\/)samconfig\.(ya?ml|toml)$/, 'aws-sam'],
  [/(^|\/)skaffold\.ya?ml$/, 'skaffold'],
  [/(^|\/)fly\.toml$/, 'fly'],
  [/(^|\/)vercel\.json$/, 'vercel'],
  [/(^|\/)netlify\.toml$/, 'netlify'],
  [/(^|\/)Procfile$/, 'heroku'],
  [/(^|\/)(ansible\.cfg|playbook[^/]*\.ya?ml)$/, 'ansible'],
];

const CI_FILES: Array<[RegExp, string]> = [
  [WORKFLOW_RE, 'github-actions'],
  [/^\.gitlab-ci\.ya?ml$/, 'gitlab-ci'],
  [/^\.circleci\/config\.ya?ml$/, 'circleci'],
  [/(^|\/)Jenkinsfile$/, 'jenkins'],
  [/^\.travis\.ya?ml$/, 'travis-ci'],
  [/^azure-pipelines\.ya?ml$/, 'azure-pipelines'],
  [/^bitbucket-pipelines\.ya?ml$/, 'bitbucket-pipelines'],
  [/^\.buildkite\//, 'buildkite'],
  [/^\.drone\.ya?ml$/, 'drone'],
  [/^\.woodpecker(\.ya?ml|\/)/, 'woodpecker'],
  [/^cloudbuild\.ya?ml$/, 'google-cloud-build'],
  [/^buildspec\.ya?ml$/, 'aws-codebuild'],
];

/** Path → security tool. */
const SECURITY_FILES: Array<[RegExp, string]> = [
  [/^\.github\/dependabot\.ya?ml$/, 'dependabot'],
  [/^(\.github\/)?(renovate\.json5?|\.renovaterc(\.json5?)?)$/, 'renovate'],
  [/^\.github\/codeql\//, 'codeql'],
  [/(^|\/)codeql-config\.ya?ml$/, 'codeql'],
  [/^(\.semgrep\.ya?ml|semgrep\.ya?ml|\.semgrepignore|\.semgrep\/)/, 'semgrep'],
  [/^(\.gitleaks\.toml|gitleaks\.toml|\.gitleaksignore|\.github\/gitleaks\.toml)$/, 'gitleaks'],
  [/^\.snyk$/, 'snyk'],
  [/^(trivy\.ya?ml|\.trivyignore(\.yaml)?)$/, 'trivy'],
  [/^sonar-project\.properties$/, 'sonarqube'],
  [/^(\.bandit|bandit\.ya?ml)$/, 'bandit'],
  [/^\.trufflehog/, 'trufflehog'],
  [/^\.secrets\.baseline$/, 'detect-secrets'],
  [/^\.checkov\.ya?ml$/, 'checkov'],
  [/^(\.tfsec\/|tfsec\.ya?ml)/, 'tfsec'],
  [/^\.grype\.ya?ml$/, 'grype'],
  [/^\.github\/workflows\/[^/]*scorecard[^/]*\.ya?ml$/i, 'ossf-scorecard'],
];

/** Content patterns in CI workflow / pre-commit / GitLab files → security tool. */
const SECURITY_CONTENT: Array<[RegExp, string]> = [
  [/github\/codeql-action/i, 'codeql'],
  [
    /returntocorp\/semgrep|semgrep\/semgrep|semgrep-action|\bsemgrep\s+(ci|scan|--config)/i,
    'semgrep',
  ],
  [
    /gitleaks\/gitleaks-action|zricethezav\/gitleaks|gitleaks\/gitleaks|\bgitleaks\s+(detect|protect|git|dir)/i,
    'gitleaks',
  ],
  [/snyk\/actions|\bsnyk\s+test/i, 'snyk'],
  [/aquasecurity\/trivy|\btrivy\s+(fs|image|repo|config)/i, 'trivy'],
  [/trufflesecurity\/trufflehog/i, 'trufflehog'],
  [/ossf\/scorecard-action/i, 'ossf-scorecard'],
  [/SonarSource\/(sonarcloud-github-action|sonarqube-scan-action)/i, 'sonarqube'],
  [/actions\/dependency-review-action/i, 'dependency-review'],
  [/\bbandit\b/i, 'bandit'],
  [/securego\/gosec|\bgosec\b/i, 'gosec'],
  [/\bgovulncheck\b/i, 'govulncheck'],
  [/\bnpm\s+audit\b|\bpnpm\s+audit\b|\byarn\s+(npm\s+)?audit\b/i, 'npm-audit'],
  [/\bpip-audit\b/i, 'pip-audit'],
  [/\bcargo[\s-]audit\b/i, 'cargo-audit'],
  [/zaproxy\/action/i, 'owasp-zap'],
  [/anchore\/(scan-action|grype)/i, 'grype'],
  [/bridgecrewio\/checkov|\bcheckov\b/i, 'checkov'],
  [/Yelp\/detect-secrets|\bdetect-secrets\b/i, 'detect-secrets'],
  [/Security\/SAST\.gitlab-ci\.yml|template:\s*SAST/i, 'gitlab-sast'],
  [/Secret-Detection\.gitlab-ci\.yml/i, 'gitlab-secret-detection'],
  [/Dependency-Scanning\.gitlab-ci\.yml/i, 'gitlab-dependency-scanning'],
];

const PR_TEMPLATE_RE = /^(?:(\.github|docs)\/)?pull_request_template(?:\.(md|markdown|txt))?$/i;
const PR_TEMPLATE_DIR_RE =
  /^(?:(\.github|docs)\/)?pull_request_template\/[^/]+\.(md|markdown|txt)$/i;
const CONTRIBUTING_RE = /^(?:(\.github|docs)\/)?contributing(?:\.(md|markdown|rst|txt|adoc))?$/i;
const SECURITY_POLICY_RE = /^(?:(\.github|docs)\/)?security(?:\.(md|markdown|rst|txt|adoc))$/i;
const DOCS_DIR_NAMES = /^(docs?|documentation|wiki|website)$/i;
/** Directory names that always denote architecture decision records. */
const ADR_DIR_NAMES =
  /^(adrs?|architecture[-_]decisions|architecture[-_]decision[-_]records|decision[-_]records)$/i;
/** Names that only count as ADR dirs under docs/ or architecture/. */
const AMBIGUOUS_ADR_DIR_NAMES = /^(decisions|rfcs?)$/i;
const ARCH_DOC_RE =
  /(^|\/)(ARCHITECTURE|DESIGN|SYSTEM[-_]DESIGN|TECHNICAL[-_]DESIGN)(\.(md|markdown|rst|adoc|txt))?$/i;
const DOCS_ARCH_FILE_RE =
  /^(docs?|documentation)\/(.*\/)?[^/]*(architecture|design|overview)[^/]*\.(md|markdown|rst|adoc)$/i;

/** Precedence for "first matching location wins" lookups (GitHub's own order). */
function locationRank(path: string): number {
  if (path.toLowerCase().startsWith('.github/')) return 0;
  if (!path.includes('/')) return 1;
  return 2;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export interface AnalyzeRepositoryInput {
  /** Every blob path in the tree (repo-relative, '/'-separated). */
  paths: readonly string[];
  /** Contents of the files selected by {@link selectDiscoveryFiles} (missing ones are skipped). */
  files: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  languages?: Record<string, number>;
  defaultBranch: string;
  ref?: string;
  headSha: string;
  treeTruncated?: boolean;
  limitations?: string[];
  now?: Date;
}

interface Collector {
  frameworks: Set<string>;
  buildTools: Set<string>;
  packageManagers: Set<string>;
  testFrameworks: Set<string>;
  securityTools: Set<string>;
  infrastructure: Set<string>;
  ciSystems: Set<string>;
}

function safeJson(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function objectKeys(value: unknown): string[] {
  return isObject(value) ? Object.keys(value) : [];
}

function tomlKeys(doc: TomlDocument, section: string): string[] {
  return Object.keys(doc[section] ?? {});
}

function tomlStrings(doc: TomlDocument, section: string, key: string): string[] {
  const v = doc[section]?.[key];
  return Array.isArray(v) ? v : [];
}

function tomlString(doc: TomlDocument, section: string, key: string): string | null {
  const v = doc[section]?.[key];
  return typeof v === 'string' ? v : null;
}

function applyMap(names: Iterable<string>, map: Record<string, string>, into: Set<string>): void {
  for (const n of names) {
    const hit = map[n];
    if (hit) into.add(hit);
  }
}

function analyzePackageJson(pkg: Record<string, unknown>, c: Collector): void {
  const deps = new Set<string>([
    ...objectKeys(pkg.dependencies),
    ...objectKeys(pkg.devDependencies),
    ...objectKeys(pkg.peerDependencies),
    ...objectKeys(pkg.optionalDependencies),
  ]);
  applyMap(deps, NPM_FRAMEWORKS, c.frameworks);
  applyMap(deps, NPM_BUILD_TOOLS, c.buildTools);
  applyMap(deps, NPM_TEST_FRAMEWORKS, c.testFrameworks);
  for (const d of deps) {
    if (d.startsWith('@testing-library/')) c.testFrameworks.add('testing-library');
    if (d.startsWith('@storybook/')) c.testFrameworks.add('storybook');
    if (d.startsWith('@nx/') || d.startsWith('@nrwl/')) c.buildTools.add('nx');
    if (d === 'aws-cdk-lib' || d === 'aws-cdk') c.infrastructure.add('aws-cdk');
    if (d === '@pulumi/pulumi') c.infrastructure.add('pulumi');
    if (d === 'serverless') c.infrastructure.add('serverless');
  }
  const scripts = Object.values(isObject(pkg.scripts) ? pkg.scripts : {}).filter(
    (s): s is string => typeof s === 'string',
  );
  for (const s of scripts) {
    if (/\bnode\s+(--[a-z-]+\s+)*--test\b/.test(s)) c.testFrameworks.add('node-test');
    if (/\bjest\b/.test(s)) c.testFrameworks.add('jest');
    if (/\bvitest\b/.test(s)) c.testFrameworks.add('vitest');
    if (/\bmocha\b/.test(s)) c.testFrameworks.add('mocha');
  }
  const pm =
    typeof pkg.packageManager === 'string' ? /^([a-z]+)@/.exec(pkg.packageManager)?.[1] : null;
  if (pm) c.packageManagers.add(pm);
}

function analyzePythonDeps(names: Iterable<string>, c: Collector): void {
  const list = [...names].map(normalizePyName);
  for (const n of list) {
    const fw = PY_FRAMEWORKS[n] ?? PY_FRAMEWORKS[n.replace(/-/g, '')];
    if (fw) c.frameworks.add(fw);
    const tf = PY_TEST_FRAMEWORKS[n];
    if (tf) c.testFrameworks.add(tf);
  }
}

function analyzePyproject(doc: TomlDocument, c: Collector): void {
  const deps: string[] = [];
  for (const req of tomlStrings(doc, 'project', 'dependencies')) {
    const n = pep508Name(req);
    if (n) deps.push(n);
  }
  for (const key of tomlKeys(doc, 'project.optional-dependencies')) {
    for (const req of tomlStrings(doc, 'project.optional-dependencies', key)) {
      const n = pep508Name(req);
      if (n) deps.push(n);
    }
  }
  for (const key of tomlKeys(doc, 'dependency-groups')) {
    for (const req of tomlStrings(doc, 'dependency-groups', key)) {
      const n = pep508Name(req);
      if (n) deps.push(n);
    }
  }
  for (const section of Object.keys(doc)) {
    if (/^tool\.poetry(\.group\.[^.]+)?\.(dev-)?dependencies$/.test(section)) {
      deps.push(...tomlKeys(doc, section).filter((k) => k !== 'python'));
    }
  }
  analyzePythonDeps(deps, c);
  for (const req of tomlStrings(doc, 'build-system', 'requires')) {
    const n = pep508Name(req);
    const tool = n ? PY_BUILD_BACKENDS[n] : undefined;
    if (tool) c.buildTools.add(tool);
  }
  const sections = Object.keys(doc);
  if (sections.some((s) => s === 'tool.poetry' || s.startsWith('tool.poetry.')))
    c.packageManagers.add('poetry');
  if (sections.some((s) => s === 'tool.pdm' || s.startsWith('tool.pdm.')))
    c.packageManagers.add('pdm');
  if (sections.some((s) => s === 'tool.uv' || s.startsWith('tool.uv.')))
    c.packageManagers.add('uv');
  if (sections.some((s) => s === 'tool.hatch' || s.startsWith('tool.hatch.')))
    c.buildTools.add('hatch');
  if (sections.some((s) => s.startsWith('tool.pytest'))) c.testFrameworks.add('pytest');
  if (sections.some((s) => s === 'tool.tox' || s.startsWith('tool.tox.')))
    c.testFrameworks.add('tox');
  if (sections.some((s) => s === 'tool.bandit')) c.securityTools.add('bandit');
}

function analyzeCargo(doc: TomlDocument, c: Collector): void {
  const deps = new Set<string>();
  for (const section of Object.keys(doc)) {
    if (/(^|\.)(dev-|build-)?dependencies$/.test(section)) {
      for (const k of tomlKeys(doc, section)) deps.add(k);
    }
    const m = /(?:^|\.)(?:dev-|build-)?dependencies\.([^.]+)$/.exec(section);
    if (m?.[1]) deps.add(m[1]);
  }
  applyMap(deps, RUST_FRAMEWORKS, c.frameworks);
  c.testFrameworks.add('cargo-test');
  c.buildTools.add('cargo');
}

function analyzeComposer(pkg: Record<string, unknown>, c: Collector): void {
  const deps = [...objectKeys(pkg.require), ...objectKeys(pkg['require-dev'])].map((d) =>
    d.toLowerCase(),
  );
  for (const d of deps) {
    for (const [re, name] of PHP_FRAMEWORKS) if (re.test(d)) c.frameworks.add(name);
    for (const [re, name] of PHP_TEST_FRAMEWORKS) if (re.test(d)) c.testFrameworks.add(name);
  }
}

function analyzeJvm(text: string, c: Collector): void {
  for (const [re, name] of JVM_FRAMEWORKS) if (re.test(text)) c.frameworks.add(name);
  for (const [re, name] of JVM_TEST_FRAMEWORKS) if (re.test(text)) c.testFrameworks.add(name);
  if (/kotlin\(|org\.jetbrains\.kotlin/.test(text)) c.buildTools.add('kotlin');
}

function analyzeCsproj(text: string, c: Collector): void {
  if (/Sdk="Microsoft\.NET\.Sdk\.Web"|Microsoft\.AspNetCore/i.test(text))
    c.frameworks.add('aspnet-core');
  if (/Microsoft\.EntityFrameworkCore/i.test(text)) c.frameworks.add('ef-core');
  if (
    /Sdk="Microsoft\.NET\.Sdk\.BlazorWebAssembly"|Microsoft\.AspNetCore\.Components/i.test(text)
  ) {
    c.frameworks.add('blazor');
  }
  if (/Include="xunit/i.test(text)) c.testFrameworks.add('xunit');
  if (/Include="NUnit/i.test(text)) c.testFrameworks.add('nunit');
  if (/Include="MSTest/i.test(text)) c.testFrameworks.add('mstest');
  c.packageManagers.add('nuget');
}

function analyzeGoMod(text: string, c: Collector): void {
  const { requires } = parseGoMod(text);
  for (const r of requires) {
    for (const [prefix, name] of GO_FRAMEWORKS) if (r.startsWith(prefix)) c.frameworks.add(name);
    for (const [prefix, name] of GO_TEST_FRAMEWORKS)
      if (r.startsWith(prefix)) c.testFrameworks.add(name);
  }
}

// ---------------------------------------------------------------------------
// Workspace / monorepo resolution
// ---------------------------------------------------------------------------

function normalizeGlob(glob: string): string {
  return glob.trim().replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Directories (from `candidates`) matched by workspace globs (supports `!negation`). */
function matchDirs(globs: readonly string[], candidates: readonly string[]): string[] {
  const positive = globs
    .filter((g) => !g.trim().startsWith('!'))
    .map(normalizeGlob)
    .filter(Boolean);
  const negative = globs
    .filter((g) => g.trim().startsWith('!'))
    .map((g) => normalizeGlob(g.trim().slice(1)))
    .filter(Boolean);
  return candidates.filter(
    (dir) =>
      dir !== '' &&
      positive.some((g) => minimatch(dir, g, { dot: false })) &&
      !negative.some((g) => minimatch(dir, g, { dot: false })),
  );
}

interface PackageResolver {
  paths: readonly string[];
  files: ReadonlyMap<string, string>;
  dirsWith(file: RegExp): string[];
}

function makeResolver(
  paths: readonly string[],
  files: ReadonlyMap<string, string>,
): PackageResolver {
  return {
    paths,
    files,
    dirsWith(file: RegExp) {
      const dirs = new Set<string>();
      for (const p of paths) {
        if (isExcluded(p)) continue;
        if (file.test(basename(p))) dirs.add(dirname(p));
      }
      return [...dirs].sort();
    },
  };
}

function jsPackageName(r: PackageResolver, dir: string): string {
  const pkg = safeJson(r.files.get(dir ? `${dir}/package.json` : 'package.json'));
  return typeof pkg?.name === 'string' && pkg.name ? pkg.name : basename(dir);
}

function pyPackageName(r: PackageResolver, dir: string): string {
  const text = r.files.get(`${dir}/pyproject.toml`);
  if (text) {
    const doc = parseTomlLite(text);
    const name = tomlString(doc, 'project', 'name') ?? tomlString(doc, 'tool.poetry', 'name');
    if (name) return name;
  }
  return basename(dir);
}

function cargoPackageName(r: PackageResolver, dir: string): string {
  const text = r.files.get(`${dir}/Cargo.toml`);
  const name = text ? tomlString(parseTomlLite(text), 'package', 'name') : null;
  return name ?? basename(dir);
}

function goModuleName(r: PackageResolver, dir: string): string {
  const text = r.files.get(dir ? `${dir}/go.mod` : 'go.mod');
  return (text ? parseGoMod(text).module : null) ?? basename(dir);
}

function pomName(r: PackageResolver, dir: string): string {
  const text = r.files.get(`${dir}/pom.xml`);
  return (text ? parsePom(text).artifactId : null) ?? basename(dir);
}

function heuristicEcosystem(manifest: string): string {
  if (manifest === 'package.json') return 'npm';
  if (manifest === 'pyproject.toml' || manifest === 'setup.py') return 'python';
  if (manifest === 'go.mod') return 'go';
  if (manifest === 'pom.xml') return 'maven';
  if (manifest.startsWith('build.gradle')) return 'gradle';
  if (manifest === 'Gemfile') return 'ruby';
  if (manifest === 'composer.json') return 'composer';
  if (manifest === 'Cargo.toml') return 'cargo';
  if (/\.(cs|fs)proj$/.test(manifest)) return 'dotnet';
  if (manifest === 'pubspec.yaml') return 'dart';
  if (manifest === 'mix.exs') return 'elixir';
  if (manifest === 'Package.swift') return 'swift';
  return 'unknown';
}

function resolvePackages(
  r: PackageResolver,
  rootPkg: Record<string, unknown> | null,
  monorepoTools: Set<string>,
): WorkspacePackage[] {
  const out = new Map<string, WorkspacePackage>();
  const add = (path: string, name: string, ecosystem: string) => {
    const clean = normalizeGlob(path);
    if (!clean || clean === '.' || clean.split('/').includes('..') || out.has(clean)) return;
    out.set(clean, { name, path: clean, ecosystem });
  };

  // npm / yarn / bun workspaces
  const ws = rootPkg?.workspaces;
  const wsGlobs = Array.isArray(ws)
    ? ws
    : isObject(ws) && Array.isArray(ws.packages)
      ? ws.packages
      : [];
  const jsGlobs = wsGlobs.filter((g): g is string => typeof g === 'string');
  if (jsGlobs.length) monorepoTools.add('npm-workspaces');

  // pnpm
  const pnpmWs = r.files.get('pnpm-workspace.yaml');
  if (pnpmWs !== undefined || r.paths.includes('pnpm-workspace.yaml')) {
    monorepoTools.add('pnpm-workspace');
    jsGlobs.push(...parsePnpmWorkspace(pnpmWs ?? ''));
  }
  // lerna
  const lerna = safeJson(r.files.get('lerna.json'));
  if (lerna || r.paths.includes('lerna.json')) {
    monorepoTools.add('lerna');
    const lp = lerna?.packages;
    if (Array.isArray(lp)) jsGlobs.push(...lp.filter((g): g is string => typeof g === 'string'));
    else if (!jsGlobs.length) jsGlobs.push('packages/*');
  }
  if (r.paths.includes('turbo.json')) monorepoTools.add('turborepo');
  if (r.paths.includes('nx.json')) monorepoTools.add('nx');

  if (jsGlobs.length) {
    for (const dir of matchDirs(jsGlobs, r.dirsWith(/^package\.json$/)))
      add(dir, jsPackageName(r, dir), 'npm');
  }

  // Rush
  const rush = safeJson(r.files.get('rush.json'));
  if (rush) {
    monorepoTools.add('rush');
    for (const p of Array.isArray(rush.projects) ? rush.projects : []) {
      if (isObject(p) && typeof p.projectFolder === 'string') {
        add(
          p.projectFolder,
          typeof p.packageName === 'string' ? p.packageName : basename(p.projectFolder),
          'npm',
        );
      }
    }
  }

  // Nx projects (project.json) when no other JS workspace declaration exists
  if (monorepoTools.has('nx') && !jsGlobs.length) {
    for (const dir of r.dirsWith(/^project\.json$/)) {
      const pj = safeJson(r.files.get(`${dir}/project.json`));
      add(dir, typeof pj?.name === 'string' ? pj.name : basename(dir), 'nx');
    }
  }

  // Go workspaces
  const goWork = r.files.get('go.work');
  if (goWork !== undefined) {
    monorepoTools.add('go-work');
    for (const dir of parseGoWork(goWork)) {
      const clean = normalizeGlob(dir);
      if (clean && clean !== '.') add(clean, goModuleName(r, clean), 'go');
    }
  }

  // Cargo workspace
  const cargoRoot = r.files.get('Cargo.toml');
  if (cargoRoot) {
    const doc = parseTomlLite(cargoRoot);
    const members = tomlStrings(doc, 'workspace', 'members');
    const exclude = tomlStrings(doc, 'workspace', 'exclude');
    if (doc.workspace) monorepoTools.add('cargo-workspace');
    if (members.length) {
      const globs = [...members, ...exclude.map((e) => `!${e}`)];
      for (const dir of matchDirs(globs, r.dirsWith(/^Cargo\.toml$/)))
        add(dir, cargoPackageName(r, dir), 'cargo');
    }
  }

  // uv workspace
  const pyRoot = r.files.get('pyproject.toml');
  if (pyRoot) {
    const doc = parseTomlLite(pyRoot);
    const members = tomlStrings(doc, 'tool.uv.workspace', 'members');
    if (members.length) {
      monorepoTools.add('uv-workspace');
      const exclude = tomlStrings(doc, 'tool.uv.workspace', 'exclude');
      for (const dir of matchDirs(
        [...members, ...exclude.map((e) => `!${e}`)],
        r.dirsWith(/^pyproject\.toml$/),
      )) {
        add(dir, pyPackageName(r, dir), 'python');
      }
    }
  }

  // Maven multi-module
  const pomRoot = r.files.get('pom.xml');
  if (pomRoot) {
    const { modules } = parsePom(pomRoot);
    if (modules.length) {
      monorepoTools.add('maven-modules');
      for (const m of modules) add(m, pomName(r, normalizeGlob(m)), 'maven');
    }
  }

  // Gradle multi-project
  const gradleSettings = r.files.get('settings.gradle') ?? r.files.get('settings.gradle.kts');
  if (gradleSettings) {
    const projects = parseGradleSettings(gradleSettings);
    if (projects.length) {
      monorepoTools.add('gradle-multiproject');
      for (const p of projects) add(p, basename(p), 'gradle');
    }
  }

  // Heuristic: several independent manifests without a declared workspace (multi-service repos).
  if (out.size === 0) {
    const dirs = new Map<string, string>();
    for (const p of r.paths) {
      if (isExcluded(p) || depth(p) === 0 || depth(p) > 3) continue;
      const dir = dirname(p);
      if (NON_PACKAGE_DIR_RE.test(dir) || dirs.has(dir)) continue;
      const base = basename(p);
      if (!PRIMARY_MANIFEST_RE.test(base)) continue;
      dirs.set(dir, base);
    }
    // Only directories that are not nested inside another detected package.
    const topLevel = [...dirs.keys()].filter(
      (d) => ![...dirs.keys()].some((other) => other !== d && d.startsWith(`${other}/`)),
    );
    if (topLevel.length >= 2) {
      monorepoTools.add('heuristic');
      for (const dir of topLevel.sort()) {
        const manifest = dirs.get(dir) ?? '';
        const eco = heuristicEcosystem(manifest);
        const name =
          eco === 'npm'
            ? jsPackageName(r, dir)
            : eco === 'go'
              ? goModuleName(r, dir)
              : eco === 'cargo'
                ? cargoPackageName(r, dir)
                : eco === 'python'
                  ? pyPackageName(r, dir)
                  : eco === 'maven'
                    ? pomName(r, dir)
                    : basename(dir);
        add(dir, name, eco);
      }
    }
  }

  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Builds a {@link RepositoryProfile} from a tree listing plus selected file contents. */
export function analyzeRepositoryTree(input: AnalyzeRepositoryInput): RepositoryProfile {
  const files: ReadonlyMap<string, string> =
    input.files instanceof Map
      ? input.files
      : new Map(Object.entries(input.files as Record<string, string>));
  const paths = input.paths.filter((p) => typeof p === 'string' && p.length > 0);
  const pathSet = new Set(paths);
  const c: Collector = {
    frameworks: new Set(),
    buildTools: new Set(),
    packageManagers: new Set(),
    testFrameworks: new Set(),
    securityTools: new Set(),
    infrastructure: new Set(),
    ciSystems: new Set(),
  };
  const manifests: string[] = [];
  const ciWorkflows: string[] = [];
  const codeownersFiles: string[] = [];
  const prTemplates: string[] = [];
  const contributingFiles: string[] = [];
  const securityPolicies: string[] = [];
  const architectureDocs = new Set<string>();
  const docsDirs = new Set<string>();
  const adrDirs = new Set<string>();

  for (const p of paths) {
    if (CODEOWNERS_LOCATIONS.includes(p as (typeof CODEOWNERS_LOCATIONS)[number]))
      codeownersFiles.push(p);
    if (isExcluded(p)) continue;
    const base = basename(p);
    const d = depth(p);

    if (PRIMARY_MANIFEST_RE.test(p)) manifests.push(p);
    if (WORKFLOW_RE.test(p)) ciWorkflows.push(p);
    for (const [re, name] of CI_FILES) if (re.test(p)) c.ciSystems.add(name);
    for (const [re, name] of SECURITY_FILES) if (re.test(p)) c.securityTools.add(name);
    for (const [re, name] of BUILD_TOOL_FILES) if (re.test(p)) c.buildTools.add(name);
    for (const [re, name] of TEST_CONFIG_FILES) if (re.test(p)) c.testFrameworks.add(name);
    for (const [re, name] of INFRA_FILES) if (re.test(p)) c.infrastructure.add(name);
    if (d <= 1 && LOCKFILE_MANAGERS[base] && (d === 0 || base.includes('lock'))) {
      c.packageManagers.add(LOCKFILE_MANAGERS[base]);
    }
    if (d <= 2 && /^requirements[^/]*\.txt$/.test(base)) c.packageManagers.add('pip');
    if (d === 0 && (base === 'gradlew' || base === 'mvnw'))
      c.buildTools.add(base === 'gradlew' ? 'gradle' : 'maven');

    if (PR_TEMPLATE_RE.test(p) || PR_TEMPLATE_DIR_RE.test(p)) prTemplates.push(p);
    if (CONTRIBUTING_RE.test(p)) contributingFiles.push(p);
    if (SECURITY_POLICY_RE.test(p)) securityPolicies.push(p);
    if (ARCH_DOC_RE.test(p) || DOCS_ARCH_FILE_RE.test(p)) architectureDocs.add(p);

    // Directory-based detection from every ancestor (up to depth 3).
    const segments = p.split('/').slice(0, -1);
    for (let i = 0; i < Math.min(segments.length, 4); i++) {
      const seg = segments[i] ?? '';
      const dirPath = segments.slice(0, i + 1).join('/');
      if (i <= 1 && DOCS_DIR_NAMES.test(seg)) docsDirs.add(dirPath);
      const parent = segments[i - 1] ?? '';
      if (
        ADR_DIR_NAMES.test(seg) ||
        (AMBIGUOUS_ADR_DIR_NAMES.test(seg) &&
          (DOCS_DIR_NAMES.test(parent) || /^architecture$/i.test(parent)))
      ) {
        adrDirs.add(dirPath);
      }
    }
  }

  // Content-based detection.
  let rootPkg: Record<string, unknown> | null = null;
  for (const [path, text] of files) {
    if (isExcluded(path)) continue;
    const base = basename(path);
    try {
      if (base === 'package.json') {
        const pkg = safeJson(text);
        if (pkg) {
          analyzePackageJson(pkg, c);
          if (path === 'package.json') rootPkg = pkg;
        }
      } else if (base === 'pyproject.toml') {
        analyzePyproject(parseTomlLite(text), c);
      } else if (/^requirements[^/]*\.txt$/.test(base)) {
        analyzePythonDeps(parseRequirementsTxt(text), c);
      } else if (base === 'Pipfile') {
        const doc = parseTomlLite(text);
        analyzePythonDeps([...tomlKeys(doc, 'packages'), ...tomlKeys(doc, 'dev-packages')], c);
      } else if (base === 'setup.py' || base === 'setup.cfg') {
        const names = [
          ...text.matchAll(/['"]([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:[<>=!~;[]|['"])/g),
        ].map((m) => m[1] ?? '');
        analyzePythonDeps(names, c);
      } else if (base === 'go.mod') {
        analyzeGoMod(text, c);
      } else if (base === 'pom.xml' || /^build\.gradle(\.kts)?$/.test(base)) {
        analyzeJvm(text, c);
      } else if (base === 'Gemfile') {
        const gems = parseGemfile(text);
        applyMap(gems, RUBY_FRAMEWORKS, c.frameworks);
        applyMap(gems, RUBY_TEST_FRAMEWORKS, c.testFrameworks);
        for (const g of gems) {
          if (g === 'brakeman') c.securityTools.add('brakeman');
          if (g === 'bundler-audit') c.securityTools.add('bundler-audit');
        }
      } else if (base === 'composer.json') {
        const pkg = safeJson(text);
        if (pkg) analyzeComposer(pkg, c);
      } else if (base === 'Cargo.toml') {
        analyzeCargo(parseTomlLite(text), c);
      } else if (/\.(cs|fs)proj$/.test(base)) {
        analyzeCsproj(text, c);
      } else if (base === 'pubspec.yaml') {
        if (/^\s*flutter\s*:/m.test(text)) c.frameworks.add('flutter');
        if (/^\s*(flutter_test|test)\s*:/m.test(text))
          c.testFrameworks.add(/flutter_test/.test(text) ? 'flutter-test' : 'dart-test');
      } else if (base === 'mix.exs') {
        if (/:phoenix\b/.test(text)) c.frameworks.add('phoenix');
        if (/:ecto\b/.test(text)) c.frameworks.add('ecto');
        c.testFrameworks.add('exunit');
      } else if (base === 'Package.swift') {
        if (/vapor\/vapor/.test(text)) c.frameworks.add('vapor');
        c.testFrameworks.add('xctest');
      }
      if (
        WORKFLOW_RE.test(path) ||
        base === '.pre-commit-config.yaml' ||
        base === '.gitlab-ci.yml' ||
        base === 'Jenkinsfile'
      ) {
        for (const [re, name] of SECURITY_CONTENT) if (re.test(text)) c.securityTools.add(name);
      }
    } catch {
      // Discovery is best-effort: a malformed file must not break the profile.
    }
  }

  // npm is the implicit manager for a JS project with no lockfile/packageManager field.
  if (
    pathSet.has('package.json') &&
    ![...c.packageManagers].some((m) => ['npm', 'yarn', 'pnpm', 'bun'].includes(m))
  ) {
    c.packageManagers.add('npm');
  }

  const monorepoTools = new Set<string>();
  const packages = resolvePackages(makeResolver(paths, files), rootPkg, monorepoTools);

  // CODEOWNERS / templates / contributing: GitHub precedence (.github/, root, docs/).
  codeownersFiles.sort((a, b) => locationRank(a) - locationRank(b));
  const codeowners = codeownersFiles[0] ?? null;
  const codeownersText = codeowners ? files.get(codeowners) : undefined;
  const codeownersRules: CodeownersRule[] = codeownersText ? parseCodeowners(codeownersText) : [];
  prTemplates.sort((a, b) => {
    const dirA = PR_TEMPLATE_DIR_RE.test(a) ? 1 : 0;
    const dirB = PR_TEMPLATE_DIR_RE.test(b) ? 1 : 0;
    return dirA - dirB || locationRank(a) - locationRank(b) || a.localeCompare(b);
  });
  contributingFiles.sort((a, b) => locationRank(a) - locationRank(b));
  securityPolicies.sort((a, b) => locationRank(a) - locationRank(b));
  for (const dir of adrDirs) architectureDocs.add(`${dir}/`);

  const languages = { ...(input.languages ?? {}) };
  const primaryLanguage =
    Object.entries(languages).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ??
    null;

  const limitations = [...(input.limitations ?? [])];
  if (input.treeTruncated) {
    limitations.push('Repository tree was truncated by GitHub; some files were not inspected');
  }

  return {
    languages,
    primaryLanguage,
    frameworks: sortedUnique(c.frameworks),
    buildTools: sortedUnique(c.buildTools),
    packageManagers: sortedUnique(c.packageManagers),
    testFrameworks: sortedUnique(c.testFrameworks),
    ciSystems: sortedUnique(c.ciSystems),
    ciWorkflows: ciWorkflows.sort(),
    securityTools: sortedUnique(c.securityTools),
    infrastructure: sortedUnique(c.infrastructure),
    codeowners,
    codeownersFiles,
    codeownersRules,
    prTemplate: prTemplates[0] ?? null,
    prTemplates,
    contributing: contributingFiles[0] ?? null,
    securityPolicy: securityPolicies[0] ?? null,
    architectureDocs: [...architectureDocs].sort().slice(0, 50),
    docsDirs: sortedUnique(docsDirs).slice(0, 20),
    adrDirs: sortedUnique(adrDirs).slice(0, 20),
    packages,
    monorepoTools: sortedUnique(monorepoTools),
    isMonorepo:
      packages.length >= 2 ||
      (monorepoTools.size > 0 && !monorepoTools.has('heuristic') && packages.length > 0),
    manifests: manifests.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b)).slice(0, 500),
    defaultBranch: input.defaultBranch,
    ref: input.ref ?? input.defaultBranch,
    headSha: input.headSha,
    treeTruncated: input.treeTruncated ?? false,
    limitations,
    discoveredAt: (input.now ?? new Date()).toISOString(),
  };
}
