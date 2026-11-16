import { FindingSchema } from '@gmp/core';
import { describe, expect, it } from 'vitest';
import { __internal, detectBreakingChanges } from './breaking.ts';
import { analyzeChanges } from './changes.ts';
import { initParsers } from './parsers.ts';
import { makePatch } from './test-helpers/make-patch.ts';
import type { ChangedFileInput } from './types.ts';

await initParsers();

const file = (
  path: string,
  before: string | null,
  after: string | null,
  withContent = true,
): ChangedFileInput => {
  const f: ChangedFileInput = {
    path,
    status: before === null ? 'added' : after === null ? 'removed' : 'modified',
    patch: makePatch(before ?? '', after ?? ''),
  };
  if (withContent) {
    f.before = before;
    f.after = after;
  }
  return f;
};

const run = (...files: ChangedFileInput[]) =>
  detectBreakingChanges(analyzeChanges({ repo: 'acme/api', files }));
const rules = (list: ReturnType<typeof run>) => list.map((f) => f.ruleId).sort();

describe('every breaking finding is well-formed', () => {
  it('validates against FindingSchema with evidence, verified=true and plain-language text', () => {
    const findings = run(
      file(
        'src/a.ts',
        'export function gone() {}\nexport function keep(a: number) {}\n',
        'export function keep(a: number, b: string) {}\n',
      ),
      file('db/migrations/2.sql', null, 'DROP TABLE sessions;\n'),
    );
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(() => FindingSchema.parse(f)).not.toThrow();
      expect(f.verified).toBe(true);
      expect(f.source).toBe('rule');
      expect(f.evidence.length).toBeGreaterThan(0);
      expect(f.evidence[0]?.repo).toBe('acme/api');
      expect(f.evidence[0]?.path).toBeTruthy();
      expect(f.description.length).toBeGreaterThan(40);
      expect(f.whatMightBreak).toBeTruthy();
      expect(f.recommendation).toBeTruthy();
      expect(f.technicalDetail).toBeTruthy();
    }
  });
});

describe('symbols', () => {
  it('removed export (TS) with evidence line in the old file', () => {
    const f = run(
      file(
        'src/lib.ts',
        'export function a() {}\n\nexport function legacy(x: string) {\n  return x;\n}\n',
        'export function a() {}\n',
      ),
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      ruleId: 'removed_export',
      severity: 'high',
      category: 'breaking_change',
    });
    // The line is in the old file: the evidence says so, so links point at the base commit.
    expect(f[0]?.evidence[0]).toMatchObject({ path: 'src/lib.ts', line: 3, side: 'base' });
    expect(f[0]?.description).toContain('legacy');
  });

  it('removed class folds its methods', () => {
    const f = run(file('src/svc.ts', 'export class Svc {\n  a() {}\n  b() {}\n}\n', '\n'));
    expect(rules(f)).toEqual(['removed_export']);
    expect(f[0]?.affected).toEqual(['Svc.a', 'Svc.b']);
  });

  it('renamed export', () => {
    const f = run(
      file(
        'pkg/util.go',
        'package util\n\nfunc ParseID(s string) (int, error) { return 0, nil }\n',
        'package util\n\nfunc ParseIdentifier(s string) (int, error) { return 0, nil }\n',
      ),
    );
    expect(f).toEqual([
      expect.objectContaining({
        ruleId: 'renamed_export',
        title: expect.stringContaining('ParseID → ParseIdentifier'),
      }),
    ]);
  });

  it('moved export is medium, not removed', () => {
    const f = run(
      file('src/a.ts', 'export function shared(x: number) {}\n', ''),
      file('src/b.ts', null, 'export function shared(x: number) {}\n'),
    );
    expect(f).toEqual([expect.objectContaining({ ruleId: 'moved_export', severity: 'medium' })]);
  });

  it.each([
    [
      'typescript',
      'src/x.ts',
      'export function f(a: number) {}\n',
      'export function f(a: number, b: string) {}\n',
      'high',
      'requires 1 more input',
    ],
    [
      'python',
      'app/x.py',
      'def f(a):\n    pass\n',
      'def f(a, b):\n    pass\n',
      'high',
      'requires 1 more input',
    ],
    [
      'java',
      'src/X.java',
      'public class X {\n  public void f(int a) {}\n}\n',
      'public class X {\n  public void f(int a, int b) {}\n}\n',
      'high',
      'requires',
    ],
    [
      'go removed param',
      'x/x.go',
      'package x\n\nfunc F(a int, b int) {}\n',
      'package x\n\nfunc F(a int) {}\n',
      'high',
      'no longer accepts b',
    ],
    [
      'ts return type',
      'src/r.ts',
      'export function f(): string { return ""; }\n',
      'export function f(): number { return 1; }\n',
      'medium',
      'result type changed',
    ],
    [
      'ts optional → required',
      'src/o.ts',
      'export function f(a?: number) {}\n',
      'export function f(a: number) {}\n',
      'high',
      'is now required',
    ],
  ])('signature change: %s', (_name, path, before, after, severity, text) => {
    const f = run(file(path, before, after));
    expect(f).toEqual([expect.objectContaining({ ruleId: 'signature_change', severity })]);
    expect(f[0]?.description).toContain(text);
  });

  it('false positives: optional params, private/non-exported code, body-only edits, tests', () => {
    expect(
      run(
        file(
          'src/x.ts',
          'export function f(a: number) {}\n',
          'export function f(a: number, b = 2, c?: string) {}\n',
        ),
      ),
    ).toEqual([]);
    expect(
      run(
        file('app/x.py', 'def f(a):\n    pass\n', 'def f(a, b=None, *args, **kwargs):\n    pass\n'),
      ),
    ).toEqual([]);
    expect(
      run(
        file('src/x.ts', 'function internal() {}\nexport const a = 1;\n', 'export const a = 1;\n'),
      ),
    ).toEqual([]);
    expect(run(file('app/x.py', 'def _private():\n    pass\n', ''))).toEqual([]);
    expect(run(file('x/x.go', 'package x\n\nfunc helper() {}\n', 'package x\n'))).toEqual([]);
    expect(
      run(
        file('src/X.java', 'public class X {\n  private void f() {}\n}\n', 'public class X {\n}\n'),
      ),
    ).toEqual([]);
    expect(
      run(
        file(
          'src/x.ts',
          'export function f(a: number) {\n  return a;\n}\n',
          'export function f(a: number) {\n  return a * 2;\n}\n',
        ),
      ),
    ).toEqual([]);
    expect(run(file('src/x.test.ts', 'export function fixture() {}\n', ''))).toEqual([]);
  });

  it('interface shape change', () => {
    const f = run(
      file(
        'src/types.ts',
        'export interface User {\n  id: string;\n  email: string;\n}\n',
        'export interface User {\n  id: string;\n}\n',
      ),
    );
    expect(f).toEqual([
      expect.objectContaining({ ruleId: 'type_shape_change', severity: 'medium' }),
    ]);
  });
});

