/** Language detection and path classification helpers (path-only, no I/O). */
import type { ConfigKind } from './types.ts';

const EXTENSIONS: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  py: 'python',
  pyi: 'python',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  rb: 'ruby',
  rake: 'ruby',
  php: 'php',
  cs: 'csharp',
  rs: 'rust',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  m: 'objc',
  dart: 'dart',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  lua: 'lua',
  r: 'r',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  graphqls: 'graphql',
  proto: 'proto',
  prisma: 'prisma',
  yml: 'yaml',
  yaml: 'yaml',
  json: 'json',
  jsonc: 'json',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'properties',
  xml: 'xml',
  gradle: 'gradle',
  md: 'markdown',
  mdx: 'markdown',
  rst: 'markdown',
  txt: 'text',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  tf: 'terraform',
  tfvars: 'terraform',
  hcl: 'terraform',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'css',
  sass: 'css',
  less: 'css',
  vue: 'vue',
  svelte: 'svelte',
  erb: 'erb',
};

const FILENAMES: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  gemfile: 'ruby',
  rakefile: 'ruby',
  podfile: 'ruby',
  jenkinsfile: 'groovy',
  'go.mod': 'gomod',
  'go.sum': 'gomod',
  'requirements.txt': 'pip-requirements',
  pipfile: 'toml',
};

/** Basename of a POSIX-ish path. */
export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * Detects the language of a file from its path. Returns a lower-case id such as
 * `typescript`, `tsx`, `javascript`, `python`, `go`, `java`, `sql`, `graphql`, `proto`,
 * `prisma`, `yaml`, `dotenv`, `dockerfile`, ... or `unknown`.
 */
export function detectLanguage(path: string): string {
  const base = basename(path).toLowerCase();
  if (base === '.env' || base.startsWith('.env.') || base.endsWith('.env')) return 'dotenv';
  const byName = FILENAMES[base];
  if (byName) return byName;
  if (base.startsWith('dockerfile') || base.endsWith('.dockerfile')) return 'dockerfile';
  if (/^requirements.*\.txt$/.test(base)) return 'pip-requirements';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 && !base.startsWith('.')) return 'unknown';
  const ext = base.slice(dot + 1);
  return EXTENSIONS[ext] ?? 'unknown';
}

/** Languages with tree-sitter grammars bundled. */
export const TREE_SITTER_LANGUAGES = [
  'typescript',
  'tsx',
  'javascript',
  'python',
  'go',
  'java',
] as const;
export type TreeSitterLanguage = (typeof TREE_SITTER_LANGUAGES)[number];

export function isTreeSitterLanguage(lang: string): lang is TreeSitterLanguage {
  return (TREE_SITTER_LANGUAGES as readonly string[]).includes(lang);
}

/** Programming languages whose files count as "source" for test-coverage purposes. */
const SOURCE_LANGUAGES = new Set([
  'typescript',
  'tsx',
  'javascript',
  'python',
  'go',
  'java',
  'kotlin',
  'scala',
  'ruby',
  'php',
  'csharp',
  'rust',
  'swift',
  'c',
  'cpp',
  'objc',
  'dart',
  'elixir',
  'erlang',
  'lua',
  'vue',
  'svelte',
]);

export function isSourceLanguage(lang: string): boolean {
  return SOURCE_LANGUAGES.has(lang);
}

const TEST_PATH =
  /(?:^|\/)(?:__tests__|__mocks__|tests?|spec|specs|testing|e2e|cypress|playwright)\/|(?:^|\/)test_[^/]+\.py$|_test\.(?:go|py|rb|exs?)$|\.(?:test|spec|e2e-spec|cy)\.[cm]?[jt]sx?$|(?:Test|Tests|IT|Spec)\.(?:java|kt|scala|cs|swift)$|_spec\.rb$|(?:^|\/)conftest\.py$/;

/** True for test files / test directories across common ecosystems. */
export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

/** Fixture / example / documentation sample paths (lower confidence for secrets & rules). */
export function isFixtureOrExamplePath(path: string): boolean {
  return /(?:^|\/)(?:fixtures?|__fixtures__|testdata|test-data|examples?|samples?|mocks?|__snapshots__|docs?)\/|\.(?:example|sample|template|tmpl|dist)(?:\.|$)|\.snap$/i.test(
    path,
  );
}

export function isDocumentationPath(path: string): boolean {
  const lang = detectLanguage(path);
  return (
    lang === 'markdown' ||
    lang === 'text' ||
    /(?:^|\/)(?:docs?|documentation)\//i.test(path) ||
    /^(?:license|notice|authors|changelog|contributing)(?:\.|$)/i.test(basename(path))
  );
}

const GENERATED =
  /(?:^|\/)(?:dist|build|out|vendor|node_modules|\.next|coverage|target|bin|obj)\/|\.min\.(?:js|css)$|\.(?:pb\.go|pb\.ts|_pb2\.py|_pb2_grpc\.py|generated\.[a-z]+|g\.dart|freezed\.dart)$|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|Pipfile\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|go\.sum|bun\.lockb?)$/;

/** Lock files, build output, vendored or generated code. */
export function isGeneratedPath(path: string): boolean {
  return GENERATED.test(path);
}

export function isLockFile(path: string): boolean {
  return /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|Pipfile\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|go\.sum|bun\.lockb?|gradle\.lockfile)$/.test(
    path,
  );
}

