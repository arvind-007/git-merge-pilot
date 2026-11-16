import { FindingSchema } from '@gmp/core';
import { describe, expect, it } from 'vitest';
import * as analysis from './index.ts';
import { makePatch } from './test-helpers/make-patch.ts';

describe('@gmp/analysis public entry point', () => {
  it('loads tree-sitter grammars at import time', () => {
    const st = analysis.parserStatus();
    expect(st.initialized).toBe(true);
    expect(st.languages).toHaveLength(6);
  });

  it('exports the design §8 API', () => {
    for (const name of [
      'parseUnifiedDiff',
      'detectLanguage',
      'extractSymbols',
      'extractContracts',
      'analyzeChanges',
      'detectBreakingChanges',
      'runSecurityScan',
      'computeFootprint',
      'detectRelationships',
      'scoreRisk',
      'diffFindings',
      'fingerprint',
    ] as const) {
      expect(typeof analysis[name]).toBe('function');
    }
  });

  it('runs the full deterministic pipeline end to end', async () => {
    const before =
      "import express from 'express';\nconst app = express();\napp.get('/v1/orders', list);\napp.delete('/v1/orders/:id', remove);\n\nexport function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n";
    const after =
      "import express from 'express';\nconst app = express();\napp.get('/v1/orders', list);\n\nexport function total(items: number[], taxRate: number): number {\n  const q = db.query(`SELECT * FROM orders WHERE id = ${req.params.id}`);\n  return items.reduce((a, b) => a + b, 0) * (1 + taxRate);\n}\n";
    const files = [
      { path: 'src/server.ts', status: 'modified', patch: makePatch(before, after), before, after },
      {
        path: 'db/migrations/0007_orders.sql',
        status: 'added',
        patch: makePatch('', 'ALTER TABLE orders DROP COLUMN legacy_ref;\n'),
      },
    ];
    const facts = analysis.analyzeChanges({ repo: 'acme/orders', files });
    const breaking = analysis.detectBreakingChanges(facts);
    const security = await analysis.runSecurityScan({ repo: 'acme/orders', files });
    const findings = [...breaking, ...security];
    for (const f of findings) expect(() => FindingSchema.parse(f)).not.toThrow();
    expect(breaking.map((f) => f.ruleId).sort()).toEqual([
      'route_removed',
      'schema_drop_column',
      'signature_change',
    ]);
    expect(security.map((f) => f.ruleId)).toEqual(['sql_injection']);

    const footprint = analysis.computeFootprint(facts);
    const other = analysis.computeFootprint(
      analysis.analyzeChanges({
        repo: 'acme/web',
        files: [
          {
            path: 'src/api.ts',
            status: 'modified',
            patch: makePatch(
              'export const x = 1;\n',
              'export const x = 1;\nexport const del = (id: string) => axios.delete(`/v1/orders/${id}`);\n',
            ),
          },
        ],
      }),
    );
    const rels = analysis.detectRelationships(
      { id: 'pr-1', repo: 'acme/orders', number: 1, title: 'Orders v2', footprint },
      [{ id: 'pr-2', repo: 'acme/web', number: 2, title: 'Web delete', footprint: other }],
    );
    expect(rels).toEqual([
      expect.objectContaining({ type: 'contract_change', confidence: 'likely' }),
    ]);

    const risk = analysis.scoreRisk({
      facts,
      findings,
      relationships: rels,
      checks: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
      reviewDecision: 'APPROVED',
      mergeableState: 'clean',
    });
    expect(risk.overallRisk).toBe('high');
    expect(risk.mergeReadiness.recommendation).toBe('merge_after_checks');

    // Incremental: fixing the SQL injection resolves exactly that finding.
    const fixed = after.replace(
      'db.query(`SELECT * FROM orders WHERE id = ${req.params.id}`)',
      "db.query('SELECT * FROM orders WHERE id = $1', [req.params.id])",
    );
    const security2 = await analysis.runSecurityScan({
      repo: 'acme/orders',
      files: [{ path: 'src/server.ts', status: 'modified', patch: makePatch(before, fixed) }],
    });
    const diff = analysis.diffFindings(findings, [...breaking, ...security2]);
    expect(diff.resolved.map((f) => f.ruleId)).toEqual(['sql_injection']);
    expect(diff.new).toEqual([]);
    expect(diff.unchanged).toHaveLength(3);
  });
});
