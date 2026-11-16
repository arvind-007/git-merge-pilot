/**
 * Cross-PR relationship detection. Confidence rules (design §8):
 * - same_file: `confirmed` when edited line ranges overlap (or both add/one deletes the
 *   file), otherwise `likely`.
 * - same_symbol: `confirmed` (same repo, same file, same symbol).
 * - contract_change: same provider changed in both (same repo) or literal consumer match in
 *   the same repo → `confirmed`; literal match across repos or via the default-branch
 *   contract index → `likely`; mount-prefix (suffix) route matches → `possible`.
 * - shared_table / shared_config: same repo → `confirmed`, cross-repo → `possible`.
 * - depends_on: explicit "depends on #n" / PR URL → `confirmed`; same linked issue → `likely`.
 * - duplicate_work: similar titles → `possible` with `needsAiConfirmation` (never more).
 */
import type { ContractKind, Evidence, RelationshipConfidence, RelationshipType } from '@gmp/core';
import { matchContractIdentifiers } from './contracts.ts';
import { rangesOverlap } from './diff.ts';
import type {
  ContractIndex,
  FootprintContract,
  IndexedContract,
  Relationship,
  RelationshipPrInput,
} from './types.ts';

const RANK: Record<RelationshipConfidence, number> = { confirmed: 3, likely: 2, possible: 1 };
const API_KINDS = new Set<ContractKind>(['http_route', 'graphql', 'proto', 'queue_topic', 'event']);
const MAX_EVIDENCE = 10;

class Builder {
  private readonly map = new Map<string, Relationship>();
  constructor(private readonly source: RelationshipPrInput) {}
  add(
    other: RelationshipPrInput,
    type: RelationshipType,
    confidence: RelationshipConfidence,
    summary: string,
    evidence: Evidence[],
    needsAiConfirmation = false,
  ): void {
    const [a, b] =
      this.source.id < other.id ? [this.source.id, other.id] : [other.id, this.source.id];
    const key = `${a}|${b}|${type}`;
    const prev = this.map.get(key);
    if (!prev) {
      this.map.set(key, {
        prAId: a,
        prBId: b,
        sourcePrId: this.source.id,
        type,
        confidence,
        summary,
        evidence: evidence.slice(0, MAX_EVIDENCE),
        needsAiConfirmation,
      });
      return;
    }
    if (RANK[confidence] > RANK[prev.confidence]) {
      prev.confidence = confidence;
      prev.summary = summary;
      prev.needsAiConfirmation = needsAiConfirmation;
      prev.evidence = [...evidence, ...prev.evidence].slice(0, MAX_EVIDENCE);
    } else {
      prev.evidence = [...prev.evidence, ...evidence].slice(0, MAX_EVIDENCE);
    }
  }
  result(): Relationship[] {
    return [...this.map.values()].sort((x, y) =>
      x.prAId + x.prBId + x.type < y.prAId + y.prBId + y.type ? -1 : 1,
    );
  }
}

const ref = (pr: RelationshipPrInput) =>
  pr.number !== undefined ? `${pr.repo}#${pr.number}` : pr.title ? `"${pr.title}"` : pr.id;
const list = (items: string[], max = 3) =>
  items.length <= max
    ? items.join(', ')
    : `${items.slice(0, max).join(', ')} and ${items.length - max} more`;

// ---------------------------------------------------------------------------
// same_file / same_symbol
// ---------------------------------------------------------------------------

function fileRelations(b: Builder, pr: RelationshipPrInput, other: RelationshipPrInput): void {
  if (pr.repo !== other.repo) return;
  const theirs = new Map<string, (typeof other.footprint.files)[number]>();
  for (const f of other.footprint.files) {
    theirs.set(f.path, f);
    if (f.previousPath) theirs.set(f.previousPath, f);
  }
  const overlapping: string[] = [];
  const shared: string[] = [];
  const evidence: Evidence[] = [];
  for (const f of pr.footprint.files) {
    const o = theirs.get(f.path) ?? (f.previousPath ? theirs.get(f.previousPath) : undefined);
    if (!o) continue;
    const conflict =
      (f.status === 'added' && o.status === 'added') ||
      (f.status === 'removed') !== (o.status === 'removed') ||
      rangesOverlap(f.ranges, o.ranges);
    (conflict ? overlapping : shared).push(f.path);
    const e: Evidence = { repo: pr.repo, path: f.path, source: 'diff' };
    const r = f.ranges[0];
    if (r) {
      e.line = r.start;
      if (r.end > r.start) e.endLine = r.end;
    }
    evidence.push(e);
  }
  if (overlapping.length > 0) {
    b.add(
      other,
      'same_file',
      'confirmed',
      `Both PRs edit the same lines in ${list(overlapping)}; merging one will likely cause a merge conflict for the other.`,
      evidence,
    );
  } else if (shared.length > 0) {
    b.add(
      other,
      'same_file',
      'likely',
      `Both PRs change ${list(shared)} (different parts of the file).`,
      evidence,
    );
  }
}

