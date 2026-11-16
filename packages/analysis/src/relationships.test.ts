import { describe, expect, it } from 'vitest';
import { analyzeChanges } from './changes.ts';
import { computeFootprint } from './footprint.ts';
import { initParsers } from './parsers.ts';
import { detectRelationships, parseDependencyRefs, titleTokens } from './relationships.ts';
import { makePatch } from './test-helpers/make-patch.ts';
import type { ChangedFileInput, RelationshipPrInput } from './types.ts';

await initParsers();

const f = (path: string, before: string | null, after: string | null): ChangedFileInput => ({
  path,
  status: before === null ? 'added' : after === null ? 'removed' : 'modified',
  patch: makePatch(before ?? '', after ?? ''),
  before,
  after,
});

const pr = (
  id: string,
  repo: string,
  files: ChangedFileInput[],
  extra: Partial<RelationshipPrInput> = {},
): RelationshipPrInput => ({
  id,
  repo,
  title: extra.title ?? `PR ${id}`,
  footprint: computeFootprint(analyzeChanges({ repo, files })),
  ...extra,
});

const BASE = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
const edit = (n: number, text: string) =>
  BASE.split('\n')
    .map((l, i) => (i + 1 === n ? text : l))
    .join('\n');

describe('computeFootprint', () => {
  it('summarises files, ranges, symbols, contracts, tables, env vars and packages', () => {
    const facts = analyzeChanges({
      repo: 'acme/api',
      files: [
        f(
          'src/a.ts',
          'export function a() {}\nconst x = process.env.OLD;\n',
          "export function a(x: number) {}\nconst x = process.env.NEW;\napp.get('/v1/items', h);\n",
        ),
        f('db/migrations/9.sql', null, 'ALTER TABLE items DROP COLUMN legacy;\n'),
        f('docker-compose.yml', 'services: {}\n', 'services:\n  x: {}\n'),
      ],
    });
    const fp = computeFootprint(facts);
    expect(fp.repo).toBe('acme/api');
    expect(fp.files.map((x) => x.path)).toEqual([
      'db/migrations/9.sql',
      'docker-compose.yml',
      'src/a.ts',
    ]);
    expect(fp.files.find((x) => x.path === 'src/a.ts')?.ranges).toEqual([{ start: 1, end: 2 }]);
    expect(fp.files.find((x) => x.path === 'db/migrations/9.sql')?.ranges).toEqual([]);
    expect(fp.symbols.map((x) => `${x.name}:${x.change}:${x.exported}`)).toEqual([
      'a:modified:true',
      'x:modified:false',
    ]);
    expect(fp.contracts.map((c) => c.identifier).sort()).toEqual([
      'GET /v1/items',
      'NEW',
      'OLD',
      'items',
    ]);
    expect(fp.tables).toEqual(['items']);
    expect(fp.envVars).toEqual(['NEW', 'OLD']);
    expect(fp.configFiles).toEqual(['docker-compose.yml']);
    expect(JSON.parse(JSON.stringify(fp))).toEqual(fp);
  });
});