describe('HTTP routes', () => {
  it('route removed', () => {
    const f = run(
      file(
        'src/routes.ts',
        "const r = express.Router();\nr.get('/users', a);\nr.delete('/users/:id', b);\n",
        "const r = express.Router();\nr.get('/users', a);\n",
      ),
    );
    expect(f).toEqual([
      expect.objectContaining({
        ruleId: 'route_removed',
        title: 'API endpoint removed: DELETE /users/:param',
      }),
    ]);
    expect(f[0]?.evidence[0]).toMatchObject({ line: 3, side: 'base' });
  });

  it('route method changed (FastAPI)', () => {
    const f = run(
      file(
        'app/api.py',
        "@app.get('/orders/{id}')\ndef get(id):\n    pass\n",
        "@app.post('/orders/{id}')\ndef get(id):\n    pass\n",
      ),
    );
    expect(rules(f)).toEqual(['route_method_changed']);
  });

  it('route param renamed is not breaking', () => {
    expect(
      run(file('src/routes.ts', "app.get('/users/:id', h);\n", "app.get('/users/:userId', h);\n")),
    ).toEqual([]);
  });

  it('Spring route removed in patch-only mode', () => {
    const before =
      '@RestController\n@RequestMapping("/api")\npublic class C {\n    @GetMapping("/a")\n    public String a() { return ""; }\n    @DeleteMapping("/b")\n    public void b() {}\n}\n';
    const after =
      '@RestController\n@RequestMapping("/api")\npublic class C {\n    @GetMapping("/a")\n    public String a() { return ""; }\n}\n';
    const f = run(file('src/main/java/C.java', before, after));
    expect(f.map((x) => x.title)).toContain('API endpoint removed: DELETE /api/b');
  });
});

