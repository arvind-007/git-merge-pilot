import { describe, expect, it } from 'vitest';
import { analyzeChanges } from './changes.ts';
import { diffDependencies, isMajorChange, parseDependencies } from './dependencies.ts';
import { initParsers } from './parsers.ts';
import { extractSchemaOperations } from './schema-ops.ts';
import { makePatch } from './test-helpers/make-patch.ts';
import type { ChangedFileInput } from './types.ts';

await initParsers();

const file = (
  path: string,
  before: string | null,
  after: string | null,
  opts: { withContent?: boolean; status?: string } = {},
): ChangedFileInput => {
  const status =
    opts.status ?? (before === null ? 'added' : after === null ? 'removed' : 'modified');
  const f: ChangedFileInput = { path, status, patch: makePatch(before ?? '', after ?? '') };
  if (opts.withContent !== false) {
    f.before = before;
    f.after = after;
  }
  return f;
};

describe('analyzeChanges — files, tests, config, packages', () => {
  const facts = analyzeChanges({
    repo: 'acme/shop',
    profile: { packages: [{ name: '@acme/api', path: 'services/api' }] },
    files: [
      file(
        'services/api/src/orders.ts',
        'export function a() {}\n',
        'export function a() { return 1; }\n',
      ),
      file('services/api/src/orders.test.ts', null, 'test("x", () => {});\n'),
      file('web/src/old.spec.tsx', 'it()\n', null),
      file('Dockerfile', 'FROM node:20\n', 'FROM node:22\n'),
      file(
        '.github/workflows/ci.yml',
        'on: push\n',
        'on:\n  pull_request_target:\npermissions: write-all\n',
      ),
      file('README.md', 'a\n', 'b\n'),
      { path: 'assets/logo.png', status: 'modified' },
      file('pnpm-lock.yaml', 'a\n', 'b\n'),
    ],
  });

  it('classifies files', () => {
    expect(facts.testsAdded).toEqual(['services/api/src/orders.test.ts']);
    expect(facts.testsRemoved).toEqual(['web/src/old.spec.tsx']);
    expect(facts.sourceFilesChanged).toEqual(['services/api/src/orders.ts']);
    expect(facts.configChanges.map((c) => [c.path, c.kind, c.infrastructure])).toEqual([
      ['Dockerfile', 'docker', true],
    ]);
    expect(facts.workflowChanges[0]).toMatchObject({
      path: '.github/workflows/ci.yml',
      notes: ['permissions changed', 'pull_request_target trigger'],
    });
    expect(
      facts.permissionChanges.some(
        (p) => p.kind === 'workflow_permissions' && p.change === 'added',
      ),
    ).toBe(true);
    expect(facts.packagesTouched).toEqual(['(root)', '.github', '@acme/api', 'assets', 'web']);
    expect(facts.stats.files).toBe(8);
    expect(facts.limitations.some((l) => l.includes('assets/logo.png'))).toBe(true);
  });

  it('records body-only modifications of symbols', () => {
    expect(facts.touchedSymbols).toEqual([
      expect.objectContaining({
        path: 'services/api/src/orders.ts',
        qualifiedName: 'a',
        change: 'modified',
        signatureChanged: false,
        exported: true,
        basis: 'content',
      }),
    ]);
  });

  it('is deterministic regardless of input order', () => {
    const files = [
      file('b.ts', 'export const x = 1;\n', 'export const y = 1;\n'),
      file('a.ts', null, 'export function z() {}\n'),
    ];
    const one = analyzeChanges({ repo: 'r', files });
    const two = analyzeChanges({ repo: 'r', files: [...files].reverse() });
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });
});

