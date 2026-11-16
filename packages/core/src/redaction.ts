/**
 * Secret redaction for text that may leave the process (AI prompts, logs, notifications).
 *
 * Covers well-known token formats, PEM private key blocks, JWTs, credentials embedded in
 * URLs, Authorization headers and generic `password/secret/token/api_key = "<value>"`
 * assignments whose value looks like a real secret (length + entropy + not a placeholder or
 * a code reference such as `process.env.X`).
 */

export interface SecretRule {
  /** Stable identifier, also used in the replacement marker `[REDACTED:<id>]`. */
  id: string;
  /** Human description. */
  description: string;
  /** Global regex. When it has a named group `secret`, only that group is replaced. */
  pattern: RegExp;
}

export interface RedactionResult {
  text: string;
  redactions: number;
}

const B = '(?<![A-Za-z0-9_])'; // left boundary that also works before `-`
const E = '(?![A-Za-z0-9_])'; // right boundary

/**
 * Ordered list of token-format rules. Order matters: more specific rules first
 * (e.g. Anthropic `sk-ant-` before the generic OpenAI `sk-`).
 */
export const SECRET_RULES: readonly SecretRule[] = [
  {
    id: 'private_key',
    description: 'PEM / PGP / OpenSSH private key block',
    pattern: /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?-----END \1-----/g,
  },
  {
    id: 'private_key',
    description: 'Truncated PEM private key block (no END marker)',
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:[\s+-]*[A-Za-z0-9+/=:,-]{8,})+/g,
  },
  {
    id: 'github_token',
    description: 'GitHub personal/OAuth/app/refresh token',
    pattern: new RegExp(`${B}gh[pousr]_[A-Za-z0-9]{36,255}${E}`, 'g'),
  },
  {
    id: 'github_token',
    description: 'GitHub fine-grained personal access token',
    pattern: new RegExp(`${B}github_pat_[A-Za-z0-9_]{22,255}${E}`, 'g'),
  },
  {
    id: 'aws_access_key_id',
    description: 'AWS access key id',
    pattern: new RegExp(`${B}(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[A-Z0-9]{16}${E}`, 'g'),
  },
  {
    id: 'slack_token',
    description: 'Slack token',
    pattern: new RegExp(`${B}xox[abposr]-[A-Za-z0-9-]{10,250}`, 'g'),
  },
  {
    id: 'slack_webhook',
    description: 'Slack incoming webhook URL',
    pattern:
      /https:\/\/hooks\.slack(?:-gov)?\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/+-]{16,}/g,
  },
  {
    id: 'stripe_key',
    description: 'Stripe secret/restricted key',
    pattern: new RegExp(`${B}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,255}${E}`, 'g'),
  },
  {
    id: 'stripe_webhook_secret',
    description: 'Stripe webhook signing secret',
    pattern: new RegExp(`${B}whsec_[A-Za-z0-9]{24,}${E}`, 'g'),
  },
  {
    id: 'anthropic_key',
    description: 'Anthropic API key',
    pattern: new RegExp(`${B}sk-ant-(?:api|admin)?[0-9]{0,2}-?[A-Za-z0-9_-]{20,255}`, 'g'),
  },
  {
    id: 'openai_key',
    description: 'OpenAI API key',
    pattern: new RegExp(`${B}sk-(?:proj-|svcacct-|admin-|None-)?[A-Za-z0-9_-]{20,255}${E}`, 'g'),
  },
  {
    id: 'google_api_key',
    description: 'Google API key',
    pattern: new RegExp(`${B}AIza[0-9A-Za-z_-]{35}${E}`, 'g'),
  },
  {
    id: 'google_oauth_secret',
    description: 'Google OAuth client secret',
    pattern: new RegExp(`${B}GOCSPX-[A-Za-z0-9_-]{28}${E}`, 'g'),
  },
  {
    id: 'gitlab_token',
    description: 'GitLab personal access token',
    pattern: new RegExp(`${B}glpat-[A-Za-z0-9_-]{20,}${E}`, 'g'),
  },
  {
    id: 'npm_token',
    description: 'npm access token',
    pattern: new RegExp(`${B}npm_[A-Za-z0-9]{36}${E}`, 'g'),
  },
  {
    id: 'huggingface_token',
    description: 'Hugging Face token',
    pattern: new RegExp(`${B}hf_[A-Za-z0-9]{34,}${E}`, 'g'),
  },
  {
    id: 'sendgrid_key',
    description: 'SendGrid API key',
    pattern: new RegExp(`${B}SG\\.[A-Za-z0-9_-]{16,32}\\.[A-Za-z0-9_-]{16,64}${E}`, 'g'),
  },
  {
    id: 'jwt',
    description: 'JSON Web Token',
    pattern: new RegExp(
      `${B}eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}${E}`,
      'g',
    ),
  },
  {
    id: 'url_credentials',
    description: 'Password embedded in a URL (scheme://user:password@host)',
    pattern: /(?<=[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:)(?<secret>[^\s@/'"`]{3,})(?=@[^\s@]+)/gi,
  },
  {
    id: 'authorization_header',
    description: 'Authorization header credentials',
    pattern:
      /(?<=\b(?:authorization|proxy-authorization)["']?\s*[:=]\s*["']?(?:bearer|basic|token|bot)\s+)(?<secret>[A-Za-z0-9._~+/=-]{8,})/gi,
  },
  {
    id: 'bearer_token',
    description: 'Bearer token',
    pattern: /(?<=\bbearer\s+)(?<secret>[A-Za-z0-9._~+/-]{20,}=*)/gi,
  },
];

/**
 * Generic `name <sep> value` assignment where the name suggests a secret.
 * Handles `KEY=value`, `key: value`, `"key": "value"`, `key := "value"`, `key => 'value'`.
 * Groups: name, q (opening quote), value.
 */
const ASSIGNMENT_PATTERN =
  /(?<![A-Za-z0-9_.-])(?<name>[A-Za-z0-9_.-]+)(?<sep>["']?\s*(?::=|=>|==|=|:)\s*)(?<q>["'`]?)(?<value>[^\s"'`,;)\]}]+)\k<q>/g;

/**
 * Names that suggest a secret. Checked separately from {@link ASSIGNMENT_PATTERN}: embedding
 * the keyword alternation between two unbounded identifier classes made the regex backtrack
 * cubically on long identifier-like runs (e.g. minified code, base64 blobs).
 */
const SECRET_NAME_RE =
  /password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?key|credentials?|signing[_-]?key|encryption[_-]?key|master[_-]?key/i;

const PLACEHOLDER_RE =
  /^(?:x+|\*+|\.+|-+|_+|<[^>]*>|\{\{.*\}\}|\$\{.*\}|\$[A-Z_][A-Z0-9_]*|%[A-Z_]+%|null|nil|none|undefined|true|false|changeme|change[-_]me|password|secret|token|example|redacted|your[-_].*|placeholder|todo|tbd|dummy|test|xxx.*)$/i;

/** Values that are clearly code references rather than literal secrets. */
const REFERENCE_RE =
  /^(?:process\.env|os\.environ|os\.getenv|env\.|getenv|System\.getenv|config\.|settings\.|ENV\[|import\.meta\.env|secrets\.|vars\.|req\.|request\.|this\.|self\.|ctx\.|options\.|opts\.|params\.|args\.)/;

/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Heuristic: does an assignment value look like a real secret? */
export function looksLikeSecretValue(value: string, quoted: boolean): boolean {
  if (value.includes('[REDACTED')) return false;
  if (PLACEHOLDER_RE.test(value)) return false;
  // Template / env interpolation (`${VAR}`, `$(cmd)`, `{{ var }}`, `<placeholder>`, `%VAR%`).
  if (/^(?:\$[{(A-Za-z_]|\{\{|<|%)/.test(value)) return false;
  if (REFERENCE_RE.test(value)) return false;
  // Function calls / property paths / numbers are code, not literals.
  if (!quoted && /[()]/.test(value)) return false;
  if (!quoted && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) return false;
  if (/^\d+(?:\.\d+)?$/.test(value)) return false;
  const minLength = quoted ? 8 : 12;
  if (value.length < minLength) return false;
  const entropy = shannonEntropy(value);
  const classes =
    Number(/[a-z]/.test(value)) +
    Number(/[A-Z]/.test(value)) +
    Number(/[0-9]/.test(value)) +
    Number(/[^A-Za-z0-9]/.test(value));
  if (quoted) return entropy >= 2.8 && classes >= 2;
  // Unquoted (env files, YAML): require a stronger signal; plain identifiers/words are skipped.
  if (/^[A-Za-z_]+$/.test(value)) return false;
  return entropy >= 3.3 && classes >= 2;
}

function replaceRule(text: string, rule: SecretRule): { text: string; count: number } {
  let count = 0;
  const marker = `[REDACTED:${rule.id}]`;
  const out = text.replace(rule.pattern, (...args: unknown[]) => {
    const match = args[0] as string;
    const last = args[args.length - 1];
    const groups =
      typeof last === 'object' && last !== null
        ? (last as Record<string, string | undefined>)
        : undefined;
    const secret = groups?.secret;
    if (secret !== undefined) {
      if (secret.startsWith('[REDACTED')) return match;
      count++;
      return match.replace(secret, marker);
    }
    if (match.startsWith('[REDACTED')) return match;
    count++;
    return marker;
  });
  return { text: out, count };
}

/**
 * Replaces secret-looking values of `name <sep> value` assignments with `[REDACTED]`. Runs in
 * linear time: the pattern only starts at identifier boundaries, and when a name is not
 * secret-like the scan resumes right after the name, so assignments nested in a value
 * (`url: "token=..."`) are still found.
 */
function redactAssignments(text: string, onRedact: () => void): string {
  const re = new RegExp(ASSIGNMENT_PATTERN.source, ASSIGNMENT_PATTERN.flags);
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const { name = '', sep = '', q = '', value = '' } = m.groups ?? {};
    if (!SECRET_NAME_RE.test(name)) {
      re.lastIndex = m.index + Math.max(1, name.length);
      continue;
    }
    if (!looksLikeSecretValue(value, q !== '')) continue;
    onRedact();
    out += `${text.slice(last, m.index)}${name}${sep}${q}[REDACTED]${q}`;
    last = m.index + m[0].length;
  }
  return last === 0 ? text : out + text.slice(last);
}

/**
 * Redacts secrets from `text`. Each secret is replaced with `[REDACTED:<rule-id>]`
 * (assignment values with `[REDACTED]`), keeping surrounding context (variable names,
 * URL host, header name) intact. Idempotent.
 */
export function redactSecrets(text: string): RedactionResult {
  if (!text) return { text: text ?? '', redactions: 0 };
  let result = text;
  let redactions = 0;
  for (const rule of SECRET_RULES) {
    rule.pattern.lastIndex = 0;
    const r = replaceRule(result, rule);
    result = r.text;
    redactions += r.count;
  }
  result = redactAssignments(result, () => redactions++);
  return { text: result, redactions };
}

/** True when {@link redactSecrets} would redact something. */
export function containsSecret(text: string): boolean {
  return redactSecrets(text).redactions > 0;
}

/**
 * Deeply redacts all string values in a JSON-like structure (objects, arrays).
 * Returns a new structure; the input is not mutated.
 */
export function redactSecretsDeep<T>(value: T): { value: T; redactions: number } {
  let redactions = 0;
  const seen = new WeakMap<object, unknown>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redactSecrets(v);
      redactions += r.redactions;
      return r.text;
    }
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return seen.get(v);
    if (Array.isArray(v)) {
      const arr: unknown[] = [];
      seen.set(v, arr);
      for (const item of v) arr.push(walk(item));
      return arr;
    }
    if (v instanceof Date || Buffer.isBuffer(v)) return v;
    const obj: Record<string, unknown> = {};
    seen.set(v, obj);
    for (const [k, item] of Object.entries(v)) obj[k] = walk(item);
    return obj;
  };
  const out = walk(value) as T;
  return { value: out, redactions };
}