describe('GraphQL & proto', () => {
  it('graphql field removed, type removed, required arg added, enum value removed', () => {
    const before =
      'type Query {\n  users(first: Int): [User!]!\n  legacy: String\n}\n\ntype User {\n  id: ID!\n  email: String!\n}\n\ntype Old {\n  x: Int\n}\n\nenum Role {\n  ADMIN\n  GUEST\n}\n';
    const after =
      'type Query {\n  users(first: Int, org: ID!): [User!]!\n}\n\ntype User {\n  id: ID!\n  email: String!\n}\n\nenum Role {\n  ADMIN\n}\n';
    const f = run(file('schema.graphql', before, after));
    const titles = f.map((x) => `${x.ruleId}: ${x.title}`);
    expect(titles).toEqual(
      expect.arrayContaining([
        'graphql_field_removed: GraphQL field removed: Query.legacy',
        'graphql_type_removed: GraphQL type removed: Old',
        'graphql_field_changed: GraphQL field changed: Query.users',
        'graphql_field_removed: GraphQL field removed: Role.GUEST',
      ]),
    );
    expect(f.find((x) => x.ruleId === 'graphql_field_changed')?.description).toContain(
      'now requires argument(s) org',
    );
  });

  it('graphql: adding an optional argument or a new field is not breaking', () => {
    expect(
      run(
        file(
          's.graphql',
          'type Query {\n  a(x: Int): Int\n}\n',
          'type Query {\n  a(x: Int, y: Int): Int\n  b: String\n}\n',
        ),
      ),
    ).toEqual([]);
  });

  it('proto field removed, renumbered and type changed; rpc removed', () => {
    const before =
      'syntax = "proto3";\npackage p;\nservice S {\n  rpc Get (Req) returns (Res);\n  rpc Old (Req) returns (Res);\n}\nmessage Res {\n  string id = 1;\n  int32 count = 2;\n  string note = 3;\n  string tag = 4;\n}\n';
    const after =
      'syntax = "proto3";\npackage p;\nservice S {\n  rpc Get (Req) returns (Res);\n}\nmessage Res {\n  string id = 1;\n  int64 count = 2;\n  string tag = 5;\n}\n';
    const f = run(file('api/p.proto', before, after));
    const byRule = Object.fromEntries(f.map((x) => [x.ruleId, x]));
    expect(byRule.proto_rpc_removed?.title).toContain('p.S.Old');
    expect(byRule.proto_field_removed?.title).toContain('p.Res.note');
    expect(byRule.proto_field_number_changed).toMatchObject({ severity: 'critical' });
    expect(byRule.proto_field_number_changed?.title).toContain('p.Res.tag');
    expect(byRule.proto_field_type_changed?.title).toContain('p.Res.count');
  });

  it('proto: adding fields is not breaking', () => {
    expect(
      run(
        file(
          'a.proto',
          'message M {\n  string a = 1;\n}\n',
          'message M {\n  string a = 1;\n  string b = 2;\n}\n',
        ),
      ),
    ).toEqual([]);
  });
});

describe('database schema', () => {
  it.each([
    ['DROP TABLE audit_events;', 'schema_drop_table', 'critical'],
    ['ALTER TABLE users DROP COLUMN phone;', 'schema_drop_column', 'high'],
    ['ALTER TABLE users RENAME COLUMN name TO full_name;', 'schema_rename_column', 'high'],
    ['ALTER TABLE users RENAME TO accounts;', 'schema_rename_table', 'high'],
    ['ALTER TABLE users ADD COLUMN org_id uuid NOT NULL;', 'schema_add_required_column', 'high'],
    ['ALTER TABLE users ALTER COLUMN email SET NOT NULL;', 'schema_set_not_null', 'high'],
    ['ALTER TABLE users ALTER COLUMN age TYPE bigint;', 'schema_alter_column_type', 'medium'],
    ['TRUNCATE TABLE carts;', 'schema_truncate_table', 'critical'],
  ])('%s', (sql, ruleId, severity) => {
    const f = run(file('db/migrations/0100_change.sql', null, `${sql}\n`));
    expect(f).toEqual([expect.objectContaining({ ruleId, severity })]);
    expect(f[0]?.evidence[0]).toMatchObject({
      path: 'db/migrations/0100_change.sql',
      line: 1,
      snippet: sql.replace(/;$/, ''),
    });
  });

  it('safe migrations produce no breaking findings', () => {
    const sql =
      "CREATE TABLE notes (id uuid PRIMARY KEY);\nALTER TABLE users ADD COLUMN nickname text;\nALTER TABLE users ADD COLUMN plan text NOT NULL DEFAULT 'free';\nCREATE INDEX CONCURRENTLY idx ON users (plan);\n";
    expect(run(file('db/migrations/0101_safe.sql', null, sql))).toEqual([]);
  });

  it('editing an existing migration is flagged', () => {
    const f = run(
      file(
        'db/migrations/0001_init.sql',
        'CREATE TABLE a (id int);\n',
        'CREATE TABLE a (id bigint);\n',
      ),
    );
    expect(rules(f)).toEqual(['migration_edited']);
  });

  it('prisma field removal', () => {
    const f = run(
      file(
        'prisma/schema.prisma',
        'model Post {\n  id Int @id\n  body String\n}\n',
        'model Post {\n  id Int @id\n}\n',
      ),
    );
    expect(f).toEqual([
      expect.objectContaining({
        ruleId: 'schema_drop_column',
        title: 'Database column deleted: post.body',
      }),
    ]);
  });

  it('entity file deletion without a migration', () => {
    const f = run(
      file(
        'src/entities/invoice.entity.ts',
        "@Entity('invoices')\nexport class Invoice {}\n",
        null,
      ),
    );
    expect(rules(f)).toEqual(['removed_export', 'table_definition_removed']);
  });
});

