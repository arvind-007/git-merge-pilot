/**
 * Security scan: built-in regex rules over ADDED lines (or full content when no patch is
 * available) plus optional gitleaks / semgrep when their binaries are on PATH.
 *
 * Findings never claim code is secure; they report concrete, verifiable patterns with
 * redacted evidence. External scanners are skipped gracefully (missing binary, timeout,
 * malformed output) and the reason is reported.
 */
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SECRET_RULES, redactSecrets, type Evidence, type Finding, type Severity } from '@gmp/core';
import { parseUnifiedDiff } from './diff.ts';
import { makeFinding, dedupeFindings } from './findings.ts';
import {
  detectLanguage,
  isDocumentationPath,
  isFixtureOrExamplePath,
  isGithubActionsWorkflow,
  isLockFile,
  isSourceLanguage,
  isTestPath,
} from './language.ts';
import type {
  NumberedLine,
  SecurityScanFile,
  SecurityScanInput,
  SecurityScanReport,
} from './types.ts';

// ---------------------------------------------------------------------------
// Rule definitions
// ---------------------------------------------------------------------------

export interface SecurityRuleInfo {
  id: string;
  title: string;
  severity: Severity;
  description: string;
  recommendation: string;
}

interface LineRule extends SecurityRuleInfo {
  patterns: RegExp[];
  /** Restrict to these languages (detectLanguage ids); null = code files only; 'any' = all files. */
  langs?: string[] | 'any' | null;
  /** Return a severity override, or null to skip this match. */
  refine?: (line: string, path: string) => Severity | null | undefined;
}

const CODE_LANGS_EXTRA = ['erb', 'html', 'vue', 'svelte', 'shell', 'dockerfile', 'yaml', 'groovy'];

const SQL_KW = String.raw`(?:SELECT\s[^'"\x60]*\bFROM|INSERT\s+INTO|UPDATE\s+[\w."\x60\[\]]+\s+SET|DELETE\s+FROM|\bWHERE\b|ORDER\s+BY|DROP\s+TABLE)`;

