import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FindingSchema } from '@gmp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findBinary,
  GITLEAKS_DEFAULT_CONFIG,
  isScannerControlFile,
  parseGitleaksReport,
  parseSemgrepReport,
  runBuiltinSecurityRules,
  runSecurityScan,
  runSecurityScanDetailed,
} from './security.ts';
import { makePatch } from './test-helpers/make-patch.ts';

// Fake credentials are assembled at runtime so no secret-looking literal lives in the source.
const FAKE_GH = `gh${'p_'}${'aB3dE5fG7h'.repeat(4).slice(0, 36)}`;
const FAKE_AWS = `AK${'IA'}${'Z7Q2X4W6V8T0R2P4'}`;

const added = (path: string, content: string) => ({
  path,
  status: 'added',
  patch: makePatch('', content),
});
const ids = (fs: { ruleId?: string }[]) => fs.map((f) => f.ruleId).sort();

describe('builtin rules — positives', () => {
  it.each([
    [
      'src/db.ts',
      'const rows = await db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);',
      'sql_injection',
    ],
    [
      'src/db.ts',
      'db.query("SELECT * FROM users WHERE name = \'" + name + "\'");',
      'sql_injection',
    ],
    ['app/db.py', 'cur.execute(f"SELECT * FROM users WHERE id = {user_id}")', 'sql_injection'],
    ['app/db.py', 'cur.execute("DELETE FROM users WHERE id = %s" % uid)', 'sql_injection'],
    ['repo/q.go', 'q := fmt.Sprintf("SELECT * FROM t WHERE id = %s", id)', 'sql_injection'],
    ['src/run.ts', 'exec(`git checkout ${branch}`);', 'command_injection'],
    ['app/run.py', 'subprocess.run(f"ls {path}", shell=True)', 'command_injection'],
    ['app/run.py', 'os.system("rm -rf " + target)', 'command_injection'],
    ['src/Run.java', 'Runtime.getRuntime().exec("ping " + host);', 'command_injection'],
    ['src/e.js', 'const v = eval(userInput);', 'code_eval'],
    ['src/e.js', 'const fn = new Function("a", body);', 'code_eval'],
    ['app/e.py', 'exec(code_from_request)', 'code_eval'],
    ['src/ui.ts', 'el.innerHTML = comment.body;', 'unsafe_html'],
    ['src/ui.tsx', '<div dangerouslySetInnerHTML={{ __html: html }} />', 'unsafe_html'],
    ['src/ui.vue', '<p v-html="post.content"></p>', 'unsafe_html'],
    [
      'src/http.ts',
      'const agent = new https.Agent({ rejectUnauthorized: false });',
      'tls_verification_disabled',
    ],
    ['app/c.py', 'requests.get(url, verify=False)', 'tls_verification_disabled'],
    ['x/c.go', 'tls.Config{InsecureSkipVerify: true}', 'tls_verification_disabled'],
    ['scripts/fetch.sh', 'curl -k https://internal/api', 'tls_verification_disabled'],
    [
      'src/h.ts',
      "const h = crypto.createHash('md5').update(password).digest('hex');",
      'weak_crypto',
    ],
    ['app/h.py', 'digest = hashlib.sha1(token.encode()).hexdigest()', 'weak_crypto'],
    ['src/H.java', 'Cipher c = Cipher.getInstance("DES");', 'weak_crypto'],
    ['src/log.ts', 'logger.info(`login ok ${user.password}`);', 'logging_secrets'],
    ['app/log.py', 'logging.debug("token=%s", api_token)', 'logging_secrets'],
    ['src/server.ts', "res.setHeader('Access-Control-Allow-Origin', '*');", 'cors_wildcard'],
    ['src/server.ts', 'app.use(cors({ origin: true, credentials: true }));', 'cors_wildcard'],
    ['app/settings.py', 'CORS_ALLOW_ALL_ORIGINS = True', 'cors_wildcard'],
    ['app/p.py', 'data = pickle.loads(request.body)', 'unsafe_deserialization'],
    ['app/y.py', 'cfg = yaml.load(stream)', 'unsafe_deserialization'],
  ])('%s: %s → %s', (path, line, rule) => {
    const findings = runBuiltinSecurityRules({
      repo: 'acme/app',
      files: [added(path, `${line}\n`)],
    });
    expect(ids(findings)).toContain(rule);
    const f = findings.find((x) => x.ruleId === rule)!;
    expect(() => FindingSchema.parse(f)).not.toThrow();
    expect(f.evidence[0]).toMatchObject({ repo: 'acme/app', path, line: 1, source: 'diff' });
    expect(f.verified).toBe(true);
    expect(f.category).toBe('security');
  });

  it('CORS with credentials is high severity', () => {
    const f = runBuiltinSecurityRules({
      files: [added('src/s.ts', 'app.use(cors({ origin: true, credentials: true }));\n')],
    });
    expect(f.find((x) => x.ruleId === 'cors_wildcard')?.severity).toBe('high');
  });
});

