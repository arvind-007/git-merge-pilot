import { touchedOldRanges } from './diff.ts';
import type {
  ChangeFacts,
  Footprint,
  FootprintContract,
  FootprintFile,
  FootprintSymbol,
} from './types.ts';

const uniqSorted = (values: Iterable<string>) => [...new Set([...values].filter(Boolean))].sort();

/**
 * Compact, JSON-serializable summary of what a PR touches (stored in `analyses.footprint`)
 * used for cross-PR relationship detection.
 */
export function computeFootprint(facts: ChangeFacts): Footprint {
  const files: FootprintFile[] = facts.files
    .map((f) => {
      const ff: FootprintFile = {
        path: f.path,
        status: f.status,
        ranges: f.status === 'added' ? [] : touchedOldRanges(f.hunks),
      };
      if (f.previousPath) ff.previousPath = f.previousPath;
      return ff;
    })
    .sort((a, b) => (a.path < b.path ? -1 : 1));

  const symKey = new Set<string>();
  const symbols: FootprintSymbol[] = [];
  for (const s of facts.touchedSymbols) {
    const k = `${s.path}|${s.qualifiedName}|${s.kind}`;
    if (symKey.has(k)) continue;
    symKey.add(k);
    symbols.push({
      path: s.path,
      name: s.qualifiedName,
      kind: s.kind,
      change: s.change,
      exported: s.exported,
    });
  }
  symbols.sort((a, b) => (a.path + a.name < b.path + b.name ? -1 : 1));

  const cKey = new Set<string>();
  const contracts: FootprintContract[] = [];
  for (const c of facts.contractsChanged) {
    const k = `${c.kind}|${c.identifier}|${c.role}|${c.path}`;
    if (cKey.has(k)) continue;
    cKey.add(k);
    contracts.push({
      kind: c.kind,
      identifier: c.identifier,
      role: c.role,
      path: c.path,
      change: c.change,
    });
  }
  contracts.sort((a, b) =>
    `${a.kind}${a.identifier}${a.role}${a.path}` < `${b.kind}${b.identifier}${b.role}${b.path}`
      ? -1
      : 1,
  );

  const tables = uniqSorted([
    ...facts.schemaOperations.flatMap((o) => [
      o.table,
      ...(o.op === 'rename_table' && o.newName ? [o.newName] : []),
    ]),
    ...facts.contractsChanged
      .filter((c) => c.kind === 'db_table' && c.role === 'provider')
      .map((c) => c.identifier),
  ]);
  const envVars = uniqSorted([...facts.envVarsAdded, ...facts.envVarsRemoved].map((e) => e.name));
  const configFiles = uniqSorted([
    ...facts.configChanges.map((c) => c.path),
    ...facts.workflowChanges.map((w) => w.path),
  ]);

  return {
    repo: facts.repo,
    files,
    symbols,
    contracts,
    tables,
    envVars,
    packages: uniqSorted(facts.packagesTouched),
    configFiles,
  };
}