export function isWorkflowPath(path: string): boolean {
  return (
    /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) ||
    /(?:^|\/)\.gitlab-ci\.ya?ml$/.test(path) ||
    /^\.circleci\/config\.ya?ml$/.test(path) ||
    /(?:^|\/)(?:azure-pipelines|bitbucket-pipelines|\.travis|cloudbuild|buildkite)\.ya?ml$/.test(
      path,
    ) ||
    /^\.buildkite\/.+\.ya?ml$/.test(path) ||
    /(?:^|\/)Jenkinsfile$/.test(path)
  );
}

export function isGithubActionsWorkflow(path: string): boolean {
  return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);
}

const MANIFESTS =
  /(?:^|\/)(?:package\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|setup\.py|setup\.cfg|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|Gemfile|Cargo\.toml|composer\.json)$/;

/** Dependency manifests (lock files are excluded). */
export function isDependencyManifest(path: string): boolean {
  return MANIFESTS.test(path);
}

/** Directory-based migration conventions + plain .sql files under a migrations-ish dir. */
const MIGRATION_PATH =
  /(?:^|\/)(?:migrations?|migrate|db\/migrate|alembic\/versions|flyway|liquibase|changelogs?|drizzle|prisma\/migrations|schema_migrations|sql\/migrations?|database\/migrations)\//i;

export function isMigrationPath(path: string): boolean {
  if (MIGRATION_PATH.test(path)) {
    const lang = detectLanguage(path);
    return [
      'sql',
      'python',
      'ruby',
      'typescript',
      'javascript',
      'java',
      'go',
      'php',
      'xml',
      'yaml',
      'kotlin',
    ].includes(lang);
  }
  // Flyway naming: V1__init.sql, R__views.sql; or any *.up.sql / *.down.sql
  return /(?:^|\/)(?:V\d+(?:[._]\d+)*__|R__)[^/]+\.sql$|\.(?:up|down)\.sql$/i.test(path);
}

/** ORM / schema definition files (not migrations) whose table definitions matter. */
export function isSchemaDefinitionPath(path: string): boolean {
  const base = basename(path);
  return (
    base.endsWith('.prisma') ||
    /(?:^|\/)schema\.(?:ts|js|mjs|sql|rb)$/.test(path) ||
    /(?:^|\/)(?:schema|tables|entities|entity|models?)\//.test(path) ||
    /\.entity\.(?:ts|js)$/.test(base) ||
    /(?:^|\/)models\.py$/.test(path) ||
    /(?:^|\/)structure\.sql$/.test(path)
  );
}

export function classifyConfig(path: string): { kind: ConfigKind; infrastructure: boolean } | null {
  const base = basename(path);
  const lower = base.toLowerCase();
  const lang = detectLanguage(path);
  if (lang === 'dockerfile' || lower === '.dockerignore')
    return { kind: 'docker', infrastructure: true };
  if (/^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/.test(lower))
    return { kind: 'compose', infrastructure: true };
  if (
    /(?:^|\/)(?:charts?|helm)\//.test(path) ||
    lower === 'chart.yaml' ||
    /^values(?:[.-][\w-]+)?\.ya?ml$/.test(lower)
  )
    return { kind: 'helm', infrastructure: true };
  if (
    /(?:^|\/)(?:k8s|kubernetes|kustomize|manifests|deploy|deployment|infra|ops)\//.test(path) &&
    lang === 'yaml'
  )
    return { kind: 'kubernetes', infrastructure: true };
  if (lang === 'terraform' || /(?:^|\/)(?:terraform|pulumi|cdk)\//.test(path))
    return { kind: 'terraform', infrastructure: true };
  if (lang === 'dotenv') return { kind: 'env', infrastructure: false };
  if (isWorkflowPath(path)) return { kind: 'ci', infrastructure: true };
  if (
    /^(?:tsconfig.*\.json|vite\.config\.[cm]?[jt]s|webpack\.config\.[cm]?[jt]s|rollup\.config\.[cm]?[jt]s|tsup\.config\.[cm]?[jt]s|babel\.config\.[cm]?[jt]s|\.babelrc|makefile|turbo\.json|nx\.json|pnpm-workspace\.yaml|lerna\.json|next\.config\.[cm]?[jt]s|nuxt\.config\.[cm]?[jt]s|angular\.json|setup\.cfg|tox\.ini|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|pom\.xml)$/.test(
      lower,
    )
  )
    return { kind: 'build', infrastructure: false };
  if (
    /^(?:\.eslintrc.*|eslint\.config\.[cm]?[jt]s|\.prettierrc.*|prettier\.config\.[cm]?[jt]s|\.editorconfig|\.stylelintrc.*|ruff\.toml|\.flake8|\.pylintrc|\.golangci\.ya?ml|checkstyle\.xml|biome\.json)$/.test(
      lower,
    )
  )
    return { kind: 'lint', infrastructure: false };
  if (
    /(?:^|\/)(?:config|configs|conf|settings)\//.test(path) ||
    /^(?:application|appsettings|settings|config)(?:[.-][\w-]+)?\.(?:ya?ml|json|properties|toml|ini)$/.test(
      lower,
    ) ||
    /^(?:nginx|httpd)\.conf$/.test(lower) ||
    lower === 'procfile' ||
    /^(?:vercel|netlify|fly|render|app|serverless)\.(?:json|toml|ya?ml)$/.test(lower)
  )
    return {
      kind: 'app_config',
      infrastructure: /nginx|httpd|procfile|vercel|netlify|fly|render|serverless/.test(lower),
    };
  return null;
}