describe('analyzeChanges — symbols', () => {
  const before = `export function charge(amount: number): Receipt {\n  return pay(amount);\n}\n\nexport function refund(id: string) {}\n\nexport class Cart {\n  add(item: Item): void {}\n}\n`;
  const after = `export function charge(amount: number, currency: string): Receipt {\n  return pay(amount);\n}\n\nexport function reverse(id: string) {}\n\nexport class Cart {\n  add(item: Item): void {}\n  clear(): void {}\n}\n`;

  for (const withContent of [true, false]) {
    it(`detects signature change, rename and additions (${withContent ? 'content' : 'patch'} mode)`, () => {
      const facts = analyzeChanges({
        repo: 'r',
        files: [file('src/cart.ts', before, after, { withContent })],
      });
      const by = (q: string) => facts.touchedSymbols.find((s) => s.qualifiedName === q);
      expect(by('charge')).toMatchObject({
        change: 'modified',
        signatureChanged: true,
        oldSignature: 'export function charge(amount: number): Receipt'.replace(
          'export ',
          withContent ? '' : 'export ',
        ),
        exported: true,
      });
      expect(by('reverse')).toMatchObject({ change: 'renamed', oldName: 'refund' });
      expect(by('Cart.clear')).toMatchObject({ change: 'added', kind: 'method' });
      expect(by('Cart.add')).toBeUndefined();
    });
  }

  it('patch-only mode uses hunk headers for body changes outside the visible declaration', () => {
    const patch = `@@ -40,7 +40,7 @@ export function computeTotal(items: Item[]): number {\n   let sum = 0;\n   for (const i of items) {\n-    sum += i.price;\n+    sum += i.price * i.qty;\n   }\n   return sum;\n }`;
    const facts = analyzeChanges({
      repo: 'r',
      files: [{ path: 'src/total.ts', status: 'modified', patch }],
    });
    expect(facts.touchedSymbols).toEqual([
      expect.objectContaining({
        qualifiedName: 'computeTotal',
        change: 'modified',
        signatureChanged: false,
        exported: true,
        basis: 'patch',
      }),
    ]);
    expect(facts.limitations.some((l) => l.includes('diff hunks only'))).toBe(true);
  });

  it('python and go symbol changes', () => {
    const py = analyzeChanges({
      repo: 'r',
      files: [
        file('app/svc.py', 'def load(path):\n    pass\n', 'def load(path, strict):\n    pass\n'),
      ],
    });
    expect(py.touchedSymbols[0]).toMatchObject({
      qualifiedName: 'load',
      change: 'modified',
      signatureChanged: true,
    });
    const go = analyzeChanges({
      repo: 'r',
      files: [
        file('pkg/x.go', 'package x\n\nfunc Open(p string) error { return nil }\n', 'package x\n'),
      ],
    });
    expect(go.touchedSymbols[0]).toMatchObject({
      qualifiedName: 'Open',
      change: 'removed',
      exported: true,
    });
  });

  it('ignores symbols in test files', () => {
    const facts = analyzeChanges({
      repo: 'r',
      files: [file('src/a.test.ts', 'export function helper() {}\n', '')],
    });
    expect(facts.touchedSymbols).toEqual([]);
  });
});