const LINE_RULES: LineRule[] = [
  {
    id: 'sql_injection',
    title: 'Database query built from variables',
    severity: 'high',
    description:
      'A database query is assembled by inserting values directly into the query text. If any of those values come from users, an attacker could read or change data they should not.',
    recommendation:
      'Use parameterized queries / placeholders (e.g. `$1`, `?`, `%s` with a separate parameters argument) or the ORM query builder.',
    patterns: [
      new RegExp(String.raw`\x60[^\x60]*${SQL_KW}[^\x60]*\$\{`, 'i'),
      new RegExp(String.raw`(['"])(?:(?!\1).)*${SQL_KW}(?:(?!\1).)*\1\s*\+\s*[\w$.(\[]`, 'i'),
      new RegExp(String.raw`[\w$)\]]\s*\+\s*(['"])[^'"]*${SQL_KW}`, 'i'),
      new RegExp(String.raw`\bf(['"])(?:(?!\1).)*${SQL_KW}(?:(?!\1).)*\{[^}]+\}`, 'i'),
      new RegExp(
        String.raw`(['"])(?:(?!\1).)*${SQL_KW}(?:(?!\1).)*%[sd](?:(?!\1).)*\1\s*%\s*[\w(]`,
        'i',
      ),
      new RegExp(String.raw`(['"])[^'"]*${SQL_KW}[^'"]*\{\w*\}[^'"]*\1\.format\(`, 'i'),
      new RegExp(String.raw`Sprintf\(\s*"[^"]*${SQL_KW}[^"]*%[svd]`, 'i'),
      new RegExp(String.raw`"[^"]*${SQL_KW}[^"]*#\{`, 'i'),
    ],
  },
  {
    id: 'command_injection',
    title: 'Shell command built from variables',
    severity: 'high',
    description:
      'A system command is run with values inserted into the command text. If those values can be influenced by users, an attacker could run arbitrary commands on the server.',
    recommendation:
      'Pass arguments as an array to a non-shell API (execFile/spawn without shell, subprocess.run([...]) without shell=True) and validate inputs.',
    patterns: [
      /\b(?:exec|execSync|spawnSync|spawn)\s*\(\s*(?:`[^`]*\$\{|['"][^'"]*['"]\s*\+|[\w$.]+\s*\+)/,
      /\bshell\s*:\s*true\b/,
      /\bos\.(?:system|popen)\s*\(\s*(?:f['"]|['"][^'"]*['"]\s*(?:%|\+|\.format)|[\w.]+\s*[,)])/,
      /\bsubprocess\.\w+\([^)]*shell\s*=\s*True/,
      /\bcommands\.getoutput\(/,
      /\bexec\.Command\(\s*"(?:sh|bash|zsh|cmd|cmd\.exe|powershell)"\s*,\s*"(?:-c|\/c|-Command)"/,
      /\bRuntime\.getRuntime\(\)\.exec\(\s*(?:[^")]*\+|"[^"]*"\s*\+)/,
      /\bnew\s+ProcessBuilder\(\s*"(?:sh|bash|cmd)"\s*,\s*"(?:-c|\/c)"/,
      /\b(?:system|exec|spawn)\(\s*"[^"]*#\{/,
      /%x[({[][^)}\]]*#\{/,
      /`[^`]*#\{[^}]+\}[^`]*`/,
      /\b(?:shell_exec|passthru|proc_open|popen)\s*\(\s*[^)]*\$\w+/,
      /\b(?:system|exec)\s*\(\s*["'][^"']*["']\s*\.\s*\$\w+/,
    ],
    refine: (line, path) => {
      const lang = detectLanguage(path);
      if (/`[^`]*#\{/.test(line) && lang !== 'ruby') return null;
      if (/\bshell\s*:\s*true\b/.test(line) && !['typescript', 'tsx', 'javascript'].includes(lang))
        return null;
      if (
        /\bshell\s*:\s*true\b/.test(line) ||
        /exec\.Command\(\s*"(?:sh|bash)/.test(line) ||
        /subprocess\.\w+\([^)]*shell\s*=\s*True/.test(line)
      ) {
        return /\$\{|\+|%|\.format|f["']|Sprintf/.test(line) ? 'high' : 'medium';
      }
      return undefined;
    },
  },
  {
    id: 'code_eval',
    title: 'Dynamic code execution (eval)',
    severity: 'high',
    description:
      'Text is executed as program code at runtime. If that text can be influenced by users, attackers can run their own code inside the application.',
    recommendation:
      'Avoid eval / new Function / exec on strings; parse data with a safe parser (e.g. JSON.parse, ast.literal_eval) instead.',
    patterns: [
      /(?<![\w$.])eval\s*\(/,
      /\bnew\s+Function\s*\(/,
      /\bset(?:Timeout|Interval)\s*\(\s*['"`]/,
      /(?<![\w.])exec\s*\(\s*(?!['"]\s*\))/,
      /\b(?:instance_eval|class_eval|module_eval)\s*\(?\s*(?:["'][^"']*#\{|[a-z_]\w*\s*\)?$)/,
    ],
    refine: (line, path) => {
      const lang = detectLanguage(path);
      // `exec(` is only Python's builtin; JS exec is handled by command_injection.
      if (/(?<![\w.])exec\s*\(/.test(line) && !/eval|Function|set(?:Timeout|Interval)/.test(line)) {
        if (lang !== 'python' || /^\s*(?:async\s+)?def\s/.test(line)) return null;
      }
      if (/^\s*(?:async\s+)?(?:def|function)\s+eval\b/.test(line)) return null;
      const arg = /(?:eval|exec|Function)\s*\(\s*(.)/.exec(line)?.[1];
      if (arg && /['"`]/.test(arg) && !/\$\{|\+|%|format|#\{/.test(line)) return 'medium';
      return undefined;
    },
  },
  {
    id: 'unsafe_html',
    title: 'Raw HTML inserted into the page',
    severity: 'medium',
    description:
      'Content is inserted into a web page as raw HTML. If any of it comes from users or external data, attackers could inject scripts (cross-site scripting) that act on behalf of other users.',
    recommendation:
      'Insert text (textContent / normal JSX), or sanitize HTML with a vetted library (e.g. DOMPurify) right before inserting it.',
    patterns: [
      /\.(?:innerHTML|outerHTML)\s*\+?=(?!=)\s*(?!['"`]\s*['"`]?\s*;?\s*$)/,
      /\bdangerouslySetInnerHTML\b/,
      /\bv-html\s*=/,
      /\binsertAdjacentHTML\s*\(/,
      /\bdocument\.write(?:ln)?\s*\(/,
      /\{\{[^}]*\|\s*safe\s*\}\}/,
      /\bmark_safe\s*\(/,
      /\.html_safe\b/,
      /\{!!\s*\$[^!]+!!\}/,
      /\bbypassSecurityTrust(?:Html|Script|Url|ResourceUrl|Style)\s*\(/,
      /<%==\s*/,
    ],
    langs: [
      'typescript',
      'tsx',
      'javascript',
      'vue',
      'svelte',
      'html',
      'python',
      'ruby',
      'erb',
      'php',
    ],
    refine: (line) => {
      if (
        /DOMPurify\.sanitize|sanitizeHtml|sanitize\(|bleach\.clean|escapeHtml|escape\(/.test(line)
      )
        return null;
      // static string literal with no interpolation
      if (/\.(?:innerHTML|outerHTML)\s*=\s*(['"])[^'"]*\1\s*;?\s*$/.test(line)) return null;
      if (/\.(?:innerHTML|outerHTML)\s*=\s*`[^`$]*`\s*;?\s*$/.test(line)) return null;
      return undefined;
    },
  },
  {
    id: 'tls_verification_disabled',
    title: 'Secure connection checks disabled',
    severity: 'high',
    description:
      'Certificate verification for encrypted (HTTPS/TLS) connections is turned off. Anyone on the network path could impersonate the server and read or alter the traffic.',
    recommendation:
      'Keep certificate verification on; trust a private CA explicitly (custom CA bundle) instead of disabling checks.',
    patterns: [
      /\brejectUnauthorized\s*:\s*false\b/,
      /\bNODE_TLS_REJECT_UNAUTHORIZED\b\s*[=:]\s*['"]?0/,
      /\bverify\s*=\s*False\b/,
      /\bInsecureSkipVerify\s*:\s*true\b/,
      /\bssl\._create_unverified_context\b/,
      /\bCERT_NONE\b/,
      /\bcheck_hostname\s*=\s*False\b/,
      /\bcurl\b[^|\n]*\s(?:-k|--insecure)\b/,
      /\bwget\b[^|\n]*--no-check-certificate/,
      /\b(?:NoopHostnameVerifier|TrustAllStrategy|ALLOW_ALL_HOSTNAME_VERIFIER|trustAllCerts|TrustAllCerts|InsecureTrustManagerFactory)\b/,
      /\bstrictSSL\s*:\s*false\b/,
      /\bServerCertificateValidationCallback\s*=.*=>\s*true/,
      /\bOpenSSL::SSL::VERIFY_NONE\b/,
      /\bverify_mode\s*[:=]\s*(?:OpenSSL::SSL::)?VERIFY_NONE/,
      /\bCURLOPT_SSL_VERIFYPEER\s*,\s*(?:false|0)/,
    ],
    langs: 'any',
    refine: (line, path) => (isDocumentationPath(path) ? null : undefined),
  },
  {
    id: 'weak_crypto',
    title: 'Weak or outdated cryptography',
    severity: 'medium',
    description:
      'An outdated hashing or encryption method (such as MD5, SHA-1, DES, RC4 or ECB mode) is used. These can be broken, so they must not protect passwords, tokens or sensitive data.',
    recommendation:
      'Use SHA-256 or better for integrity, bcrypt/scrypt/argon2 for passwords, and AES-GCM (or ChaCha20-Poly1305) for encryption.',
    patterns: [
      /\bcreateHash\(\s*['"`](?:md5|sha1|md4)['"`]/i,
      /\bhashlib\.(?:md5|sha1)\s*\(/,
      /\bhashlib\.new\(\s*['"](?:md5|sha1)['"]/i,
      /\bMessageDigest\.getInstance\(\s*"(?:MD5|MD2|SHA-?1)"/i,
      /\b(?:md5|sha1)\.(?:New|Sum)\s*\(/,
      /\bDigestUtils\.(?:md5|sha1|sha)(?:Hex)?\s*\(/,
      /\bCipher\.getInstance\(\s*"(?:DES|DESede|RC4|RC2|Blowfish|AES|AES\/ECB[^"]*)"/,
      /\bcreateCipher(?:iv)?\(\s*['"`](?:des|des-ede3?|rc4|rc2|bf|aes-\d+-ecb)(?:-\w+)?['"`]/i,
      /\bcreateCipher\s*\(/,
      /\b(?:DES|DES3|ARC4|Blowfish)\.new\s*\(/,
      /\bAES\.MODE_ECB\b/,
      /\bdes\.NewCipher\s*\(|\brc4\.NewCipher\s*\(/,
      /\bDigest::(?:MD5|SHA1)\b/,
      /\b(?:md5|sha1)\s*\(\s*\$/,
    ],
    refine: (line) => {
      if (/usedforsecurity\s*=\s*False/.test(line)) return null;
      if (/checksum|etag|e-tag|cache|fingerprint|dedup|content[-_ ]?hash|gravatar/i.test(line))
        return 'low';
      return undefined;
    },
  },
  {
    id: 'cors_wildcard',
    title: 'Cross-origin access open to any website',
    severity: 'medium',
    description:
      'The server allows any website to call it from a browser (CORS "*" or reflecting every origin). Combined with logged-in sessions this can let malicious sites read user data.',
    recommendation: 'Restrict allowed origins to a list of known front-end domains.',
    patterns: [
      /Access-Control-Allow-Origin['"]?\s*[,:=]\s*['"]\*['"]/i,
      /\borigin\s*:\s*(?:['"`]\*['"`]|true)\b/,
      /\bCORS_ORIGIN_ALLOW_ALL\s*=\s*True/,
      /\bCORS_ALLOW_ALL_ORIGINS\s*=\s*True/,
      /\bAllowAllOrigins\s*:\s*true/,
      /\bAllowOrigins\s*:\s*\[\]string\{\s*"\*"/,
      /@CrossOrigin\(\s*(?:origins\s*=\s*)?(?:\{\s*)?"\*"/,
      /@CrossOrigin\s*(?:\(\s*\))?\s*$/,
      /\ballow_origins\s*=\s*\[\s*['"]\*['"]/,
      /\bAllowAnyOrigin\s*\(\s*\)/,
      /\ballowedOrigins?\(\s*"\*"/,
      /\bcors\(\s*\)/,
    ],
    langs: [
      ...[
        'typescript',
        'tsx',
        'javascript',
        'python',
        'go',
        'java',
        'kotlin',
        'ruby',
        'php',
        'csharp',
        'scala',
      ],
      'yaml',
      'json',
    ],
    refine: (line) =>
      /credentials\s*:\s*true|allow_credentials\s*=\s*True|AllowCredentials\s*:\s*true|allowCredentials/.test(
        line,
      )
        ? 'high'
        : undefined,
  },
  {
    id: 'logging_secrets',
    title: 'Sensitive value written to logs',
    severity: 'medium',
    description:
      'A value that looks like a password, token or key is written to logs. Logs are widely accessible and retained, so secrets in them can leak.',
    recommendation:
      'Remove the value from the log statement or mask it (log only that it is present, or its last 4 characters).',
    patterns: [
      /\b(?:console\.(?:log|info|debug|warn|error|trace)|logger\.\w+|log\.(?:Print\w*|Info\w*|Debug\w*|Warn\w*|Error\w*|Fatal\w*|info|debug|warn|error|trace)|logging\.(?:info|debug|warning|error|exception|critical)|print|println|System\.(?:out|err)\.print\w*|fmt\.(?:Print|Fprint)\w*|puts|Log\.[a-z]|Rails\.logger\.\w+|error_log|slog\.\w+)\s*\(/,
    ],
    refine: (line) => {
      const call =
        /\b(?:console\.\w+|logger\.\w+|log\.\w+|logging\.\w+|print|println|System\.(?:out|err)\.\w+|fmt\.\w+|puts|Log\.\w+|Rails\.logger\.\w+|error_log|slog\.\w+)\s*\(([\s\S]*)$/.exec(
          line,
        );
      if (!call) return null;
      if (/redact|mask|\*\*\*|sanitiz/i.test(line)) return null;
      // Keep code and interpolations; drop literal text.
      const code = (call[1] ?? '')
        .replace(
          /`((?:\\.|[^`\\])*)`/g,
          (_, body: string) =>
            ` ${[...body.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]).join(' ')} `,
        )
        .replace(
          /f(['"])((?:\\.|(?!\1)[^\\])*)\1/g,
          (_, _q: string, body: string) =>
            ` ${[...body.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).join(' ')} `,
        )
        .replace(
          /(['"])((?:\\.|(?!\1)[^\\])*)\1/g,
          (_, _q: string, body: string) =>
            ` ${[...body.matchAll(/#\{([^}]*)\}/g)].map((m) => m[1]).join(' ')} `,
        );
      const m =
        /\b([\w.]*(?:password|passwd|secret|token|api_?key|apikey|access_?key|private_?key|credential|authorization|session_?id|cookie)\w*)\b/i.exec(
          code,
        );
      if (!m?.[1]) return null;
      const ident = m[1];
      if (
        /(?:count|length|len|size|tokens|expir\w*|type|name|usage|limit|url|uri|endpoint|path|header_name|ttl|id_?field|present|exists|valid\w*|required)$/i.test(
          ident,
        )
      )
        return null;
      if (/\b(?:input|output|max|total|cache_?read)_?tokens?\b/i.test(ident)) return null;
      return undefined;
    },
  },
  {
    id: 'unsafe_deserialization',
    title: 'Unsafe deserialization of data',
    severity: 'medium',
    description:
      'Data is loaded with a deserializer that can execute code or create arbitrary objects. If the data can come from outside, attackers could take over the process.',
    recommendation:
      'Use safe formats/loaders (JSON, yaml.safe_load, allow-listed classes) for untrusted data.',
    patterns: [
      /\bpickle\.loads?\s*\(/,
      /\bcPickle\.loads?\s*\(/,
      /\byaml\.load\s*\((?![^)]*Loader\s*=\s*(?:yaml\.)?(?:Safe|Base|CSafe)Loader)/,
      /\byaml\.unsafe_load\s*\(/,
      /\bMarshal\.load\s*\(/,
      /\bnew\s+ObjectInputStream\s*\(/,
      /\bunserialize\s*\(\s*\$/,
      /\bYAML\.load\s*\((?![^)]*permitted_classes)/,
      /\bBinaryFormatter\b/,
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isCommentLine(line: string, lang: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (
    t.startsWith('//') ||
    t.startsWith('/*') ||
    (t.startsWith('*') && !t.startsWith('*/') && lang !== 'markdown')
  )
    return true;
  if (
    t.startsWith('#') &&
    [
      'python',
      'ruby',
      'shell',
      'yaml',
      'dotenv',
      'toml',
      'dockerfile',
      'terraform',
      'r',
      'elixir',
    ].includes(lang)
  )
    return true;
  if (t.startsWith('--') && lang === 'sql') return true;
  if (t.startsWith('<!--')) return true;
  return false;
}

function snippetOf(line: string): string {
  const red = redactSecrets(line.trim()).text;
  return red.length > 200 ? `${red.slice(0, 200)}…` : red;
}

function downgrade(sev: Severity): Severity {
  const order: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
  const i = order.indexOf(sev);
  return order[Math.min(order.length - 1, i + 2)] ?? 'low';
}

interface ScanTarget {
  path: string;
  lang: string;
  lines: NumberedLine[];
  /** New-side text (added + context lines, or whole content) for multi-line rules. */
  context: NumberedLine[];
  addedLineSet: Set<number> | null;
}

function targetsFor(files: SecurityScanFile[]): ScanTarget[] {
  const out: ScanTarget[] = [];
  for (const f of files) {
    const status = (f.status ?? '').toLowerCase();
    if (status === 'removed' || status === 'deleted') continue;
    if (isLockFile(f.path)) continue;
    const lang = detectLanguage(f.path);
    if (f.patch) {
      const hunks = parseUnifiedDiff(f.patch);
      const added = hunks.flatMap((h) => h.added);
      const ctx: NumberedLine[] = [];
      for (const h of hunks)
        for (const l of h.lines)
          if (l.type !== 'del' && l.newLine !== undefined)
            ctx.push({ line: l.newLine, content: l.content });
      const full = f.content
        ? f.content.split('\n').map((content, i) => ({ line: i + 1, content }))
        : ctx;
      out.push({
        path: f.path,
        lang,
        lines: added,
        context: full,
        addedLineSet: new Set(added.map((l) => l.line)),
      });
    } else if (f.content) {
      const all = f.content.split('\n').map((content, i) => ({ line: i + 1, content }));
      out.push({ path: f.path, lang, lines: all, context: all, addedLineSet: null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Built-in scanning
// ---------------------------------------------------------------------------

const SECRET_SEVERITY: Record<string, Severity> = {
  private_key: 'critical',
  aws_access_key_id: 'critical',
  github_token: 'critical',
  stripe_key: 'critical',
  anthropic_key: 'critical',
  openai_key: 'critical',
  gitlab_token: 'critical',
  google_oauth_secret: 'high',
  google_api_key: 'high',
  slack_token: 'high',
  slack_webhook: 'high',
  stripe_webhook_secret: 'high',
  npm_token: 'high',
  huggingface_token: 'high',
  sendgrid_key: 'high',
  jwt: 'medium',
  url_credentials: 'high',
  authorization_header: 'high',
  bearer_token: 'high',
  generic_secret_assignment: 'high',
};

function secretFindings(repo: string, t: ScanTarget): Finding[] {
  const out: Finding[] = [];
  const lowConfidencePath =
    isTestPath(t.path) || isFixtureOrExamplePath(t.path) || isDocumentationPath(t.path);
  // Multi-line PEM blocks: scan the joined added text for private keys.
  const joined = t.lines.map((l) => l.content).join('\n');
  const occurrences = new Map<string, number>();
  const emit = (ruleId: string, line: number, text: string) => {
    let sev = SECRET_SEVERITY[ruleId] ?? 'high';
    if (
      ruleId === 'url_credentials' &&
      /@(?:localhost|127\.0\.0\.1|0\.0\.0\.0|db|postgres|mysql|redis|mongo|example\.com)\b/.test(
        text,
      )
    )
      sev = 'low';
    if (lowConfidencePath) sev = downgrade(sev);
    const snippet = snippetOf(text);
    const key = `${ruleId}|${snippet}`;
    const n = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, n);
    out.push(
      makeFinding({
        ruleId: `secret:${ruleId}`,
        category: 'security',
        severity: sev,
        title: `Possible secret committed (${ruleId.replace(/_/g, ' ')})`,
        description: lowConfidencePath
          ? 'Something that looks like a credential was added in a test, example or documentation file. If it is real, anyone with access to the code can use it.'
          : 'Something that looks like a real credential (password, key or token) was added to the code. Anyone with access to the repository or its history can use it.',
        technicalDetail: `Matched rule "${ruleId}" at ${t.path}:${line}. The value is redacted in this report.`,
        whatMightBreak: 'Unauthorized access to the system or account the credential belongs to.',
        recommendation:
          'Revoke/rotate the credential now (removing it from the code is not enough — it stays in git history) and load it from a secret manager or environment variable.',
        evidence: [{ repo, path: t.path, line, snippet, source: 'diff' }],
        identity: [repo, t.path, snippet, String(n)],
      }),
    );
  };
  // PEM blocks spanning lines. Local regex copies: the shared SECRET_RULES regexes are global
  // and redactSecrets() (used for snippets) resets their lastIndex.
  const pemLines = new Set<number>();
  for (const rule of SECRET_RULES.filter((r) => r.id === 'private_key')) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(joined))) {
      const before = joined.slice(0, m.index).split('\n').length - 1;
      pemLines.add(t.lines[before]?.line ?? 1);
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  for (const line of [...pemLines].sort((a, b) => a - b))
    emit('private_key', line, '-----BEGIN PRIVATE KEY----- [REDACTED]');
  const lineRules = SECRET_RULES.filter((r) => r.id !== 'private_key').map((r) => ({
    id: r.id,
    re: new RegExp(r.pattern.source, r.pattern.flags.replace('g', '')),
  }));
  for (const l of t.lines) {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY/.test(l.content)) continue;
    if (/\[REDACTED/.test(l.content)) continue; // already-redacted placeholders
    let matched = false;
    for (const rule of lineRules) {
      if (rule.re.test(l.content)) {
        emit(rule.id, l.line, l.content);
        matched = true;
        break;
      }
    }
    if (matched) continue;
    // Generic `password = "..."` style assignments (entropy-checked by core redaction).
    if (redactSecrets(l.content).redactions > 0)
      emit('generic_secret_assignment', l.line, l.content);
  }
  return out;
}

function ruleApplies(rule: LineRule, lang: string): boolean {
  if (rule.langs === 'any') return true;
  if (Array.isArray(rule.langs)) return rule.langs.includes(lang);
  return isSourceLanguage(lang) || CODE_LANGS_EXTRA.includes(lang);
}

function lineRuleFindings(repo: string, t: ScanTarget): Finding[] {
  const out: Finding[] = [];
  const occurrences = new Map<string, number>();
  for (const rule of LINE_RULES) {
    if (!ruleApplies(rule, t.lang)) continue;
    for (const l of t.lines) {
      if (l.content.length > 2000) continue; // minified / generated
      if (isCommentLine(l.content, t.lang)) continue;
      if (!rule.patterns.some((p) => p.test(l.content))) continue;
      let severity = rule.severity;
      if (rule.refine) {
        const r = rule.refine(l.content, t.path);
        if (r === null) continue;
        if (r) severity = r;
      }
      if (isTestPath(t.path) || isFixtureOrExamplePath(t.path)) severity = downgrade(severity);
      const snippet = snippetOf(l.content);
      const key = `${rule.id}|${snippet}`;
      const n = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, n);
      out.push(
        makeFinding({
          ruleId: rule.id,
          category: 'security',
          severity,
          title: `${rule.title} in ${t.path}`,
          description: rule.description,
          technicalDetail: `Rule "${rule.id}" matched at ${t.path}:${l.line}.`,
          recommendation: rule.recommendation,
          evidence: [{ repo, path: t.path, line: l.line, snippet, source: 'diff' }],
          identity: [repo, t.path, snippet, String(n)],
        }),
      );
    }
  }
  return out;
}

function workflowFindings(repo: string, t: ScanTarget): Finding[] {
  if (!isGithubActionsWorkflow(t.path)) return [];
  const out: Finding[] = [];
  const isAdded = (line: number) => t.addedLineSet === null || t.addedLineSet.has(line);
  const ctx = t.context;
  const prTarget = ctx.filter(
    (l) => /\bpull_request_target\b/.test(l.content) && !/^\s*#/.test(l.content),
  );
  const headCheckout = ctx.filter((l) =>
    /\bref\s*:\s*.*\$\{\{\s*(?:github\.event\.pull_request\.head\.(?:sha|ref)|github\.head_ref|github\.event\.pull_request\.merge_commit_sha)\s*\}\}|refs\/pull\/.*\/(?:head|merge)/.test(
      l.content,
    ),
  );
  if (
    prTarget.length > 0 &&
    headCheckout.length > 0 &&
    [...prTarget, ...headCheckout].some((l) => isAdded(l.line))
  ) {
    const l = headCheckout[0] as NumberedLine;
    out.push(
      makeFinding({
        ruleId: 'workflow_pull_request_target_checkout',
        category: 'security',
        severity: 'critical',
        title: `CI workflow runs untrusted pull-request code with privileges (${t.path})`,
        description:
          'This automation runs on "pull_request_target" (which has access to repository secrets and write permissions) and checks out the code from the pull request itself. Anyone opening a pull request from a fork could run their own code with those privileges.',
        technicalDetail: `pull_request_target trigger at line ${prTarget[0]?.line}; head checkout at line ${l.line}.`,
        whatMightBreak: 'Repository secrets, release artifacts and write access to the repository.',
        recommendation:
          'Use the "pull_request" trigger for building untrusted code, or never check out / execute the PR head in a pull_request_target job.',
        evidence: [
          {
            repo,
            path: t.path,
            line: prTarget[0]?.line ?? l.line,
            snippet: snippetOf(prTarget[0]?.content ?? ''),
            source: 'diff',
          },
          { repo, path: t.path, line: l.line, snippet: snippetOf(l.content), source: 'diff' },
        ],
        identity: [repo, t.path],
      }),
    );
  }
  for (const l of t.lines) {
    if (/^\s*#/.test(l.content)) continue;
    if (/\bpermissions\s*:\s*write-all\b/.test(l.content)) {
      out.push(
        makeFinding({
          ruleId: 'workflow_permissions_write_all',
          category: 'security',
          severity: 'high',
          title: `CI workflow granted full write access (${t.path})`,
          description:
            'The automation token is given write access to everything in the repository. If any step is compromised it can modify code, releases or settings.',
          technicalDetail: `permissions: write-all at line ${l.line}.`,
          recommendation:
            'Grant only the specific permissions each job needs (e.g. contents: read).',
          evidence: [
            { repo, path: t.path, line: l.line, snippet: snippetOf(l.content), source: 'diff' },
          ],
          identity: [repo, t.path, 'write-all'],
        }),
      );
    }
    if (
      /\$\{\{\s*github\.(?:event\.(?:issue|pull_request|comment|review|review_comment|head_commit|commits|discussion|pages)\b[\w.[\]*]*\.(?:title|body|message|name|label|email|ref|page_name)|head_ref)\s*\}\}/.test(
        l.content,
      )
    ) {
      // only inside run: scripts (shell interpolation), not `with:` inputs/ifs
      const isRun = /^\s*(?:-\s*)?run\s*:/.test(l.content) || isInsideRunBlock(ctx, l.line);
      if (!isRun) continue;
      out.push(
        makeFinding({
          ruleId: 'workflow_script_injection',
          category: 'security',
          severity: 'high',
          title: `CI script uses untrusted pull-request text (${t.path})`,
          description:
            'A CI shell script directly inserts text that outsiders control (such as a PR title, branch name or comment). A crafted value could run arbitrary commands in CI.',
          technicalDetail: `Untrusted expression in run step at line ${l.line}.`,
          recommendation:
            'Pass the value through an environment variable (env: TITLE: ${{ ... }}) and reference "$TITLE" in the script.',
          evidence: [
            { repo, path: t.path, line: l.line, snippet: snippetOf(l.content), source: 'diff' },
          ],
          identity: [repo, t.path, snippetOf(l.content)],
        }),
      );
    }
  }
  return out;
}

function isInsideRunBlock(ctx: NumberedLine[], line: number): boolean {
  const idx = ctx.findIndex((l) => l.line === line);
  if (idx === -1) return false;
  const indent = /^\s*/.exec(ctx[idx]?.content ?? '')?.[0].length ?? 0;
  for (let i = idx - 1; i >= 0 && i >= idx - 60; i--) {
    const c = ctx[i]?.content ?? '';
    if (!c.trim()) continue;
    const ci = /^\s*/.exec(c)?.[0].length ?? 0;
    if (ci < indent) return /^\s*(?:-\s*)?run\s*:\s*[|>]/.test(c);
  }
  return false;
}

// ---------------------------------------------------------------------------
// External scanners
// ---------------------------------------------------------------------------

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  error?: string;
  timedOut: boolean;
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number },
): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        killSignal: 'SIGKILL',
      },
      (err, stdout, stderr) => {
        const e = err as
          (NodeJS.ErrnoException & { killed?: boolean; code?: number | string | null }) | null;
        resolvePromise({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
          timedOut: !!e?.killed,
          ...(e ? { error: e.message } : {}),
        });
      },
    );
  });
}

/** Locates an executable on PATH (no shell). */
export async function findBinary(
  name: string,
  pathEnv: string | undefined = process.env.PATH,
): Promise<string | null> {
  if (!pathEnv) return null;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`);
      try {
        const s = await stat(candidate);
        if (!s.isFile()) continue;
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

function safeRelative(workdir: string, file: string): string | null {
  const root = resolve(workdir);
  const abs = isAbsolute(file) ? resolve(file) : resolve(root, file);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return relative(root, abs).split(sep).join('/');
}

function scannerSeverity(raw: string | undefined): Severity {
  switch ((raw ?? '').toUpperCase()) {
    case 'CRITICAL':
      return 'critical';
    case 'ERROR':
    case 'HIGH':
      return 'high';
    case 'WARNING':
    case 'MEDIUM':
      return 'medium';
    case 'INFO':
    case 'LOW':
      return 'low';
    default:
      return 'medium';
  }
}

interface GitleaksResult {
  RuleID?: string;
  Description?: string;
  File?: string;
  StartLine?: number;
  Match?: string;
}

export function parseGitleaksReport(
  json: string,
  ctx: { repo: string; workdir: string; allowed: Map<string, Set<number> | null> },
): Finding[] {
  let data: unknown;
  try {
    data = JSON.parse(json || '[]');
  } catch {
    throw new Error('gitleaks produced invalid JSON');
  }
  if (!Array.isArray(data)) return [];
  const out: Finding[] = [];
  for (const r of data as GitleaksResult[]) {
    const rel = r.File ? safeRelative(ctx.workdir, r.File) : null;
    if (!rel || !ctx.allowed.has(rel)) continue;
    const lines = ctx.allowed.get(rel);
    const line = Number(r.StartLine ?? 0);
    if (lines && !lines.has(line)) continue;
    const snippet = snippetOf(r.Match ?? '');
    const ruleId = `gitleaks:${r.RuleID ?? 'secret'}`;
    out.push(
      makeFinding({
        ruleId,
        category: 'security',
        severity: /private-key|aws|github|gcp|stripe/i.test(r.RuleID ?? '') ? 'critical' : 'high',
        title: `Possible secret committed (${r.Description ?? r.RuleID ?? 'gitleaks'})`,
        description:
          'The gitleaks secret scanner found something that looks like a real credential in the changed code. Anyone with access to the repository or its history can use it.',
        technicalDetail: `gitleaks rule ${r.RuleID ?? '?'} at ${rel}:${line}. The value is redacted.`,
        recommendation:
          'Revoke/rotate the credential and load it from a secret manager or environment variable.',
        evidence: [{ repo: ctx.repo, path: rel, line, snippet, source: 'scanner' }],
        identity: [ctx.repo, rel, ruleId, snippet],
        source: 'scanner',
      }),
    );
  }
  return out;
}

interface SemgrepResult {
  check_id?: string;
  path?: string;
  start?: { line?: number };
  end?: { line?: number };
  extra?: {
    message?: string;
    severity?: string;
    lines?: string;
    metadata?: Record<string, unknown>;
  };
}

export function parseSemgrepReport(
  json: string,
  ctx: { repo: string; workdir: string; allowed: Map<string, Set<number> | null> },
): Finding[] {
  let data: { results?: SemgrepResult[] };
  try {
    data = JSON.parse(json || '{}') as { results?: SemgrepResult[] };
  } catch {
    throw new Error('semgrep produced invalid JSON');
  }
  const out: Finding[] = [];
  for (const r of data.results ?? []) {
    const rel = r.path ? safeRelative(ctx.workdir, r.path) : null;
    if (!rel || !ctx.allowed.has(rel)) continue;
    const start = Number(r.start?.line ?? 0);
    const end = Number(r.end?.line ?? start);
    const lines = ctx.allowed.get(rel);
    if (lines) {
      let hit = false;
      for (let l = start; l <= end && !hit; l++) if (lines.has(l)) hit = true;
      if (!hit) continue;
    }
    const message = redactSecrets(r.extra?.message ?? r.check_id ?? 'semgrep finding').text;
    const ruleId = `semgrep:${r.check_id ?? 'rule'}`;
    const snippet = snippetOf((r.extra?.lines ?? '').split('\n')[0] ?? '');
    const shortId = (r.check_id ?? 'rule').split('.').pop() ?? 'rule';
    const ev: Evidence = { repo: ctx.repo, path: rel, line: start, source: 'scanner' };
    if (end > start) ev.endLine = end;
    if (snippet && snippet !== 'requires login') ev.snippet = snippet;
    out.push(
      makeFinding({
        ruleId,
        category: 'security',
        severity: scannerSeverity(r.extra?.severity),
        title: `${shortId.replace(/[-_]/g, ' ')} (${rel})`,
        description: `The semgrep code scanner reported a potential security issue: ${message}`,
        technicalDetail: `semgrep rule ${r.check_id ?? '?'} at ${rel}:${start}${end > start ? `-${end}` : ''}.`,
        recommendation:
          'Review the flagged code; see the semgrep rule documentation for the recommended fix.',
        evidence: [ev],
        identity: [ctx.repo, rel, ruleId, snippet || String(start)],
        source: 'scanner',
      }),
    );
  }
  return out;
}

/** gitleaks config that only extends the bundled default rules. */
export const GITLEAKS_DEFAULT_CONFIG = '[extend]\nuseDefault = true\n';

/**
 * Files that configure gitleaks/semgrep. They are never written into a scan tree built from PR
 * content, so a PR cannot allow-list its own findings.
 */
export const SCANNER_CONTROL_FILES: ReadonlySet<string> = new Set([
  '.gitleaks.toml',
  '.gitleaksignore',
  'gitleaks.toml',
  '.semgrepignore',
]);

/** True when `path` names a scanner configuration/ignore file (at any depth). */
export function isScannerControlFile(path: string): boolean {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? '';
  return SCANNER_CONTROL_FILES.has(base.toLowerCase());
}

async function runGitleaks(
  bin: string,
  workdir: string,
  timeoutMs: number,
): Promise<{ json: string } | { error: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'gmp-gitleaks-'));
  const report = join(dir, 'report.json');
  // The scanned tree is PR content and must not configure the scanner: without an explicit
  // config gitleaks would load <source>/.gitleaks.toml and the cwd's .gitleaksignore. Use the
  // built-in default rules and an ignore path with no ignore file, and run outside the tree.
  const config = join(dir, 'gitleaks.toml');
  const ignoreDir = join(dir, 'ignore');
  try {
    await writeFile(config, GITLEAKS_DEFAULT_CONFIG, 'utf8');
    await mkdir(ignoreDir);
    const res = await run(
      bin,
      [
        'detect',
        '--no-git',
        '--source',
        workdir,
        '--config',
        config,
        '--gitleaks-ignore-path',
        ignoreDir,
        '--report-format',
        'json',
        '--report-path',
        report,
        '--redact',
        '--exit-code',
        '0',
        '--no-banner',
        '--log-level',
        'error',
      ],
      { cwd: ignoreDir, timeoutMs },
    );
    if (res.timedOut) return { error: `timed out after ${timeoutMs}ms` };
    let json = '';
    try {
      json = await readFile(report, 'utf8');
    } catch {
      return {
        error: res.error
          ? `failed: ${redactSecrets(res.stderr || res.error).text.slice(0, 300)}`
          : 'no report produced',
      };
    }
    return { json };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runSemgrep(
  bin: string,
  workdir: string,
  files: string[],
  config: string,
  timeoutMs: number,
): Promise<{ json: string } | { error: string }> {
  const args = [
    'scan',
    '--config',
    config,
    '--json',
    '--quiet',
    '--metrics=off',
    '--disable-version-check',
    '--timeout',
    '30',
    '--',
    ...files,
  ];
  const res = await run(bin, args, { cwd: workdir, timeoutMs });
  if (res.timedOut) return { error: `timed out after ${timeoutMs}ms` };
  if (!res.stdout.trim())
    return {
      error: `failed: ${redactSecrets(res.stderr || res.error || 'no output').text.slice(0, 300)}`,
    };
  return { json: res.stdout };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Metadata for the built-in rules (for documentation / UI). */
export const BUILTIN_SECURITY_RULES: readonly SecurityRuleInfo[] = [
  ...LINE_RULES.map(({ id, title, severity, description, recommendation }) => ({
    id,
    title,
    severity,
    description,
    recommendation,
  })),
  {
    id: 'secret:*',
    title: 'Possible secret committed',
    severity: 'high',
    description: 'Known token formats, private keys and high-entropy password/secret assignments.',
    recommendation: 'Rotate and move to a secret store.',
  },
  {
    id: 'workflow_pull_request_target_checkout',
    title: 'pull_request_target with PR head checkout',
    severity: 'critical',
    description: 'Privileged workflow runs untrusted code.',
    recommendation: 'Use pull_request or do not check out the PR head.',
  },
  {
    id: 'workflow_permissions_write_all',
    title: 'Workflow permissions: write-all',
    severity: 'high',
    description: 'Over-privileged CI token.',
    recommendation: 'Grant least privilege.',
  },
  {
    id: 'workflow_script_injection',
    title: 'Untrusted input in CI script',
    severity: 'high',
    description: 'Shell injection via GitHub expressions.',
    recommendation: 'Pass via env vars.',
  },
];

/** Built-in rules only (synchronous, pure). */
export function runBuiltinSecurityRules(
  input: Pick<SecurityScanInput, 'files' | 'repo'>,
): Finding[] {
  const repo = input.repo ?? '';
  const out: Finding[] = [];
  for (const t of targetsFor(input.files)) {
    out.push(
      ...secretFindings(repo, t),
      ...lineRuleFindings(repo, t),
      ...workflowFindings(repo, t),
    );
  }
  return dedupeFindings(out);
}

/**
 * Full scan with metadata: built-in rules plus gitleaks / semgrep when available and a
 * `workdir` (checked-out head) is provided. External results are restricted to the given
 * files and, for files with a patch, to added lines.
 */
export async function runSecurityScanDetailed(
  input: SecurityScanInput,
): Promise<SecurityScanReport> {
  const repo = input.repo ?? '';
  const findings = runBuiltinSecurityRules(input);
  const report: SecurityScanReport = { findings, scannersRun: ['builtin'], scannersSkipped: [] };
  const opts = input.scanners ?? {};
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const workdir = input.workdir ?? null;
  const wantGitleaks = opts.gitleaks ?? true;
  const wantSemgrep = opts.semgrep ?? true;
  if (!workdir) {
    if (wantGitleaks)
      report.scannersSkipped.push({ name: 'gitleaks', reason: 'no working tree provided' });
    if (wantSemgrep)
      report.scannersSkipped.push({ name: 'semgrep', reason: 'no working tree provided' });
    return report;
  }
  try {
    const s = await stat(workdir);
    if (!s.isDirectory()) throw new Error('not a directory');
  } catch {
    report.scannersSkipped.push({ name: 'external', reason: 'working tree not found' });
    return report;
  }

  // Allowed files → added-line sets (null = whole file).
  const allowed = new Map<string, Set<number> | null>();
  for (const f of input.files) {
    const status = (f.status ?? '').toLowerCase();
    if (status === 'removed' || status === 'deleted') continue;
    const rel = safeRelative(workdir, f.path);
    if (!rel) continue;
    allowed.set(
      rel,
      f.patch
        ? new Set(parseUnifiedDiff(f.patch).flatMap((h) => h.added.map((l) => l.line)))
        : null,
    );
  }
  const existing: string[] = [];
  for (const rel of allowed.keys()) {
    try {
      if ((await stat(join(workdir, rel))).isFile()) existing.push(rel);
    } catch {
      // deleted / not checked out
    }
  }
  const extra: Finding[] = [];
  const ctx = { repo, workdir, allowed };

  if (wantGitleaks) {
    const bin = await findBinary('gitleaks', opts.pathEnv);
    if (!bin) report.scannersSkipped.push({ name: 'gitleaks', reason: 'binary not found on PATH' });
    else {
      const res = await runGitleaks(bin, workdir, timeoutMs);
      if ('error' in res) report.scannersSkipped.push({ name: 'gitleaks', reason: res.error });
      else {
        try {
          extra.push(...parseGitleaksReport(res.json, ctx));
          report.scannersRun.push('gitleaks');
        } catch (err) {
          report.scannersSkipped.push({ name: 'gitleaks', reason: (err as Error).message });
        }
      }
    }
  }
  if (wantSemgrep) {
    const bin = await findBinary('semgrep', opts.pathEnv);
    if (!bin) report.scannersSkipped.push({ name: 'semgrep', reason: 'binary not found on PATH' });
    else if (existing.length === 0)
      report.scannersSkipped.push({
        name: 'semgrep',
        reason: 'no changed files present in working tree',
      });
    else {
      const res = await runSemgrep(
        bin,
        workdir,
        existing.slice(0, 500),
        opts.semgrepConfig ?? 'p/default',
        timeoutMs,
      );
      if ('error' in res) report.scannersSkipped.push({ name: 'semgrep', reason: res.error });
      else {
        try {
          extra.push(...parseSemgrepReport(res.json, ctx));
          report.scannersRun.push('semgrep');
        } catch (err) {
          report.scannersSkipped.push({ name: 'semgrep', reason: (err as Error).message });
        }
      }
    }
  }
  // Drop scanner secrets already reported by built-in rules on the same line.
  const builtinSecretLines = new Set(
    findings
      .filter((f) => f.ruleId?.startsWith('secret:'))
      .map((f) => `${f.evidence[0]?.path}:${f.evidence[0]?.line}`),
  );
  const filtered = extra.filter(
    (f) =>
      !(
        f.ruleId?.startsWith('gitleaks:') &&
        builtinSecretLines.has(`${f.evidence[0]?.path}:${f.evidence[0]?.line}`)
      ),
  );
  report.findings = dedupeFindings([...findings, ...filtered]);
  return report;
}

/** Design §8 entry point: findings only. */
export async function runSecurityScan(input: SecurityScanInput): Promise<Finding[]> {
  return (await runSecurityScanDetailed(input)).findings;
}