describe('builtin rules — false-positive guards', () => {
  it.each([
    ['src/db.ts', 'await db.query("SELECT * FROM users WHERE id = $1", [id]);'],
    ['app/db.py', 'cur.execute("SELECT * FROM users WHERE id = %s", (uid,))'],
    ['src/m.py', 'model.eval()'],
    ['src/a.ts', 'const result = regex.exec(text);'],
    ['src/a.ts', "el.innerHTML = '';"],
    ['src/a.ts', 'el.innerHTML = DOMPurify.sanitize(html);'],
    ['app/h.py', 'etag = hashlib.md5(body, usedforsecurity=False).hexdigest()'],
    ['src/log.ts', "logger.info('token refreshed for user', { userId });"],
    ['src/log.ts', 'logger.debug(`used ${usage.inputTokens} tokens`);'],
    ['src/log.ts', 'console.log(tokenCount);'],
    ['src/a.ts', '// eval(userInput) is dangerous, never do this'],
    ['app/a.py', '# os.system("rm -rf " + target)'],
    ['src/cfg.ts', 'const password = process.env.DB_PASSWORD;'],
    ['src/cfg.ts', "const apiKey = '<your-api-key>';"],
    ['app/y.py', 'cfg = yaml.load(stream, Loader=yaml.SafeLoader)'],
    ['docs/setup.md', 'Run `curl -k https://localhost:8443/health` to check.'],
  ])('%s: %s → no finding', (path, line) => {
    expect(runBuiltinSecurityRules({ files: [added(path, `${line}\n`)] })).toEqual([]);
  });

  it('only scans ADDED lines of a diff', () => {
    const before = 'const v = eval(input);\nconst ok = 1;\n';
    const after = 'const ok = 1;\nconst ok2 = 2;\n';
    expect(
      runBuiltinSecurityRules({
        files: [{ path: 'src/a.js', status: 'modified', patch: makePatch(before, after) }],
      }),
    ).toEqual([]);
    const after2 = 'const v = eval(input);\nconst ok = 1;\nconst w = eval(other);\n';
    const f = runBuiltinSecurityRules({
      files: [{ path: 'src/a.js', status: 'modified', patch: makePatch(before, after2) }],
    });
    expect(f).toHaveLength(1);
    expect(f[0]?.evidence[0]?.line).toBe(3);
  });

  it('skips removed files and lock files', () => {
    expect(
      runBuiltinSecurityRules({
        files: [
          { path: 'a.js', status: 'removed', patch: '@@ -1 +0,0 @@\n-eval(x)' },
          added('package-lock.json', `"token": "${FAKE_GH}"\n`),
        ],
      }),
    ).toEqual([]);
  });

  it('downgrades findings in tests/fixtures', () => {
    const f = runBuiltinSecurityRules({
      files: [added('src/__tests__/x.test.ts', 'const v = eval(userInput);\n')],
    });
    expect(f[0]?.severity).toBe('low');
  });
});

describe('secrets', () => {
  it('detects known token formats with redacted evidence', () => {
    const f = runBuiltinSecurityRules({
      repo: 'r',
      files: [added('src/cfg.ts', `const gh = "${FAKE_GH}";\nconst aws = "${FAKE_AWS}";\n`)],
    });
    expect(ids(f)).toEqual(['secret:aws_access_key_id', 'secret:github_token']);
    for (const x of f) {
      expect(x.severity).toBe('critical');
      expect(JSON.stringify(x)).not.toContain(FAKE_GH);
      expect(JSON.stringify(x)).not.toContain(FAKE_AWS);
      expect(x.evidence[0]?.snippet).toContain('[REDACTED');
    }
  });

  it('detects private keys across lines and generic high-entropy assignments', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAx3',
      'QwErTyUiOp1234567890abcdefGHIJ',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const f = runBuiltinSecurityRules({
      files: [
        added('deploy/key.pem', `${pem}\n`),
        added('src/c.py', 'DB_PASSWORD = "s8F!kQ2#vL9zR4pX"\n'),
      ],
    });
    expect(ids(f)).toEqual(['secret:generic_secret_assignment', 'secret:private_key']);
    expect(f.find((x) => x.ruleId === 'secret:private_key')?.evidence[0]?.line).toBe(1);
  });

  it('local dev connection strings are low severity', () => {
    const f = runBuiltinSecurityRules({
      files: [
        added(
          'docker-compose.yml',
          '      DATABASE_URL: postgres://app:devpass123@localhost:5432/app\n',
        ),
      ],
    });
    expect(f.every((x) => x.severity === 'low' || x.severity === 'info')).toBe(true);
  });
});

