import { describe, expect, it } from 'vitest';
import { containsSecret, redactSecrets, redactSecretsDeep, shannonEntropy } from './redaction.ts';

// Fake credentials are assembled at runtime so no token-shaped literal is committed.
const j = (...parts: string[]) => parts.join('');
const alnum = (n: number, seed = 7) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += chars[x % chars.length];
  }
  return out;
};
const upperNum = (n: number) =>
  alnum(n * 3, 3)
    .replace(/[a-z]/g, '')
    .slice(0, n)
    .padEnd(n, '7');

const fixtures: Array<[string, string, string]> = [
  ['github classic PAT', j('gh', 'p_', alnum(36)), 'github_token'],
  ['github oauth token', j('gh', 'o_', alnum(36, 11)), 'github_token'],
  ['github app installation token', j('gh', 's_', alnum(36, 13)), 'github_token'],
  ['github fine-grained PAT', j('github', '_pat_', alnum(22), '_', alnum(59, 5)), 'github_token'],
  ['aws access key id', j('AK', 'IA', upperNum(16)), 'aws_access_key_id'],
  ['slack bot token', j('xo', 'xb-', '1234567890-', '0987654321-', alnum(24)), 'slack_token'],
  ['slack user token', j('xo', 'xp-', '1234567890-', alnum(30)), 'slack_token'],
  ['stripe live key', j('sk', '_live_', alnum(24)), 'stripe_key'],
  ['anthropic key', j('sk', '-ant-api03-', alnum(80), '-', alnum(10), 'AA'), 'anthropic_key'],
  ['openai project key', j('sk', '-proj-', alnum(48), '_', alnum(20)), 'openai_key'],
  ['openai legacy key', j('sk', '-', alnum(48)), 'openai_key'],
  ['google api key', j('AI', 'za', 'Sy', alnum(33)), 'google_api_key'],
  ['gitlab token', j('gl', 'pat-', alnum(20)), 'gitlab_token'],
  ['npm token', j('np', 'm_', alnum(36)), 'npm_token'],
  [
    'jwt',
    j(
      'ey',
      'JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      '.',
      'ey',
      'JzdWIiOiIxMjM0NTY3ODkwIn0',
      '.',
      alnum(43),
    ),
    'jwt',
  ],
  [
    'slack webhook url',
    j('https://hooks.', 'slack.com/services/', 'T0000000/B0000000/', alnum(24)),
    'slack_webhook',
  ],
];

describe('redactSecrets — token formats', () => {
  for (const [label, token, id] of fixtures) {
    it(`redacts ${label}`, () => {
      const input = `config: ${token} trailing`;
      const { text, redactions } = redactSecrets(input);
      expect(text).not.toContain(token);
      expect(text).toContain(`[REDACTED:${id}]`);
      expect(text.startsWith('config: ')).toBe(true);
      expect(text.endsWith(' trailing')).toBe(true);
      expect(redactions).toBeGreaterThanOrEqual(1);
    });
  }

  it('redacts tokens inside diff lines and quotes', () => {
    const token = j('gh', 'p_', alnum(36, 99));
    const diff = `+const client = new Octokit({ auth: "${token}" });`;
    const { text } = redactSecrets(diff);
    expect(text).not.toContain(token);
    expect(text).toContain('new Octokit');
  });
});

describe('redactSecrets — private keys', () => {
  const body = Array.from({ length: 6 }, (_, i) => alnum(64, i + 1)).join('\n');

  it('redacts a full PEM private key block', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
    const { text, redactions } = redactSecrets(`key:\n${pem}\nafter`);
    expect(text).toBe('key:\n[REDACTED:private_key]\nafter');
    expect(redactions).toBe(1);
  });

  it('redacts PKCS8, EC and OpenSSH keys', () => {
    for (const kind of [
      'PRIVATE KEY',
      'EC PRIVATE KEY',
      'OPENSSH PRIVATE KEY',
      'ENCRYPTED PRIVATE KEY',
    ]) {
      const pem = `-----BEGIN ${kind}-----\n${body}\n-----END ${kind}-----`;
      const { text } = redactSecrets(pem);
      expect(text).toBe('[REDACTED:private_key]');
    }
  });

  it('redacts PEM blocks inside diffs (lines prefixed with +)', () => {
    const diffBody = body
      .split('\n')
      .map((l) => `+${l}`)
      .join('\n');
    const diff = `+-----BEGIN PRIVATE KEY-----\n${diffBody}\n+-----END PRIVATE KEY-----`;
    const { text } = redactSecrets(diff);
    expect(text).not.toMatch(/[A-Za-z0-9]{64}/);
  });

  it('redacts a truncated PEM block with no END marker', () => {
    const { text } = redactSecrets(`-----BEGIN RSA PRIVATE KEY-----\n${body}`);
    expect(text).not.toMatch(/[A-Za-z0-9]{64}/);
    expect(text).toContain('[REDACTED:private_key]');
  });

  it('does not redact public keys or certificates', () => {
    const pub = `-----BEGIN PUBLIC KEY-----\n${alnum(64)}\n-----END PUBLIC KEY-----`;
    expect(redactSecrets(pub).redactions).toBe(0);
  });
});