describe('analyzeChanges — contracts, env vars', () => {
  it('detects route changes and env var adds/removes', () => {
    const before = `const app = express();\napp.get('/users', list);\napp.delete('/users/:id', del);\nconst url = process.env.OLD_DB_URL;\n`;
    const after = `const app = express();\napp.get('/users', list);\napp.post('/users/:id/archive', archive);\nconst url = process.env.DATABASE_URL;\n`;
    const facts = analyzeChanges({ repo: 'r', files: [file('src/server.ts', before, after)] });
    const ids = facts.contractsChanged.map((c) => `${c.change} ${c.kind} ${c.identifier}`).sort();
    expect(ids).toEqual(
      [
        'added env_var DATABASE_URL',
        'added http_route POST /users/:param/archive',
        'removed env_var OLD_DB_URL',
        'removed http_route DELETE /users/:param',
      ].sort(),
    );
    expect(facts.envVarsAdded.map((e) => e.name)).toEqual(['DATABASE_URL']);
    expect(facts.envVarsRemoved.map((e) => e.name)).toEqual(['OLD_DB_URL']);
  });

  it('env vars moved between files are not reported', () => {
    const facts = analyzeChanges({
      repo: 'r',
      files: [
        file('src/a.ts', 'const a = process.env.TOKEN_TTL;\n', 'const a = 1;\n'),
        file('src/b.ts', 'const b = 1;\n', 'const b = process.env.TOKEN_TTL;\n'),
      ],
    });
    expect(facts.envVarsAdded).toEqual([]);
    expect(facts.envVarsRemoved).toEqual([]);
  });

  it('proto field changes in patch-only mode use the hunk header for context', () => {
    const patch =
      '@@ -5,4 +5,4 @@ message Invoice {\n   string id = 1;\n-  int64 amount = 2;\n+  int64 amount = 3;\n   string currency = 4;\n }';
    const facts = analyzeChanges({
      repo: 'r',
      files: [{ path: 'proto/billing.proto', status: 'modified', patch }],
    });
    expect(facts.contractsChanged).toEqual([
      expect.objectContaining({
        kind: 'proto',
        identifier: 'Invoice.amount',
        change: 'modified',
        oldSignature: 'int64 = 2',
        newSignature: 'int64 = 3',
      }),
    ]);
  });
});

describe('analyzeChanges — migrations & ORM schemas', () => {
  it('extracts operations from added migration lines', () => {
    const sql = `ALTER TABLE users DROP COLUMN legacy_id;\nALTER TABLE users ADD COLUMN tenant_id uuid NOT NULL;\nALTER TABLE orders RENAME COLUMN total TO total_cents, ALTER COLUMN status SET NOT NULL;\nCREATE INDEX idx_orders_user ON orders (user_id);\n`;
    const facts = analyzeChanges({
      repo: 'r',
      files: [file('db/migrations/0042_tenant.sql', null, sql)],
    });
    expect(facts.migrations).toHaveLength(1);
    expect(
      facts.schemaOperations.map(
        (o) =>
          `${o.op} ${o.table}${o.column ? `.${o.column}` : ''}${o.newName ? ` ${o.newName}` : ''}`,
      ),
    ).toEqual([
      'drop_column users.legacy_id',
      'add_column users.tenant_id',
      'rename_column orders.total total_cents',
      'set_not_null orders.status',
      'create_index orders.idx_orders_user',
    ]);
    expect(facts.schemaOperations[1]).toMatchObject({ notNull: true, hasDefault: false, line: 2 });
  });

  it('diffs prisma models', () => {
    const before = `model User {\n  id    Int    @id\n  email String\n  name  String?\n  posts Post[]\n}\n`;
    const after = `model User {\n  id    Int    @id\n  name  String\n  role  String\n  plan  String @default("free")\n  posts Post[]\n}\n`;
    const facts = analyzeChanges({
      repo: 'r',
      files: [file('prisma/schema.prisma', before, after)],
    });
    expect(facts.schemaOperations.map((o) => `${o.op} ${o.table}.${o.column}`).sort()).toEqual(
      [
        'add_column user.plan',
        'add_column user.role',
        'drop_column user.email',
        'set_not_null user.name',
      ].sort(),
    );
    expect(facts.schemaOperations.find((o) => o.column === 'role')).toMatchObject({
      notNull: true,
      hasDefault: false,
    });
    expect(facts.schemaOperations.find((o) => o.column === 'plan')).toMatchObject({
      notNull: true,
      hasDefault: true,
    });
  });

  it('diffs drizzle tables and detects table renames', () => {
    const before = `export const users = pgTable('users', {\n  id: uuid('id').primaryKey(),\n  email: text('email').notNull(),\n});\n`;
    const after = `export const users = pgTable('accounts', {\n  id: uuid('id').primaryKey(),\n  email: text('email').notNull(),\n});\n`;
    const facts = analyzeChanges({ repo: 'r', files: [file('src/db/schema.ts', before, after)] });
    expect(facts.schemaOperations).toEqual([
      expect.objectContaining({ op: 'rename_table', table: 'users', newName: 'accounts' }),
    ]);
  });

  it.each([
    [
      'db/migrate/20240101_x.rb',
      `class X < ActiveRecord::Migration[7.1]\n  def change\n    remove_column :users, :age\n    add_column :users, :plan, :string, null: false\n    rename_table :posts, :articles\n  end\nend\n`,
      ['drop_column users.age', 'add_column users.plan', 'rename_table posts'],
    ],
    [
      'app/migrations/0003_x.py',
      `class Migration(migrations.Migration):\n    operations = [\n        migrations.RemoveField(\n            model_name='order',\n            name='notes',\n        ),\n        migrations.AddField(model_name='order', name='ref', field=models.CharField(max_length=10)),\n        migrations.DeleteModel(name='Coupon'),\n    ]\n`,
      ['drop_column order.notes', 'add_column order.ref', 'drop_table coupon'],
    ],
    [
      'alembic/versions/abc_x.py',
      `def upgrade():\n    op.drop_column('users', 'nickname')\n    op.alter_column('users', 'email', nullable=False)\n    op.add_column('users', sa.Column('org_id', sa.Integer(), nullable=False))\n`,
      ['drop_column users.nickname', 'set_not_null users.email', 'add_column users.org_id'],
    ],
    [
      'migrations/20240101_x.js',
      `exports.up = (knex) => knex.schema.alterTable('users', (table) => {\n  table.dropColumn('age');\n  table.string('plan').notNullable();\n});\n`,
      ['drop_column users.age', 'add_column users.plan'],
    ],
    [
      'src/migrations/1700000000-X.ts',
      `await queryRunner.query(\`ALTER TABLE "invoice" DROP COLUMN "memo"\`);\nawait queryInterface.removeColumn('users', 'age');\n`,
      ['drop_column invoice.memo', 'drop_column users.age'],
    ],
  ])('framework migrations: %s', (path, text, expected) => {
    const ops = extractSchemaOperations(path, text);
    expect(ops.map((o) => `${o.op} ${o.table}${o.column ? `.${o.column}` : ''}`)).toEqual(expected);
  });

  it('does not treat comments or non-migration SQL keywords as operations', () => {
    expect(
      extractSchemaOperations('db/migrations/1.sql', '-- DROP TABLE users;\nSELECT 1;\n'),
    ).toEqual([]);
  });
});