describe('GitHub Actions workflows', () => {
  const wf = `name: ci
on:
  pull_request_target:
permissions: write-all
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - run: echo "\${{ github.event.pull_request.title }}"
      - name: safe
        if: \${{ github.event.pull_request.title != '' }}
        run: echo ok
`;
  it('flags pull_request_target + head checkout, write-all and script injection', () => {
    const f = runBuiltinSecurityRules({
      repo: 'r',
      files: [added('.github/workflows/ci.yml', wf)],
    });
    expect(ids(f)).toEqual([
      'workflow_permissions_write_all',
      'workflow_pull_request_target_checkout',
      'workflow_script_injection',
    ]);
    expect(f.find((x) => x.ruleId === 'workflow_pull_request_target_checkout')?.severity).toBe(
      'critical',
    );
  });

  it('does not flag pull_request_target without head checkout, or unchanged workflows', () => {
    const safe =
      'on:\n  pull_request_target:\njobs:\n  label:\n    steps:\n      - uses: actions/labeler@v5\n';
    expect(
      runBuiltinSecurityRules({ files: [added('.github/workflows/label.yml', safe)] }),
    ).toEqual([]);
    // existing risky config, PR only edits an unrelated line
    const after = wf.replace('name: ci', 'name: ci2');
    const f = runBuiltinSecurityRules({
      files: [
        {
          path: '.github/workflows/ci.yml',
          status: 'modified',
          patch: makePatch(wf, after),
          content: after,
        },
      ],
    });
    expect(f).toEqual([]);
  });
});

