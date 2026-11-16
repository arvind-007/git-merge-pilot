// @gmp/analysis — deterministic analysis (design §8): diff parsing, symbols, contracts,
// change facts, breaking changes, security scan, footprint, relationships, risk scoring.
//
// Pure / deterministic and no network access. tree-sitter grammars are loaded once at import
// (top-level await) so the synchronous extractors are tree-sitter backed; if loading fails,
// extraction falls back to regex heuristics (see `parserStatus()`).
import { initParsers } from './parsers.ts';

await initParsers();

export { initParsers, parserStatus, type ParserStatus } from './parsers.ts';
export {
  parseUnifiedDiff,
  addedLines,
  removedLines,
  touchedOldRanges,
  rangesOverlap,
  mergeRanges,
  hunkFragments,
  type HunkFragment,
} from './diff.ts';
export {
  detectLanguage,
  isTestPath,
  isGeneratedPath,
  isLockFile,
  isMigrationPath,
  isSchemaDefinitionPath,
  isWorkflowPath,
  isDependencyManifest,
  isDocumentationPath,
  isFixtureOrExamplePath,
  isSourceLanguage,
  classifyConfig,
  TREE_SITTER_LANGUAGES,
  type TreeSitterLanguage,
} from './language.ts';
export {
  extractSymbols,
  extractSymbolsWithRegex,
  normalizeSignature,
  signatureParams,
} from './symbols.ts';
export {
  extractContracts,
  normalizeRoutePath,
  routeIdentifier,
  parseRouteIdentifier,
  matchContractIdentifiers,
  normalizeTableName,
} from './contracts.ts';
export {
  extractSchemaOperations,
  extractTableColumns,
  diffTableColumns,
  type ColumnInfo,
  type TableColumns,
} from './schema-ops.ts';
export {
  parseDependencies,
  diffDependencies,
  isMajorChange,
  manifestEcosystem,
  type DependencyEntry,
  type DependencyMap,
} from './dependencies.ts';
export { analyzeChanges } from './changes.ts';
export { detectBreakingChanges } from './breaking.ts';
export {
  runSecurityScan,
  runSecurityScanDetailed,
  runBuiltinSecurityRules,
  findBinary,
  parseGitleaksReport,
  parseSemgrepReport,
  BUILTIN_SECURITY_RULES,
  GITLEAKS_DEFAULT_CONFIG,
  isScannerControlFile,
  type SecurityRuleInfo,
} from './security.ts';
export { computeFootprint } from './footprint.ts';
export { detectRelationships, parseDependencyRefs, titleTokens } from './relationships.ts';
export { scoreRisk, normalizeCheckStatus } from './risk.ts';
export {
  fingerprint,
  diffFindings,
  makeFinding,
  sortFindings,
  dedupeFindings,
  type FindingSpec,
} from './findings.ts';
export * from './types.ts';