describe('analyzeChanges — dependencies', () => {
  it('diffs package.json including dev deps and majors', () => {
    const before = `{\n  "name": "x",\n  "version": "1.0.0",\n  "dependencies": {\n    "express": "^4.19.0",\n    "lodash": "^4.17.21"\n  },\n  "devDependencies": {\n    "vitest": "^1.0.0"\n  }\n}\n`;
    const after = `{\n  "name": "x",\n  "version": "1.1.0",\n  "dependencies": {\n    "express": "^5.0.0",\n    "zod": "^3.0.0"\n  },\n  "devDependencies": {\n    "vitest": "^1.6.0"\n  }\n}\n`;
    for (const withContent of [true, false]) {
      const facts = analyzeChanges({
        repo: 'r',
        files: [file('package.json', before, after, { withContent })],
      });
      const d = (n: string) => facts.dependencyChanges.find((x) => x.name === n);
      expect(d('express'), `withContent=${withContent}`).toMatchObject({
        change: 'upgraded',
        major: true,
        dev: false,
        from: '^4.19.0',
        to: '^5.0.0',
      });
      expect(d('lodash')).toMatchObject({ change: 'removed' });
      expect(d('zod')).toMatchObject({ change: 'added' });
      expect(d('vitest')).toMatchObject({ change: 'upgraded', major: false });
      expect(d('version')).toBeUndefined();
      expect(d('name')).toBeUndefined();
    }
  });

  it('parses other ecosystems', () => {
    expect(
      [
        ...parseDependencies(
          'requirements.txt',
          'Django==4.2.1\nrequests>=2.31 # http\n-r base.txt\n',
        ).entries(),
      ].map(([k, v]) => `${k}${v.version}`),
    ).toEqual(['django==4.2.1', 'requests>=2.31']);
    expect(
      parseDependencies(
        'go.mod',
        'module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\n',
      ).get('github.com/gin-gonic/gin')?.version,
    ).toBe('v1.9.1');
    expect(
      parseDependencies(
        'build.gradle',
        'dependencies {\n  implementation \'org.springframework:spring-core:6.1.0\'\n  testImplementation "junit:junit:4.13"\n}\n',
      ).get('junit:junit'),
    ).toMatchObject({ version: '4.13', dev: true });
    expect(
      parseDependencies(
        'Gemfile',
        "gem 'rails', '~> 7.1'\ngroup :test do\n  gem 'rspec'\nend\n",
      ).get('rspec')?.dev,
    ).toBe(true);
    expect(
      parseDependencies(
        'Cargo.toml',
        '[package]\nname = "x"\n\n[dependencies]\nserde = { version = "1.0", features = ["derive"] }\n',
      ).get('serde')?.version,
    ).toBe('1.0');
    expect(
      parseDependencies(
        'pom.xml',
        '<dependency>\n<groupId>g</groupId>\n<artifactId>a</artifactId>\n<version>2.0</version>\n</dependency>\n',
      ).get('g:a')?.version,
    ).toBe('2.0');
    const changes = diffDependencies(
      'pyproject.toml',
      parseDependencies('pyproject.toml', '[project]\ndependencies = [\n  "fastapi>=0.110",\n]\n'),
      parseDependencies('pyproject.toml', '[project]\ndependencies = [\n  "fastapi>=0.111",\n]\n'),
    );
    expect(changes).toEqual([
      expect.objectContaining({ name: 'fastapi', change: 'upgraded', major: true }),
    ]);
  });

  it('isMajorChange', () => {
    expect(isMajorChange('^1.2.3', '^2.0.0')).toBe(true);
    expect(isMajorChange('0.3.0', '0.4.0')).toBe(true);
    expect(isMajorChange('1.2.0', '1.9.0')).toBe(false);
    expect(isMajorChange('latest', '2.0.0')).toBe(false);
  });
});