describe('external scanners', () => {
  let dir: string;
  let bin: string;
  let work: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gmp-sec-test-'));
    bin = join(dir, 'bin');
    work = join(dir, 'work');
    await mkdir(bin);
    await mkdir(join(work, 'src'), { recursive: true });
    await writeFile(join(work, 'src', 'a.ts'), 'line1\nconst k = "x";\nline3\n');
    await writeFile(join(work, 'src', 'b.ts'), 'other\n');
    // Fake gitleaks: writes a report to the --report-path argument.
    const gitleaks = `#!/bin/sh
printf '%s\\n' "$PWD" "$@" > "${dir}/gitleaks-args.txt"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--report-path" ]; then shift; out="$1"; fi
  if [ "$1" = "--config" ]; then shift; cat "$1" > "${dir}/gitleaks-config.txt"; fi
  shift
done
cat > "$out" <<'JSON'
[{"RuleID":"generic-api-key","Description":"Generic API Key","File":"${work}/src/a.ts","StartLine":2,"Match":"k = \\"REDACTED\\""},
 {"RuleID":"generic-api-key","Description":"Generic API Key","File":"${work}/src/a.ts","StartLine":3,"Match":"x"},
 {"RuleID":"generic-api-key","Description":"Generic API Key","File":"${work}/src/untouched.ts","StartLine":1,"Match":"y"},
 {"RuleID":"generic-api-key","Description":"Generic API Key","File":"/etc/passwd","StartLine":1,"Match":"z"}]
JSON
`;
    const semgrep = `#!/bin/sh
cat <<'JSON'
{"results":[{"check_id":"javascript.lang.security.audit.detect-eval","path":"src/a.ts","start":{"line":2},"end":{"line":2},"extra":{"message":"Detected eval","severity":"ERROR","lines":"const k = \\"x\\";"}},
{"check_id":"x.y.z","path":"src/b.ts","start":{"line":1},"end":{"line":1},"extra":{"message":"m","severity":"INFO","lines":"other"}}],"errors":[]}
JSON
`;
    await writeFile(join(bin, 'gitleaks'), gitleaks);
    await writeFile(join(bin, 'semgrep'), semgrep);
    await chmod(join(bin, 'gitleaks'), 0o755);
    await chmod(join(bin, 'semgrep'), 0o755);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('findBinary searches only the given PATH', async () => {
    expect(await findBinary('gitleaks', bin)).toBe(join(bin, 'gitleaks'));
    expect(await findBinary('gitleaks', join(dir, 'nope'))).toBeNull();
  });

  it('runs fake gitleaks + semgrep, restricted to changed files and added lines', async () => {
    const files = [
      {
        path: 'src/a.ts',
        status: 'modified',
        patch: '@@ -1,2 +1,3 @@\n line1\n+const k = "x";\n line3',
      },
      { path: 'src/b.ts', status: 'added', content: 'other\n' },
    ];
    const report = await runSecurityScanDetailed({
      repo: 'r',
      files,
      workdir: work,
      scanners: { pathEnv: bin, timeoutMs: 10_000 },
    });
    expect(report.scannersRun).toEqual(['builtin', 'gitleaks', 'semgrep']);
    expect(report.scannersSkipped).toEqual([]);
    const ext = report.findings.filter((f) => f.source === 'scanner');
    expect(
      ext
        .map((f) => `${f.ruleId}@${f.evidence[0]?.path}:${f.evidence[0]?.line}:${f.severity}`)
        .sort(),
    ).toEqual([
      'gitleaks:generic-api-key@src/a.ts:2:high',
      'semgrep:javascript.lang.security.audit.detect-eval@src/a.ts:2:high',
      'semgrep:x.y.z@src/b.ts:1:low',
    ]);
    for (const f of ext) expect(() => FindingSchema.parse(f)).not.toThrow();

    // The PR tree cannot configure gitleaks: explicit default config, ignore path and cwd
    // outside the scanned tree.
    const [cwd, ...args] = (await readFile(join(dir, 'gitleaks-args.txt'), 'utf8'))
      .trim()
      .split('\n');
    expect(args).toContain('--config');
    expect(args).toContain('--gitleaks-ignore-path');
    const ignorePath = args[args.indexOf('--gitleaks-ignore-path') + 1]!;
    expect(ignorePath.startsWith(work)).toBe(false);
    expect(cwd!.startsWith(work)).toBe(false);
    expect(await readFile(join(dir, 'gitleaks-config.txt'), 'utf8')).toBe(GITLEAKS_DEFAULT_CONFIG);
  });

  it('recognizes scanner control files at any depth', () => {
    expect(isScannerControlFile('.gitleaks.toml')).toBe(true);
    expect(isScannerControlFile('sub/dir/.gitleaksignore')).toBe(true);
    expect(isScannerControlFile('.semgrepignore')).toBe(true);
    expect(isScannerControlFile('src/gitleaks.ts')).toBe(false);
  });

  it('skips gracefully when binaries are missing or there is no workdir', async () => {
    const r1 = await runSecurityScanDetailed({
      files: [],
      workdir: work,
      scanners: { pathEnv: join(dir, 'empty') },
    });
    expect(r1.scannersSkipped.map((s) => `${s.name}: ${s.reason}`)).toEqual([
      'gitleaks: binary not found on PATH',
      'semgrep: binary not found on PATH',
    ]);
    const r2 = await runSecurityScanDetailed({ files: [] });
    expect(r2.scannersSkipped.map((s) => s.name)).toEqual(['gitleaks', 'semgrep']);
    expect(await runSecurityScan({ files: [] })).toEqual([]);
  });

  it('times out slow scanners and reports the reason', async () => {
    const slow = join(dir, 'slow');
    await mkdir(slow, { recursive: true });
    await writeFile(join(slow, 'semgrep'), '#!/bin/sh\nsleep 5\n');
    await chmod(join(slow, 'semgrep'), 0o755);
    const r = await runSecurityScanDetailed({
      files: [{ path: 'src/b.ts', content: 'other\n' }],
      workdir: work,
      scanners: { pathEnv: slow, gitleaks: false, timeoutMs: 300 },
    });
    expect(r.scannersSkipped).toEqual([{ name: 'semgrep', reason: 'timed out after 300ms' }]);
  });

  it('report parsers reject malformed JSON and ignore paths outside the workdir', () => {
    const ctx = {
      repo: 'r',
      workdir: work,
      allowed: new Map<string, Set<number> | null>([['src/a.ts', null]]),
    };
    expect(() => parseGitleaksReport('{not json', ctx)).toThrow(/invalid JSON/);
    expect(() => parseSemgrepReport('nope', ctx)).toThrow(/invalid JSON/);
    expect(parseGitleaksReport('[{"File":"../../etc/passwd","StartLine":1}]', ctx)).toEqual([]);
    expect(
      parseSemgrepReport('{"results":[{"path":"/etc/passwd","start":{"line":1}}]}', ctx),
    ).toEqual([]);
  });
});