function symbolRelations(b: Builder, pr: RelationshipPrInput, other: RelationshipPrInput): void {
  if (pr.repo !== other.repo) return;
  const theirs = new Map(other.footprint.symbols.map((s) => [`${s.path}|${s.name}`, s]));
  const hits: string[] = [];
  const evidence: Evidence[] = [];
  for (const s of pr.footprint.symbols) {
    const o = theirs.get(`${s.path}|${s.name}`);
    if (!o) continue;
    if (
      s.kind === 'class' &&
      o.kind === 'class' &&
      s.change === 'modified' &&
      o.change === 'modified'
    )
      continue; // container noise
    hits.push(s.name);
    evidence.push({
      repo: pr.repo,
      path: s.path,
      snippet: `${s.kind} ${s.name} (${s.change} / ${o.change})`,
      source: 'diff',
    });
  }
  if (hits.length > 0)
    b.add(
      other,
      'same_symbol',
      'confirmed',
      `Both PRs change the same code: ${list(hits)}.`,
      evidence,
    );
}

// ---------------------------------------------------------------------------
// contract_change
// ---------------------------------------------------------------------------

function describeContract(c: { kind: ContractKind; identifier: string }): string {
  switch (c.kind) {
    case 'http_route':
      return `API endpoint ${c.identifier}`;
    case 'graphql':
      return `GraphQL ${c.identifier}`;
    case 'proto':
      return `gRPC/protobuf ${c.identifier}`;
    case 'queue_topic':
      return `message channel "${c.identifier}"`;
    case 'event':
      return `event "${c.identifier}"`;
    default:
      return c.identifier;
  }
}

function contractPairs(
  b: Builder,
  provPr: RelationshipPrInput,
  consPr: RelationshipPrInput,
  other: RelationshipPrInput,
): void {
  const provs = provPr.footprint.contracts.filter(
    (c) => c.role === 'provider' && API_KINDS.has(c.kind),
  );
  for (const p of provs) {
    // Same provider changed by both PRs.
    for (const q of consPr.footprint.contracts.filter(
      (c) => c.role === 'provider' && c.kind === p.kind,
    )) {
      if (consPr === provPr) continue;
      const m = matchContractIdentifiers(p.kind, p.identifier, q.identifier);
      if (m !== 'exact') continue;
      const sameRepo = provPr.repo === consPr.repo;
      b.add(
        other,
        'contract_change',
        sameRepo ? 'confirmed' : 'possible',
        sameRepo
          ? `Both PRs change the ${describeContract(p)}.`
          : `Both PRs change a ${describeContract(p)} with the same name in different repositories.`,
        [ev(provPr.repo, p), ev(consPr.repo, q)],
      );
    }
    // Provider change vs consumer usage in the other PR.
    for (const c of consPr.footprint.contracts.filter(
      (x) => x.role === 'consumer' && x.kind === p.kind,
    )) {
      const m = matchContractIdentifiers(p.kind, p.identifier, c.identifier);
      if (!m) continue;
      const sameRepo = provPr.repo === consPr.repo;
      const confidence: RelationshipConfidence =
        m === 'suffix' ? 'possible' : sameRepo ? 'confirmed' : 'likely';
      const verb = p.change === 'added' ? 'adds' : p.change === 'removed' ? 'removes' : 'changes';
      b.add(
        other,
        'contract_change',
        confidence,
        `${ref(provPr)} ${verb} the ${describeContract(p)}, which ${ref(consPr)} ${c.change === 'removed' ? 'stops using' : 'uses'}${m === 'suffix' ? ' (path matched by suffix)' : ''}. Release them in a coordinated order.`,
        [ev(provPr.repo, p), ev(consPr.repo, c)],
      );
    }
  }
}

function ev(repo: string, c: FootprintContract | IndexedContract): Evidence {
  const e: Evidence = {
    repo,
    path: c.path,
    snippet: `${c.kind} ${c.role}: ${c.identifier}`,
    source: 'diff',
  };
  return e;
}