describe('redactSecrets — URLs and headers', () => {
  it('redacts passwords embedded in URLs but keeps host', () => {
    const { text } = redactSecrets(
      'DATABASE_URL=postgres://app:S3cr3tPassw0rd@db.internal:5432/app',
    );
    expect(text).toContain('postgres://app:[REDACTED:url_credentials]@db.internal:5432/app');
    expect(text).not.toContain('S3cr3tPassw0rd');
  });

  it('redacts Authorization header values', () => {
    const value = alnum(40, 21);
    const { text } = redactSecrets(`Authorization: Bearer ${value}`);
    expect(text).toBe('Authorization: Bearer [REDACTED:authorization_header]');
    const basic = redactSecrets(`authorization: "Basic ${alnum(24, 4)}=="`).text;
    expect(basic).toContain('[REDACTED:authorization_header]');
  });

  it('redacts bare bearer tokens', () => {
    const value = alnum(32, 8);
    const { text } = redactSecrets(`curl -H "x: bearer ${value}"`);
    expect(text).not.toContain(value);
  });
});

describe('redactSecrets — generic assignments', () => {
  const secretValue = j('Qx7', alnum(20, 42), '!9z');

  const shouldRedact = [
    `password = "${secretValue}"`,
    `DB_PASSWORD=${secretValue}`,
    `client_secret: '${secretValue}'`,
    `"apiKey": "${secretValue}"`,
    `const authToken = '${secretValue}';`,
    `secret_key := "${secretValue}"`,
    `'access_key' => '${secretValue}'`,
    `aws_secret_access_key = ${alnum(40, 77)}`,
    `export JWT_SECRET=${secretValue}`,
  ];
  for (const line of shouldRedact) {
    it(`redacts: ${line.replace(secretValue, '<secret>').slice(0, 50)}`, () => {
      const { text, redactions } = redactSecrets(line);
      expect(text).not.toContain(secretValue);
      expect(text).toContain('[REDACTED');
      expect(redactions).toBeGreaterThanOrEqual(1);
    });
  }

  it('keeps the variable name', () => {
    expect(redactSecrets(`password = "${secretValue}"`).text).toBe('password = "[REDACTED]"');
  });

  const shouldKeep = [
    'password = process.env.DB_PASSWORD',
    'const token = req.headers.authorization',
    'password: ${DB_PASSWORD}',
    'API_KEY=<your-api-key>',
    'SECRET=changeme',
    'password = ""',
    "token: 'xxxxxxxxxxxxxxxx'",
    'secret = getSecret()',
    'tokenCount = 1234567',
    'const maxTokens = 4096;',
    'passwordHash = hashPassword(input)',
    'token = config.github.token',
    'PASSWORD=password',
  ];
  for (const line of shouldKeep) {
    it(`keeps: ${line}`, () => {
      expect(redactSecrets(line)).toEqual({ text: line, redactions: 0 });
    });
  }
});

describe('redactSecrets — general behaviour', () => {
  it('leaves ordinary text and code untouched', () => {
    const code = [
      'export function computeRisk(score: number): string {',
      '  const key = `${owner}/${repo}`;',
      '  return score > 80 ? "critical" : "low"; // task-runner-orchestration-service',
      '}',
      'See https://github.com/acme/widgets/pull/42 for context.',
      'commit 3f2a9c1b8e7d6f5a4b3c2d1e0f9a8b7c6d5e4f3a',
    ].join('\n');
    expect(redactSecrets(code)).toEqual({ text: code, redactions: 0 });
  });

  it('is idempotent', () => {
    const input = `token = "${j('gh', 'p_', alnum(36))}" and postgres://u:longpassword@h/db`;
    const once = redactSecrets(input);
    const twice = redactSecrets(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.redactions).toBe(0);
  });

  it('counts multiple secrets', () => {
    const input = [
      j('gh', 'p_', alnum(36, 1)),
      j('AK', 'IA', upperNum(16)),
      j('sk', '_live_', alnum(24, 2)),
    ].join(' ');
    expect(redactSecrets(input).redactions).toBe(3);
  });

  it('handles empty input', () => {
    expect(redactSecrets('')).toEqual({ text: '', redactions: 0 });
  });

  it('containsSecret and redactSecretsDeep work on nested data', () => {
    const tok = j('gh', 's_', alnum(36, 3));
    expect(containsSecret(`x ${tok}`)).toBe(true);
    expect(containsSecret('nothing here')).toBe(false);
    const input = { a: [`t=${tok}`, 1, null], b: { c: tok }, d: new Date(0) };
    const { value, redactions } = redactSecretsDeep(input);
    expect(JSON.stringify(value)).not.toContain(tok);
    expect(redactions).toBe(2);
    expect(value.d).toBeInstanceOf(Date);
    expect(input.b.c).toBe(tok); // not mutated
  });

  it('computes Shannon entropy', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBe(2);
  });
});

describe('redactSecrets — performance and nesting', () => {
  it('stays linear on long identifier-like runs that repeat secret keywords', () => {
    const inputs = ['token'.repeat(4000), 'a'.repeat(20_000), `x_password_${'ab1_'.repeat(5000)}`];
    for (const input of inputs) {
      const started = performance.now();
      redactSecrets(input);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it('finds a secret assignment nested inside a non-secret assignment value', () => {
    const value = 'Zq8vN3kLp2Xr7TbW';
    const r = redactSecrets(`url: "token=${value}"`);
    expect(r.text).not.toContain(value);
    expect(r.redactions).toBe(1);
  });
});
