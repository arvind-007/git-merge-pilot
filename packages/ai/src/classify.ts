/** Lightweight path classification used for prompt prioritization and the deterministic narrative. */

const TEST_RE =
  /(^|\/)(__tests__|tests?|spec|specs|e2e|testing)\/|(\.|_|-)(test|spec)s?\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.go$|Tests?\.(java|kt|cs)$/i;
const DOC_RE =
  /(^|\/)(docs?|documentation)\/|\.(md|mdx|rst|adoc|txt)$|(^|\/)(LICENSE|NOTICE|CHANGELOG|AUTHORS)(\.[a-z]+)?$/i;
const MIGRATION_RE =
  /(^|\/)(migrations?|migrate|db\/migrate|alembic\/versions|flyway|liquibase|drizzle|prisma\/migrations)\/|\.sql$/i;
const INFRA_RE =
  /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|\.github\/workflows\/[^/]+|\.gitlab-ci\.ya?ml|Jenkinsfile|helm\/|charts\/|k8s\/|kubernetes\/|terraform\/|infra\/|deploy\/|\.circleci\/)|\.(tf|tfvars|hcl)$/i;
const CONFIG_RE =
  /(^|\/)(\.env[^/]*|config\/|settings\.[a-z]+$|application\.(ya?ml|properties)$)|\.(ya?ml|toml|ini|cfg|conf|properties)$|(^|\/)(tsconfig[^/]*\.json|package\.json|pyproject\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|Cargo\.toml|requirements[^/]*\.txt)$/i;
const SECURITY_RE =
  /(auth|login|session|token|secret|crypt|password|permission|rbac|acl|oauth|jwt|csrf|cors|security|sanitiz|middleware|policy|credential|\.github\/workflows\/)/i;
const CONTRACT_RE =
  /(routes?|controllers?|handlers?|api|graphql|\.proto$|schema|openapi|swagger|events?|topics?|queues?|consumers?|producers?)/i;

export function isTestPath(path: string): boolean {
  return TEST_RE.test(path);
}
export function isDocPath(path: string): boolean {
  return DOC_RE.test(path);
}
export function isMigrationPath(path: string): boolean {
  return MIGRATION_RE.test(path);
}
export function isInfraPath(path: string): boolean {
  return INFRA_RE.test(path);
}
export function isConfigPath(path: string): boolean {
  return CONFIG_RE.test(path) && !isTestPath(path);
}
export function isSecuritySensitivePath(path: string): boolean {
  return SECURITY_RE.test(path);
}
export function isContractPath(path: string): boolean {
  return CONTRACT_RE.test(path);
}

/** Source code = not test, not doc, not pure config/infra. */
export function isSourcePath(path: string): boolean {
  return (
    !isTestPath(path) &&
    !isDocPath(path) &&
    !isInfraPath(path) &&
    !isConfigPath(path) &&
    /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rb|php|cs|rs|swift|scala|c|cc|cpp|h|hpp|vue|svelte|sql)$/i.test(
      path,
    )
  );
}

/** First meaningful directory segment(s) of a path, used as a "module" label. */
export function moduleOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 1) return '(root)';
  const containers = new Set([
    'packages',
    'apps',
    'services',
    'libs',
    'modules',
    'src',
    'cmd',
    'internal',
    'pkg',
  ]);
  if (containers.has(parts[0]!) && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts[0]!;
}

export function uniq<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function listPreview(items: readonly string[], max = 5): string {
  if (items.length === 0) return '';
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}