describe('analyzeChanges — permissions', () => {
  it('detects removed auth middleware and ignores moves', () => {
    const before = `router.get('/admin', requireAuth, adminHandler);\nrouter.get('/me', requireAuth, me);\n`;
    const after = `router.get('/admin', adminHandler);\nrouter.get('/me', requireAuth, me);\n`;
    const facts = analyzeChanges({ repo: 'r', files: [file('src/routes.ts', before, after)] });
    expect(facts.permissionChanges).toEqual([
      expect.objectContaining({ kind: 'auth_middleware', change: 'removed', line: 1 }),
    ]);
    const moved = analyzeChanges({
      repo: 'r',
      files: [
        file(
          'src/r.ts',
          'a();\nrouter.use(requireAuth);\nb();\n',
          'router.use(requireAuth);\na();\nb();\n',
        ),
      ],
    });
    expect(moved.permissionChanges).toEqual([]);
  });

  it('flags access-control bypasses and CODEOWNERS edits', () => {
    const facts = analyzeChanges({
      repo: 'r',
      files: [
        file(
          'app/views.py',
          'class V(APIView):\n    pass\n',
          'class V(APIView):\n    permission_classes = [AllowAny]\n',
        ),
        file('.github/CODEOWNERS', '* @team-a\n', '* @team-b\n'),
      ],
    });
    expect(facts.permissionChanges.map((p) => `${p.kind}:${p.change}`).sort()).toEqual([
      'access_control:added',
      'codeowners:added',
      'codeowners:removed',
    ]);
  });
});
