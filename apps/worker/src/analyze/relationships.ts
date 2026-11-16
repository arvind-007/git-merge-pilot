/** Cross-PR relationship inputs (peers, consumer index) and persistence of pr_relationships. */
import type { ConfirmedRelationship, RelationshipCandidate, ReportRelationship } from '@gmp/ai';
import type {
  ChangeFacts,
  Footprint,
  IndexedContract,
  Relationship,
  RelationshipPrInput,
} from '@gmp/analysis';
import type { AiMode, ContractKind, RelationshipConfidence } from '@gmp/core';
import {
  analyses,
  codeContracts,
  prRelationships,
  pullRequests,
  repositories,
  type DbOrTx,
  type PrRelationship,
} from '@gmp/db';
import { and, desc, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import { prRef } from '../util.ts';

/** What `analyses.footprint` holds: the Footprint plus slim ChangeFacts for readiness recomputes. */
export type StoredFootprint = Footprint & { facts?: ChangeFacts };

export function isFootprint(v: unknown): v is StoredFootprint {
  const f = v as Partial<Footprint> | null;
  return (
    !!f &&
    typeof f === 'object' &&
    typeof f.repo === 'string' &&
    Array.isArray(f.files) &&
    Array.isArray(f.symbols) &&
    Array.isArray(f.contracts) &&
    Array.isArray(f.tables)
  );
}

/** Drops per-file hunks (large, not needed by scoreRisk) so facts can be stored with the footprint. */
export function slimFacts(facts: ChangeFacts): ChangeFacts {
  return { ...facts, files: [] };
}

/** Footprint without the embedded facts (for relationship detection). */
export function bareFootprint(f: StoredFootprint): Footprint {
  const { facts: _facts, ...rest } = f;
  return rest;
}

export interface PeerPr {
  input: RelationshipPrInput;
  ref: string;
  repositoryId: string;
  aiMode: AiMode;
  excludePaths: string[];
}

/** Latest completed analysis footprint of every other open PR in the org (monitored repos). */
export async function loadPeers(
  db: DbOrTx,
  orgId: string,
  excludePullRequestId: string,
  limit: number,
): Promise<PeerPr[]> {
  const rows = await db
    .selectDistinctOn([analyses.pullRequestId], {
      pullRequestId: analyses.pullRequestId,
      footprint: analyses.footprint,
      number: pullRequests.number,
      title: pullRequests.title,
      body: pullRequests.body,
      linkedIssues: pullRequests.linkedIssues,
      fullName: repositories.fullName,
      repositoryId: repositories.id,
      aiMode: repositories.aiMode,
      excludePaths: repositories.excludePaths,
    })
    .from(analyses)
    .innerJoin(pullRequests, eq(pullRequests.id, analyses.pullRequestId))
    .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
    .where(
      and(
        eq(analyses.orgId, orgId),
        eq(pullRequests.orgId, orgId),
        eq(pullRequests.state, 'open'),
        eq(repositories.monitoringEnabled, true),
        ne(pullRequests.id, excludePullRequestId),
        eq(analyses.status, 'completed'),
        inArray(analyses.kind, ['full', 'incremental']),
        isNotNull(analyses.footprint),
      ),
    )
    .orderBy(
      analyses.pullRequestId,
      // The analysis of the PR's current head, else the latest completed one.
      sql`(${analyses.headSha} = ${pullRequests.headSha}) desc`,
      desc(analyses.completedAt),
      desc(analyses.createdAt),
    )
    .limit(limit);
  const peers: PeerPr[] = [];
  for (const r of rows) {
    if (!isFootprint(r.footprint)) continue;
    peers.push({
      input: {
        id: r.pullRequestId,
        repo: r.fullName,
        number: r.number,
        footprint: bareFootprint(r.footprint),
        title: r.title,
        body: r.body,
        linkedIssues: r.linkedIssues,
      },
      ref: prRef(r.fullName, r.number),
      repositoryId: r.repositoryId,
      aiMode: r.aiMode,
      excludePaths: r.excludePaths,
    });
  }
  return peers;
}

const INDEX_KINDS = new Set<ContractKind>([
  'http_route',
  'graphql',
  'proto',
  'queue_topic',
  'event',
]);
const MAX_INDEX_ROWS = 50_000;

/** Default-branch consumer usages (code_contracts) for contract kinds providers in `footprints` change. */
export async function loadConsumerIndex(
  db: DbOrTx,
  orgId: string,
  footprints: readonly Footprint[],
): Promise<IndexedContract[]> {
  const kinds = new Set<ContractKind>();
  for (const f of footprints) {
    for (const c of f.contracts) {
      if (c.role === 'provider' && INDEX_KINDS.has(c.kind)) kinds.add(c.kind);
    }
  }
  if (kinds.size === 0) return [];
  const rows = await db
    .select({
      repo: repositories.fullName,
      path: codeContracts.path,
      kind: codeContracts.kind,
      identifier: codeContracts.identifier,
      role: codeContracts.role,
      line: codeContracts.line,
    })
    .from(codeContracts)
    .innerJoin(repositories, eq(repositories.id, codeContracts.repositoryId))
    .where(
      and(
        eq(codeContracts.orgId, orgId),
        eq(codeContracts.role, 'consumer'),
        inArray(codeContracts.kind, [...kinds]),
      ),
    )
    .limit(MAX_INDEX_ROWS);
  return rows.map((r) => ({
    repo: r.repo,
    path: r.path,
    kind: r.kind,
    identifier: r.identifier,
    role: r.role,
    ...(r.line !== null ? { line: r.line } : {}),
  }));
}

const RANK: Record<RelationshipConfidence, number> = { confirmed: 3, likely: 2, possible: 1 };
const relKey = (r: { prAId: string; prBId: string; type: string }) =>
  `${r.prAId}|${r.prBId}|${r.type}`;

/**
 * Sends `needsAiConfirmation` candidates (duplicate work) to the AI. Candidates the AI judges
 * unrelated are dropped; when AI is unavailable they are kept unchanged ('possible').
 */
export async function confirmCandidates(
  rels: Relationship[],
  briefs: Map<string, RelationshipCandidate['prA']>,
  confirm: (c: RelationshipCandidate[]) => Promise<ConfirmedRelationship[]>,
): Promise<Relationship[]> {
  const candidates = rels.filter((r) => r.needsAiConfirmation);
  if (candidates.length === 0) return rels;
  const asks: RelationshipCandidate[] = [];
  for (const r of candidates) {
    const prA = briefs.get(r.prAId);
    const prB = briefs.get(r.prBId);
    if (!prA || !prB) continue;
    asks.push({
      prA,
      prB,
      type: r.type,
      confidence: r.confidence,
      summary: r.summary,
      evidence: r.evidence,
    });
  }
  const confirmed = await confirm(asks);
  const verdicts = new Map(
    confirmed.map((c) => [relKey({ prAId: c.prA.id, prBId: c.prB.id, type: c.type }), c]),
  );
  const asked = new Set(
    asks.map((c) => relKey({ prAId: c.prA.id, prBId: c.prB.id, type: c.type })),
  );
  const out: Relationship[] = [];
  for (const r of rels) {
    const key = relKey(r);
    if (!r.needsAiConfirmation || !asked.has(key)) {
      out.push(r);
      continue;
    }
    const v = verdicts.get(key);
    if (!v) continue; // judged unrelated
    out.push({
      ...r,
      // AI review never raises a candidate's confidence (duplicate work stays 'possible').
      confidence: RANK[v.confidence] < RANK[r.confidence] ? v.confidence : r.confidence,
      summary: v.summary,
      needsAiConfirmation: !v.ai,
    });
  }
  return out;
}

export interface PersistRelationshipsResult {
  /** Relationships that are new, re-activated or increased in confidence. */
  appeared: Relationship[];
  /** Other PRs whose relationship with this PR changed in any way. */
  affectedPullRequestIds: string[];
}

/**
 * Upserts this PR's relationships and deactivates its previously active relationships that were
 * not detected again.
 */
export async function persistRelationships(
  db: DbOrTx,
  orgId: string,
  pullRequestId: string,
  rels: readonly Relationship[],
): Promise<PersistRelationshipsResult> {
  const existing = await db
    .select()
    .from(prRelationships)
    .where(
      and(
        eq(prRelationships.orgId, orgId),
        or(eq(prRelationships.prAId, pullRequestId), eq(prRelationships.prBId, pullRequestId)),
      ),
    );
  const byKey = new Map(existing.map((r) => [relKey(r), r]));
  const seen = new Set<string>();
  const appeared: Relationship[] = [];
  const affected = new Set<string>();
  const other = (r: { prAId: string; prBId: string }) =>
    r.prAId === pullRequestId ? r.prBId : r.prAId;

  for (const r of rels) {
    const key = relKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    const prev = byKey.get(key);
    if (!prev || !prev.active || RANK[r.confidence] > RANK[prev.confidence]) appeared.push(r);
    if (!prev || !prev.active || prev.confidence !== r.confidence || prev.summary !== r.summary) {
      affected.add(other(r));
    }
    await db
      .insert(prRelationships)
      .values({
        orgId,
        prAId: r.prAId,
        prBId: r.prBId,
        type: r.type,
        confidence: r.confidence,
        summary: r.summary,
        evidence: r.evidence,
        active: true,
      })
      .onConflictDoUpdate({
        target: [prRelationships.prAId, prRelationships.prBId, prRelationships.type],
        set: { confidence: r.confidence, summary: r.summary, evidence: r.evidence, active: true },
      });
  }
  const stale = existing.filter((r) => r.active && !seen.has(relKey(r)));
  if (stale.length > 0) {
    await db
      .update(prRelationships)
      .set({ active: false })
      .where(
        inArray(
          prRelationships.id,
          stale.map((r) => r.id),
        ),
      );
    for (const r of stale) affected.add(other(r));
  }
  return { appeared, affectedPullRequestIds: [...affected] };
}

export interface ActiveRelationship {
  relationship: Relationship;
  otherRef: string;
  other: PeerInfo;
}

/** Active relationships of a PR as analysis `Relationship`s, with the other PR's reference. */
export async function loadActiveRelationships(
  db: DbOrTx,
  orgId: string,
  pullRequestId: string,
): Promise<ActiveRelationship[]> {
  const rows: PrRelationship[] = await db
    .select()
    .from(prRelationships)
    .where(
      and(
        eq(prRelationships.orgId, orgId),
        eq(prRelationships.active, true),
        or(eq(prRelationships.prAId, pullRequestId), eq(prRelationships.prBId, pullRequestId)),
      ),
    );
  if (rows.length === 0) return [];
  const otherIds = [...new Set(rows.map((r) => (r.prAId === pullRequestId ? r.prBId : r.prAId)))];
  const refs = await db
    .select({
      id: pullRequests.id,
      number: pullRequests.number,
      fullName: repositories.fullName,
      repositoryId: repositories.id,
      aiMode: repositories.aiMode,
      excludePaths: repositories.excludePaths,
    })
    .from(pullRequests)
    .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
    .where(inArray(pullRequests.id, otherIds));
  const peerById = new Map<string, PeerInfo>(
    refs.map((r) => [
      r.id,
      {
        ref: prRef(r.fullName, r.number),
        repositoryId: r.repositoryId,
        repository: r.fullName,
        aiMode: r.aiMode,
        excludePaths: r.excludePaths,
      },
    ]),
  );
  return rows.map((r) => {
    const otherId = r.prAId === pullRequestId ? r.prBId : r.prAId;
    return {
      relationship: {
        prAId: r.prAId,
        prBId: r.prBId,
        sourcePrId: pullRequestId,
        type: r.type,
        confidence: r.confidence,
        summary: r.summary,
        evidence: r.evidence,
        needsAiConfirmation: false,
      },
      otherRef: peerById.get(otherId)?.ref ?? otherId,
      other: peerById.get(otherId) ?? { ref: otherId },
    };
  });
}

/** What a report needs to know about the other PR of a relationship. */
export interface PeerInfo {
  ref: string;
  repositoryId?: string;
  repository?: string;
  aiMode?: AiMode;
  excludePaths?: readonly string[] | null;
}

export function toReportRelationships(
  pullRequestId: string,
  rels: readonly Relationship[],
  peerOf: (id: string) => PeerInfo,
): ReportRelationship[] {
  return rels.map((r) => {
    const otherId = r.prAId === pullRequestId ? r.prBId : r.prAId;
    const peer = peerOf(otherId);
    return {
      prRef: peer.ref,
      pullRequestId: otherId,
      ...(peer.repository ? { repository: peer.repository } : {}),
      ...(peer.aiMode ? { aiMode: peer.aiMode } : {}),
      ...(peer.excludePaths ? { excludePaths: peer.excludePaths } : {}),
      type: r.type,
      confidence: r.confidence,
      summary: r.summary,
      evidence: r.evidence,
    };
  });
}
