import {
  compareSeverityDesc,
  sha256Hex,
  type Evidence,
  type Finding,
  type FindingCategory,
  type Severity,
} from '@gmp/core';

const SEP = '\u001f';

/**
 * Stable fingerprint for a finding: sha256 (hex) of the parts after trimming and collapsing
 * whitespace, joined with a unit separator. Parts should exclude volatile data such as line
 * numbers so a finding keeps its identity when code moves.
 */
export function fingerprint(parts: readonly string[]): string {
  return sha256Hex(
    parts
      .map((p) =>
        String(p ?? '')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .join(SEP),
  );
}

/** Splits findings into new / unchanged / resolved by fingerprint. */
export function diffFindings<T extends Pick<Finding, 'fingerprint'>>(
  previous: readonly T[],
  current: readonly T[],
): { new: T[]; unchanged: T[]; resolved: T[] } {
  const prev = new Set(previous.map((f) => f.fingerprint));
  const cur = new Set(current.map((f) => f.fingerprint));
  const seen = new Set<string>();
  const out = { new: [] as T[], unchanged: [] as T[], resolved: [] as T[] };
  for (const f of current) {
    if (seen.has(f.fingerprint)) continue;
    seen.add(f.fingerprint);
    (prev.has(f.fingerprint) ? out.unchanged : out.new).push(f);
  }
  const seenPrev = new Set<string>();
  for (const f of previous) {
    if (cur.has(f.fingerprint) || seenPrev.has(f.fingerprint)) continue;
    seenPrev.add(f.fingerprint);
    out.resolved.push(f);
  }
  return out;
}

export interface FindingSpec {
  ruleId: string;
  category: FindingCategory;
  severity: Severity;
  title: string;
  description: string;
  technicalDetail?: string;
  whatMightBreak?: string;
  recommendation?: string;
  affected?: string[];
  evidence: Evidence[];
  /** Stable identity parts (no line numbers). */
  identity: string[];
  source?: Finding['source'];
  verified?: boolean;
}

export function makeFinding(spec: FindingSpec): Finding {
  const f: Finding = {
    fingerprint: fingerprint([spec.category, spec.ruleId, ...spec.identity]),
    category: spec.category,
    severity: spec.severity,
    title: spec.title,
    description: spec.description,
    evidence: spec.evidence,
    verified: spec.verified ?? true,
    source: spec.source ?? 'rule',
    ruleId: spec.ruleId,
  };
  if (spec.technicalDetail) f.technicalDetail = spec.technicalDetail;
  if (spec.whatMightBreak) f.whatMightBreak = spec.whatMightBreak;
  if (spec.recommendation) f.recommendation = spec.recommendation;
  if (spec.affected && spec.affected.length > 0) f.affected = spec.affected;
  return f;
}

/** Deterministic ordering: severity desc, then category, path, line, title. */
export function sortFindings(list: Finding[]): Finding[] {
  return [...list].sort((a, b) => {
    const s = compareSeverityDesc(a.severity, b.severity);
    if (s !== 0) return s;
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    const pa = a.evidence[0]?.path ?? '';
    const pb = b.evidence[0]?.path ?? '';
    if (pa !== pb) return pa < pb ? -1 : 1;
    const la = a.evidence[0]?.line ?? 0;
    const lb = b.evidence[0]?.line ?? 0;
    if (la !== lb) return la - lb;
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
  });
}

/** Removes duplicate fingerprints, keeping the first (most severe after sorting). */
export function dedupeFindings(list: Finding[]): Finding[] {
  const seen = new Set<string>();
  return sortFindings(list).filter((f) => {
    if (seen.has(f.fingerprint)) return false;
    seen.add(f.fingerprint);
    return true;
  });
}