describe('env vars, topics, auth, dependencies', () => {
  it('env var renamed (high) and removed from deployment config (medium)', () => {
    const f = run(
      file(
        'src/config.ts',
        'export const db = process.env.DB_URL;\n',
        'export const db = process.env.DATABASE_URL;\n',
      ),
      file('.env.example', 'DB_URL=postgres://localhost/x\nPORT=3000\n', 'PORT=3000\n'),
    );
    const byRule = Object.fromEntries(f.map((x) => [x.ruleId, x]));
    expect(byRule.env_var_renamed).toMatchObject({
      severity: 'high',
      title: 'Configuration setting renamed: DB_URL → DATABASE_URL',
    });
    expect(byRule.env_var_removed).toMatchObject({ severity: 'medium' });
  });

  it('adding a new env var is not a breaking change', () => {
    expect(
      run(
        file(
          'src/c.ts',
          'export const a = 1;\n',
          'export const a = 1;\nexport const b = process.env.NEW_FLAG;\n',
        ),
      ),
    ).toEqual([]);
  });

  it('topic producer removed and renamed', () => {
    const f = run(
      file(
        'src/pub.ts',
        "await producer.send({ topic: 'orders.created', messages });\n",
        "await producer.send({ topic: 'orders.v2.created', messages });\n",
      ),
    );
    expect(f).toEqual([expect.objectContaining({ ruleId: 'topic_renamed', severity: 'high' })]);
  });

  it('auth check removed (security category) and bypass added', () => {
    const f = run(
      file(
        'src/routes.ts',
        "router.get('/admin', requireAuth, admin);\n",
        "router.get('/admin', admin);\n",
      ),
      file(
        'app/views.py',
        'class V(APIView):\n    pass\n',
        'class V(APIView):\n    permission_classes = [AllowAny]\n',
      ),
    );
    expect(f.map((x) => [x.ruleId, x.category]).sort()).toEqual([
      ['auth_bypass_added', 'security'],
      ['auth_check_removed', 'security'],
    ]);
  });

  it('major dependency upgrades and removals', () => {
    const before =
      '{\n  "dependencies": {\n    "react": "^17.0.2",\n    "moment": "^2.29.0"\n  },\n  "devDependencies": {\n    "eslint": "^8.0.0"\n  }\n}\n';
    const after =
      '{\n  "dependencies": {\n    "react": "^18.3.1"\n  },\n  "devDependencies": {\n    "eslint": "^9.0.0"\n  }\n}\n';
    const f = run(file('package.json', before, after));
    expect(f.map((x) => `${x.ruleId}:${x.severity}`).sort()).toEqual([
      'dependency_major_upgrade:low',
      'dependency_major_upgrade:medium',
      'dependency_removed:low',
    ]);
  });
});

describe('determinism & fingerprints', () => {
  it('fingerprints are stable when code moves to other lines', () => {
    const a = run(file('src/x.ts', 'export function gone() {}\n', '\n'));
    const b = run(file('src/x.ts', '// header\n\n\nexport function gone() {}\n', '// header\n'));
    expect(a[0]?.fingerprint).toBe(b[0]?.fingerprint);
  });

  it('compareSignatures handles Go/Java style params', () => {
    expect(
      __internal.compareSignatures('func F(a int, b string)', 'func F(a int, b int)', 'go')
        ?.reasons,
    ).toEqual(['parameter "b" type changed from string to int']);
    expect(__internal.parseParam('final String name')).toMatchObject({
      name: 'name',
      type: 'String',
      optional: false,
    });
    expect(__internal.parseParam('...rest: string[]')).toMatchObject({ optional: true });
  });
});