describe('detectRelationships', () => {
  it('same_file: confirmed when hunks overlap, likely otherwise; ids ordered', () => {
    const a = pr('b-uuid', 'acme/api', [f('src/x.ts', BASE, edit(10, 'changed A'))]);
    const overlapping = pr('a-uuid', 'acme/api', [f('src/x.ts', BASE, edit(10, 'changed B'))]);
    const distant = pr('c-uuid', 'acme/api', [f('src/x.ts', BASE, edit(35, 'changed C'))]);
    const otherRepo = pr('d-uuid', 'acme/web', [f('src/x.ts', BASE, edit(10, 'changed D'))]);
    const rels = detectRelationships(a, [overlapping, distant, otherRepo, a]);
    const sameFile = rels.filter((r) => r.type === 'same_file');
    expect(sameFile).toHaveLength(2);
    expect(sameFile.find((r) => r.prAId === 'a-uuid')).toMatchObject({
      prBId: 'b-uuid',
      sourcePrId: 'b-uuid',
      confidence: 'confirmed',
    });
    expect(sameFile.find((r) => r.prBId === 'c-uuid')).toMatchObject({
      prAId: 'b-uuid',
      confidence: 'likely',
    });
    expect(rels.some((r) => r.prAId === 'd-uuid' || r.prBId === 'd-uuid')).toBe(false);
  });

  it('same_symbol is confirmed', () => {
    const src =
      'export function price(a: number) {\n  return a;\n}\n\n\n\n\n\nexport function other() {}\n';
    const a = pr('1', 'r', [f('src/p.ts', src, src.replace('return a;', 'return a * 2;'))]);
    const b = pr('2', 'r', [
      f('src/p.ts', src, src.replace('price(a: number)', 'price(a: number, b = 1)')),
    ]);
    const rels = detectRelationships(a, [b]);
    expect(rels.find((r) => r.type === 'same_symbol')).toMatchObject({ confidence: 'confirmed' });
    expect(rels.find((r) => r.type === 'same_symbol')?.summary).toContain('price');
  });

  it('contract_change: provider in one repo vs consumer in another PR is likely, same repo confirmed', () => {
    const api = pr('1', 'acme/api', [
      f(
        'src/routes.ts',
        "const r = express.Router();\nr.get('/orders/:id', h);\n",
        'const r = express.Router();\n',
      ),
    ]);
    const web = pr('2', 'acme/web', [
      f(
        'src/client.ts',
        'export const x = 1;\n',
        'export const x = 1;\nexport const load = (id: string) => fetch(`/orders/${id}`);\n',
      ),
    ]);
    const sameRepoConsumer = pr('3', 'acme/api', [
      f(
        'src/job.ts',
        'export const y = 1;\n',
        "export const y = 1;\naxios.get('/orders/' + id);\n",
      ),
    ]);
    const rels = detectRelationships(api, [web, sameRepoConsumer]);
    const cc = rels.filter((r) => r.type === 'contract_change');
    expect(cc.find((r) => r.prBId === '2')).toMatchObject({ confidence: 'likely' });
    expect(cc.find((r) => r.prBId === '2')?.summary).toContain(
      'removes the API endpoint GET /orders/:param',
    );
    expect(cc.find((r) => r.prBId === '3')).toMatchObject({ confidence: 'confirmed' });
  });

  it('contract_change via default-branch contract index', () => {
    const api = pr('1', 'acme/api', [
      f(
        'src/routes.ts',
        "const r = express.Router();\nr.get('/invoices', h);\n",
        "const r = express.Router();\nr.post('/invoices', h);\n",
      ),
    ]);
    const web = pr('2', 'acme/web', [
      f('src/pages/billing.tsx', 'export const A = 1;\n', 'export const A = 2;\n'),
    ]);
    const rels = detectRelationships(
      api,
      [web],
      [
        {
          repo: 'acme/web',
          path: 'src/pages/billing.tsx',
          kind: 'http_route',
          identifier: 'GET /invoices',
          role: 'consumer',
          line: 12,
        },
        {
          repo: 'acme/web',
          path: 'src/other.ts',
          kind: 'http_route',
          identifier: 'GET /invoices',
          role: 'consumer',
        },
      ],
    );
    const cc = rels.find((r) => r.type === 'contract_change');
    expect(cc).toMatchObject({ confidence: 'likely' });
    expect(cc?.evidence.some((e) => e.source === 'index' && e.line === 12)).toBe(true);
  });

  it('shared_table and shared_config', () => {
    const a = pr('1', 'r', [
      f('db/migrations/1.sql', null, 'ALTER TABLE users ADD COLUMN a int;\n'),
      f('src/c.ts', 'export const q = 1;\n', 'export const q = process.env.FEATURE_X;\n'),
    ]);
    const b = pr('2', 'r', [
      f('db/migrations/2.sql', null, 'ALTER TABLE users ADD COLUMN b int;\n'),
      f('src/d.ts', 'export const z = 1;\n', 'export const z = process.env.FEATURE_X;\n'),
    ]);
    const c = pr('3', 'other/repo', [
      f('db/migrations/1.sql', null, 'CREATE TABLE users (id int);\n'),
    ]);
    const rels = detectRelationships(a, [b, c]);
    expect(rels.find((r) => r.type === 'shared_table' && r.prBId === '2')).toMatchObject({
      confidence: 'confirmed',
    });
    expect(rels.find((r) => r.type === 'shared_table' && r.prBId === '3')).toMatchObject({
      confidence: 'possible',
    });
    expect(rels.find((r) => r.type === 'shared_config')).toMatchObject({
      confidence: 'confirmed',
      prBId: '2',
    });
  });

  it('depends_on: explicit reference confirmed, shared linked issue likely', () => {
    const empty: ChangedFileInput[] = [];
    const a = pr('1', 'acme/web', empty, {
      number: 7,
      title: 'Checkout UI',
      body: 'Depends on acme/api#42 and #5',
    });
    const b = pr('2', 'acme/api', empty, { number: 42, title: 'Checkout endpoint' });
    const c = pr('3', 'acme/web', empty, { number: 5, title: 'Cart refactor' });
    const d = pr('4', 'acme/api', empty, {
      number: 50,
      title: 'Payments',
      linkedIssues: [{ number: 100, repo: 'acme/web' }],
    });
    const a2 = { ...a, linkedIssues: [{ number: 100 }] };
    const rels = detectRelationships(a2, [b, c, d]);
    expect(
      rels
        .filter((r) => r.type === 'depends_on')
        .map((r) => [r.prBId === '1' ? r.prAId : r.prBId, r.confidence]),
    ).toEqual([
      ['2', 'confirmed'],
      ['3', 'confirmed'],
      ['4', 'likely'],
    ]);
    expect(parseDependencyRefs('blocked by https://github.com/o/r/pull/9', 'x/y')).toEqual([
      { repo: 'o/r', number: 9 },
    ]);
    expect(parseDependencyRefs('See #12 for context. Fixes #13.', 'x/y')).toEqual([]);
  });

  it('duplicate_work is only ever possible and flagged for AI confirmation', () => {
    const a = pr('1', 'r', [], { title: 'feat: add CSV export for invoices' });
    const b = pr('2', 'r', [], { title: 'Invoices CSV export' });
    const c = pr('3', 'r', [], { title: 'Fix login redirect' });
    const rels = detectRelationships(a, [b, c]);
    expect(rels).toEqual([
      expect.objectContaining({
        type: 'duplicate_work',
        confidence: 'possible',
        needsAiConfirmation: true,
        prBId: '2',
      }),
    ]);
    expect([...titleTokens('feat(api): Adding Invoices export')]).toEqual(['invoice', 'export']);
  });

  it('no relationships for unrelated PRs', () => {
    const a = pr('1', 'r', [f('src/a.ts', BASE, edit(1, 'x'))], { title: 'Improve logging' });
    const b = pr('2', 'r', [f('src/b.ts', BASE, edit(1, 'y'))], { title: 'Upgrade build tooling' });
    expect(detectRelationships(a, [b])).toEqual([]);
  });
});