function indexRelations(
  b: Builder,
  provPr: RelationshipPrInput,
  consPr: RelationshipPrInput,
  other: RelationshipPrInput,
  index: Map<string, IndexedContract[]>,
): void {
  const touched = new Set(consPr.footprint.files.map((f) => `${consPr.repo}|${f.path}`));
  for (const p of provPr.footprint.contracts) {
    if (p.role !== 'provider' || !API_KINDS.has(p.kind) || p.change === 'added') continue;
    const candidates = index.get(p.kind) ?? [];
    for (const entry of candidates) {
      if (entry.role !== 'consumer') continue;
      if (!touched.has(`${entry.repo}|${entry.path}`)) continue;
      if (entry.repo !== consPr.repo) continue;
      const m = matchContractIdentifiers(p.kind, p.identifier, entry.identifier);
      if (!m) continue;
      const e: Evidence = {
        repo: entry.repo,
        path: entry.path,
        snippet: `uses ${entry.identifier}`,
        source: 'index',
      };
      if (entry.line) e.line = entry.line;
      b.add(
        other,
        'contract_change',
        m === 'exact' ? 'likely' : 'possible',
        `${ref(provPr)} ${p.change === 'removed' ? 'removes' : 'changes'} the ${describeContract(p)}; ${ref(consPr)} edits ${entry.path}, which calls it.`,
        [ev(provPr.repo, p), e],
      );
    }
  }
}

// ---------------------------------------------------------------------------
// shared_table / shared_config
// ---------------------------------------------------------------------------

function sharedRelations(b: Builder, pr: RelationshipPrInput, other: RelationshipPrInput): void {
  const sameRepo = pr.repo === other.repo;
  const tables = pr.footprint.tables.filter((t) => other.footprint.tables.includes(t));
  if (tables.length > 0) {
    b.add(
      other,
      'shared_table',
      sameRepo ? 'confirmed' : 'possible',
      sameRepo
        ? `Both PRs change the database table(s) ${list(tables)}.`
        : `Both PRs change database table(s) named ${list(tables)} in different repositories (may or may not be the same database).`,
      tables
        .slice(0, 5)
        .map((t) => ({ repo: pr.repo, snippet: `table ${t}`, source: 'diff' as const })),
    );
  }
  const envs = pr.footprint.envVars.filter((e) => other.footprint.envVars.includes(e));
  if (envs.length > 0) {
    b.add(
      other,
      'shared_config',
      sameRepo ? 'confirmed' : 'possible',
      sameRepo
        ? `Both PRs change the configuration setting(s) ${list(envs)}.`
        : `Both PRs change configuration setting(s) named ${list(envs)} in different repositories.`,
      envs
        .slice(0, 5)
        .map((e) => ({ repo: pr.repo, snippet: `env ${e}`, source: 'diff' as const })),
    );
  }
}

// ---------------------------------------------------------------------------
// depends_on
// ---------------------------------------------------------------------------

const DEP_KEYWORDS = String.raw`(?:depends\s+on|dependent\s+on|depend\s+on|blocked\s+by|requires|required\s+by|needs|after|builds?\s+on(?:\s+top\s+of)?|built\s+on(?:\s+top\s+of)?|on\s+top\s+of|stacked\s+on|follow[-\s]?up\s+(?:to|of|for)|merge\s+after|part\s+of)`;

/** Extracts explicit PR references with dependency wording from text. */
export function parseDependencyRefs(
  text: string,
  defaultRepo: string,
): Array<{ repo: string; number: number }> {
  const out: Array<{ repo: string; number: number }> = [];
  if (!text) return out;
  const re = new RegExp(
    String.raw`${DEP_KEYWORDS}\s*:?\s*((?:(?:PR|pull\s+request)\s*)?(?:[\w.-]+\/[\w.-]+)?#\d+|https?:\/\/[^\s/]+\/[\w.-]+\/[\w.-]+\/pull\/\d+)((?:\s*(?:,|and|&)\s*(?:[\w.-]+\/[\w.-]+)?#\d+)*)`,
    'gi',
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const chunk = `${m[1] ?? ''}${m[2] ?? ''}`;
    for (const u of chunk.matchAll(/https?:\/\/[^\s/]+\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g))
      out.push({ repo: u[1] ?? defaultRepo, number: Number(u[2]) });
    for (const h of chunk.replace(/https?:\/\/\S+/g, '').matchAll(/(?:([\w.-]+\/[\w.-]+))?#(\d+)/g))
      out.push({ repo: h[1] ?? defaultRepo, number: Number(h[2]) });
  }
  const seen = new Set<string>();
  return out.filter((r) => {
    const k = `${r.repo.toLowerCase()}#${r.number}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function dependsRelations(b: Builder, pr: RelationshipPrInput, other: RelationshipPrInput): void {
  const matches = (refs: Array<{ repo: string; number: number }>, target: RelationshipPrInput) =>
    target.number !== undefined &&
    refs.some(
      (r) => r.number === target.number && r.repo.toLowerCase() === target.repo.toLowerCase(),
    );
  const mine = parseDependencyRefs(`${pr.title}\n${pr.body ?? ''}`, pr.repo);
  const theirs = parseDependencyRefs(`${other.title}\n${other.body ?? ''}`, other.repo);
  if (matches(mine, other)) {
    b.add(
      other,
      'depends_on',
      'confirmed',
      `${ref(pr)} states it depends on ${ref(other)}; merge ${ref(other)} first.`,
      [
        {
          repo: pr.repo,
          snippet: 'PR description references the other PR as a dependency',
          source: 'github',
        },
      ],
    );
  } else if (matches(theirs, pr)) {
    b.add(
      other,
      'depends_on',
      'confirmed',
      `${ref(other)} states it depends on ${ref(pr)}; merge ${ref(pr)} first.`,
      [
        {
          repo: other.repo,
          snippet: 'PR description references this PR as a dependency',
          source: 'github',
        },
      ],
    );
  }
  const issueKey = (i: { number: number; repo?: string | null }, repo: string) =>
    `${(i.repo ?? repo).toLowerCase()}#${i.number}`;
  const myIssues = new Set((pr.linkedIssues ?? []).map((i) => issueKey(i, pr.repo)));
  const shared = (other.linkedIssues ?? [])
    .map((i) => issueKey(i, other.repo))
    .filter((k) => myIssues.has(k));
  if (shared.length > 0) {
    b.add(
      other,
      'depends_on',
      'likely',
      `Both PRs are linked to the same issue (${list(shared)}); they are probably parts of the same piece of work.`,
      shared.map((s) => ({
        repo: pr.repo,
        snippet: `linked issue ${s}`,
        source: 'github' as const,
      })),
    );
  }
}

// ---------------------------------------------------------------------------
// duplicate_work (candidates only)
// ---------------------------------------------------------------------------

const STOP = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'of',
  'to',
  'in',
  'for',
  'on',
  'with',
  'by',
  'from',
  'at',
  'is',
  'it',
  'this',
  'that',
  'be',
  'as',
  'feat',
  'fix',
  'chore',
  'refactor',
  'docs',
  'test',
  'tests',
  'wip',
  'pr',
  'update',
  'updates',
  'add',
  'adds',
  'added',
  'use',
  'make',
  'build',
  'ci',
  'perf',
  'style',
]);

export function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/^\s*\[?[\w-]+(?:\([^)]*\))?!?\]?:\s*/, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .map((t) => t.replace(/(?:ing|ed)$/, '').replace(/([^s])s$/, '$1'))
      .filter((t) => t.length > 1 && !STOP.has(t)),
  );
}

function duplicateRelations(b: Builder, pr: RelationshipPrInput, other: RelationshipPrInput): void {
  const a = titleTokens(pr.title);
  const c = titleTokens(other.title);
  if (a.size === 0 || c.size === 0) return;
  const inter = [...a].filter((t) => c.has(t));
  const union = new Set([...a, ...c]).size;
  const jaccard = inter.length / union;
  const sharedFiles =
    pr.repo === other.repo &&
    pr.footprint.files.some((f) => other.footprint.files.some((o) => o.path === f.path));
  if (inter.length >= 2 && (jaccard >= 0.5 || (jaccard >= 0.34 && sharedFiles))) {
    b.add(
      other,
      'duplicate_work',
      'possible',
      `Titles are similar ("${pr.title}" / "${other.title}"); these PRs may be doing the same work. Needs confirmation.`,
      [{ repo: pr.repo, snippet: `shared terms: ${inter.join(', ')}`, source: 'github' }],
      true,
    );
  }
}

/**
 * Detects relationships between `pr` and each PR in `others`. `consumers` is the contract
 * index of default branches (code_contracts rows) used to find callers touched by other PRs.
 */
export function detectRelationships(
  pr: RelationshipPrInput,
  others: readonly RelationshipPrInput[],
  consumers: ContractIndex = [],
): Relationship[] {
  const b = new Builder(pr);
  const index = new Map<string, IndexedContract[]>();
  for (const c of consumers) index.set(c.kind, [...(index.get(c.kind) ?? []), c]);
  for (const other of others) {
    if (other.id === pr.id) continue;
    fileRelations(b, pr, other);
    symbolRelations(b, pr, other);
    contractPairs(b, pr, other, other);
    contractPairs(b, other, pr, other);
    if (index.size > 0) {
      indexRelations(b, pr, other, other, index);
      indexRelations(b, other, pr, other, index);
    }
    sharedRelations(b, pr, other);
    dependsRelations(b, pr, other);
    duplicateRelations(b, pr, other);
  }
  return b.result();
}
