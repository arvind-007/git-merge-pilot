/**
 * Read models shared by the PR, project, repository and dashboard endpoints. Every query is
 * scoped by org and by the caller's accessible repository ids.
 */
import { sql, type SQL } from 'drizzle-orm';
import type {
  Finding,
  PrState,
  Recommendation,
  RelationshipConfidence,
  RelationshipType,
  RiskLevel,
  Severity,
  AnalysisStatus,
  GeneratedBy,
  FindingCategory,
  FindingLifecycle,
} from '@gmp/core';
import type { Database } from '@gmp/db';
import type { AccessScope } from '../access.ts';

export interface PrListItem {
  id: string;
  repositoryId: string;
  repositoryFullName: string;
  number: number;
  title: string;
  state: PrState;
  draft: boolean;
  authorLogin: string | null;
  htmlUrl: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  openedAt: Date | null;
  mergedAt: Date | null;
  lastEventAt: Date | null;
  updatedAt: Date;
  reviewDecision: string | null;
  overallRisk: RiskLevel | null;
  recommendation: Recommendation | null;
  confidence: number | null;
  analysisStatus: AnalysisStatus | null;
  generatedBy: GeneratedBy | null;
  analysisId: string | null;
  findingCounts: Partial<Record<Severity, number>>;
  projectIds: string[];
}

export interface PrRef {
  id: string;
  number: number;
  title: string;
  repositoryFullName: string;
  htmlUrl: string;
  authorLogin: string | null;
  state: PrState;
  overallRisk: RiskLevel | null;
}

export interface PrListFilters {
  projectId?: string;
  repositoryId?: string;
  state?: PrState;
  risk?: RiskLevel;
  risks?: RiskLevel[];
  recommendations?: Recommendation[];
  author?: string;
  ids?: string[];
  limit?: number;
  offset?: number;
}

/** Postgres uuid[] literal; inputs are uuids that came from the database or were zod-validated. */
export function uuidArray(ids: readonly string[]): string {
  for (const id of ids) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('invalid uuid in array');
  }
  return `{${ids.join(',')}}`;
}

function textArray(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replace(/["\\]/g, '')}"`).join(',')}}`;
}

type Row = Record<string, unknown>;

async function rows(db: Database, query: SQL): Promise<Row[]> {
  const res = await db.execute(query);
  return (res as unknown as { rows: Row[] }).rows;
}

const toDate = (v: unknown): Date | null =>
  v == null ? null : v instanceof Date ? v : new Date(String(v));

/** Lists PRs with their latest analysis summary. */
export async function listPrItems(
  db: Database,
  scope: AccessScope,
  filters: PrListFilters = {},
): Promise<PrListItem[]> {
  let repoIds = scope.repositoryIds;
  if (filters.repositoryId) repoIds = repoIds.filter((id) => id === filters.repositoryId);
  if (repoIds.length === 0) return [];

  const where: SQL[] = [
    sql`pr.org_id = ${scope.orgId}`,
    sql`pr.repository_id = ANY(${uuidArray(repoIds)}::uuid[])`,
  ];
  if (filters.projectId) {
    where.push(
      sql`pr.repository_id IN (SELECT pj.repository_id FROM project_repositories pj WHERE pj.project_id = ${filters.projectId})`,
    );
  }
  if (filters.state) where.push(sql`pr.state = ${filters.state}`);
  if (filters.author) where.push(sql`lower(pr.author_login) = ${filters.author.toLowerCase()}`);
  if (filters.risk) where.push(sql`la.overall_risk = ${filters.risk}`);
  if (filters.ids) {
    if (filters.ids.length === 0) return [];
    where.push(sql`pr.id = ANY(${uuidArray(filters.ids)}::uuid[])`);
  }
  const extra: SQL[] = [];
  if (filters.risks?.length)
    extra.push(sql`la.overall_risk = ANY(${textArray(filters.risks)}::text[])`);
  if (filters.recommendations?.length) {
    extra.push(sql`la.recommendation = ANY(${textArray(filters.recommendations)}::text[])`);
  }
  if (extra.length) where.push(sql`(${sql.join(extra, sql` OR `)})`);

  const limit = Math.max(1, Math.min(filters.limit ?? 100, 2000));
  const offset = Math.max(0, filters.offset ?? 0);

  const result = await rows(
    db,
    sql`
    SELECT pr.id, pr.repository_id, r.full_name AS repository_full_name, pr.number, pr.title,
           pr.state, pr.draft, pr.author_login, pr.html_url, pr.head_sha, pr.additions,
           pr.deletions, pr.changed_files, pr.opened_at, pr.merged_at, pr.last_event_at,
           pr.updated_at, pr.review_decision,
           la.id AS analysis_id, la.overall_risk, la.recommendation, la.confidence, la.generated_by,
           ls.status AS analysis_status, lf.id AS findings_analysis_id
    FROM pull_requests pr
    JOIN repositories r ON r.id = pr.repository_id
    LEFT JOIN LATERAL (
      SELECT a.id, a.overall_risk, a.recommendation, a.confidence, a.generated_by
      FROM analyses a
      WHERE a.pull_request_id = pr.id AND a.status = 'completed'
      ORDER BY (a.head_sha = pr.head_sha) DESC, a.completed_at DESC NULLS LAST, a.created_at DESC
      LIMIT 1
    ) la ON true
    LEFT JOIN LATERAL (
      SELECT a.status FROM analyses a WHERE a.pull_request_id = pr.id
      ORDER BY a.created_at DESC LIMIT 1
    ) ls ON true
    LEFT JOIN LATERAL (
      SELECT a.id FROM analyses a
      WHERE a.pull_request_id = pr.id AND a.status = 'completed' AND a.kind <> 'readiness_only'
      ORDER BY (a.head_sha = pr.head_sha) DESC, a.completed_at DESC NULLS LAST, a.created_at DESC
      LIMIT 1
    ) lf ON true
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY COALESCE(pr.last_event_at, pr.updated_at) DESC, pr.id
    LIMIT ${limit} OFFSET ${offset}`,
  );
  if (result.length === 0) return [];

  const findingIds = result
    .map((r) => r.findings_analysis_id)
    .filter((v): v is string => typeof v === 'string');
  const counts = new Map<string, Partial<Record<Severity, number>>>();
  if (findingIds.length) {
    const fr = await rows(
      db,
      sql`SELECT analysis_id, severity, count(*)::int AS n FROM findings
          WHERE analysis_id = ANY(${uuidArray(findingIds)}::uuid[]) AND lifecycle <> 'resolved'
          GROUP BY analysis_id, severity`,
    );
    for (const f of fr) {
      const key = String(f.analysis_id);
      const c = counts.get(key) ?? {};
      c[f.severity as Severity] = Number(f.n);
      counts.set(key, c);
    }
  }

  const repoSet = [...new Set(result.map((r) => String(r.repository_id)))];
  const projectsByRepo = new Map<string, string[]>();
  if (scope.projectIds.length) {
    const pr = await rows(
      db,
      sql`SELECT repository_id, project_id FROM project_repositories
          WHERE repository_id = ANY(${uuidArray(repoSet)}::uuid[])
            AND project_id = ANY(${uuidArray(scope.projectIds)}::uuid[])`,
    );
    for (const p of pr) {
      const list = projectsByRepo.get(String(p.repository_id)) ?? [];
      list.push(String(p.project_id));
      projectsByRepo.set(String(p.repository_id), list);
    }
  }

  return result.map((r) => ({
    id: String(r.id),
    repositoryId: String(r.repository_id),
    repositoryFullName: String(r.repository_full_name),
    number: Number(r.number),
    title: String(r.title),
    state: r.state as PrState,
    draft: Boolean(r.draft),
    authorLogin: (r.author_login as string | null) ?? null,
    htmlUrl: String(r.html_url),
    headSha: String(r.head_sha),
    additions: Number(r.additions ?? 0),
    deletions: Number(r.deletions ?? 0),
    changedFiles: Number(r.changed_files ?? 0),
    openedAt: toDate(r.opened_at),
    mergedAt: toDate(r.merged_at),
    lastEventAt: toDate(r.last_event_at),
    updatedAt: toDate(r.updated_at) ?? new Date(0),
    reviewDecision: (r.review_decision as string | null) ?? null,
    overallRisk: (r.overall_risk as RiskLevel | null) ?? null,
    recommendation: (r.recommendation as Recommendation | null) ?? null,
    confidence: r.confidence == null ? null : Number(r.confidence),
    analysisStatus: (r.analysis_status as AnalysisStatus | null) ?? null,
    generatedBy: (r.generated_by as GeneratedBy | null) ?? null,
    analysisId: (r.analysis_id as string | null) ?? null,
    findingCounts: r.findings_analysis_id ? (counts.get(String(r.findings_analysis_id)) ?? {}) : {},
    projectIds: projectsByRepo.get(String(r.repository_id)) ?? [],
  }));
}

export function toPrRef(item: PrListItem): PrRef {
  return {
    id: item.id,
    number: item.number,
    title: item.title,
    repositoryFullName: item.repositoryFullName,
    htmlUrl: item.htmlUrl,
    authorLogin: item.authorLogin,
    state: item.state,
    overallRisk: item.overallRisk,
  };
}

export function countBy<T, K extends string>(
  items: readonly T[],
  key: (t: T) => K | null,
): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const it of items) {
    const k = key(it);
    if (k === null) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export interface RelationshipItem {
  id: string;
  type: RelationshipType;
  confidence: RelationshipConfidence;
  summary: string;
  evidence: unknown[];
  active: boolean;
  prA: PrRef;
  prB: PrRef;
}

/** Active relationships where both PRs are readable by the caller. */
export async function listRelationships(
  db: Database,
  scope: AccessScope,
  opts: {
    pullRequestIds?: string[];
    confidences?: RelationshipConfidence[];
    openOnly?: boolean;
    limit?: number;
  } = {},
): Promise<RelationshipItem[]> {
  if (scope.repositoryIds.length === 0) return [];
  const repos = uuidArray(scope.repositoryIds);
  const where: SQL[] = [
    sql`rel.org_id = ${scope.orgId}`,
    sql`rel.active = true`,
    sql`a.repository_id = ANY(${repos}::uuid[])`,
    sql`b.repository_id = ANY(${repos}::uuid[])`,
  ];
  if (opts.pullRequestIds) {
    if (opts.pullRequestIds.length === 0) return [];
    const ids = uuidArray(opts.pullRequestIds);
    where.push(sql`(rel.pr_a_id = ANY(${ids}::uuid[]) OR rel.pr_b_id = ANY(${ids}::uuid[]))`);
  }
  if (opts.confidences?.length) {
    where.push(sql`rel.confidence = ANY(${textArray(opts.confidences)}::text[])`);
  }
  if (opts.openOnly) where.push(sql`a.state = 'open' AND b.state = 'open'`);
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const result = await rows(
    db,
    sql`
    SELECT rel.id, rel.type, rel.confidence, rel.summary, rel.evidence, rel.active,
           a.id AS a_id, a.number AS a_number, a.title AS a_title, a.html_url AS a_url,
           a.author_login AS a_author, a.state AS a_state, ra.full_name AS a_repo,
           b.id AS b_id, b.number AS b_number, b.title AS b_title, b.html_url AS b_url,
           b.author_login AS b_author, b.state AS b_state, rb.full_name AS b_repo,
           (SELECT x.overall_risk FROM analyses x WHERE x.pull_request_id = a.id AND x.status = 'completed'
              ORDER BY (x.head_sha = a.head_sha) DESC, x.completed_at DESC NULLS LAST, x.created_at DESC LIMIT 1) AS a_risk,
           (SELECT x.overall_risk FROM analyses x WHERE x.pull_request_id = b.id AND x.status = 'completed'
              ORDER BY (x.head_sha = b.head_sha) DESC, x.completed_at DESC NULLS LAST, x.created_at DESC LIMIT 1) AS b_risk
    FROM pr_relationships rel
    JOIN pull_requests a ON a.id = rel.pr_a_id
    JOIN pull_requests b ON b.id = rel.pr_b_id
    JOIN repositories ra ON ra.id = a.repository_id
    JOIN repositories rb ON rb.id = b.repository_id
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY CASE rel.confidence WHEN 'confirmed' THEN 0 WHEN 'likely' THEN 1 ELSE 2 END, rel.updated_at DESC
    LIMIT ${limit}`,
  );
  const ref = (r: Row, p: 'a' | 'b'): PrRef => ({
    id: String(r[`${p}_id`]),
    number: Number(r[`${p}_number`]),
    title: String(r[`${p}_title`]),
    repositoryFullName: String(r[`${p}_repo`]),
    htmlUrl: String(r[`${p}_url`]),
    authorLogin: (r[`${p}_author`] as string | null) ?? null,
    state: r[`${p}_state`] as PrState,
    overallRisk: (r[`${p}_risk`] as RiskLevel | null) ?? null,
  });
  return result.map((r) => ({
    id: String(r.id),
    type: r.type as RelationshipType,
    confidence: r.confidence as RelationshipConfidence,
    summary: String(r.summary),
    evidence: Array.isArray(r.evidence) ? r.evidence : [],
    active: Boolean(r.active),
    prA: ref(r, 'a'),
    prB: ref(r, 'b'),
  }));
}

export interface RiskFindingItem {
  id: string;
  title: string;
  severity: Severity;
  category: FindingCategory;
  verified: boolean;
  lifecycle: FindingLifecycle;
  createdAt: Date | null;
  pullRequest: PrRef;
  data: Finding;
}

/** Findings of the latest (non-readiness) analysis of open PRs, most severe first. */
export async function listOpenFindings(
  db: Database,
  scope: AccessScope,
  opts: { severities?: Severity[]; repositoryId?: string; projectId?: string; limit?: number } = {},
): Promise<RiskFindingItem[]> {
  let repoIds = scope.repositoryIds;
  if (opts.repositoryId) repoIds = repoIds.filter((id) => id === opts.repositoryId);
  if (repoIds.length === 0) return [];
  const where: SQL[] = [
    sql`pr.org_id = ${scope.orgId}`,
    sql`pr.state = 'open'`,
    sql`pr.repository_id = ANY(${uuidArray(repoIds)}::uuid[])`,
    sql`f.lifecycle <> 'resolved'`,
  ];
  if (opts.severities?.length)
    where.push(sql`f.severity = ANY(${textArray(opts.severities)}::text[])`);
  if (opts.projectId) {
    where.push(
      sql`pr.repository_id IN (SELECT pj.repository_id FROM project_repositories pj WHERE pj.project_id = ${opts.projectId})`,
    );
  }
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
  const result = await rows(
    db,
    sql`
    SELECT f.id, f.title, f.severity, f.category, f.verified, f.lifecycle, f.data, f.created_at,
           pr.id AS pr_id, pr.number, pr.title AS pr_title, pr.html_url, pr.author_login, pr.state,
           r.full_name, lf.overall_risk
    FROM pull_requests pr
    JOIN repositories r ON r.id = pr.repository_id
    JOIN LATERAL (
      SELECT a.id, a.overall_risk FROM analyses a
      WHERE a.pull_request_id = pr.id AND a.status = 'completed' AND a.kind <> 'readiness_only'
      ORDER BY (a.head_sha = pr.head_sha) DESC, a.completed_at DESC NULLS LAST, a.created_at DESC LIMIT 1
    ) lf ON true
    JOIN findings f ON f.analysis_id = lf.id
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
             f.verified DESC, f.created_at DESC
    LIMIT ${limit}`,
  );
  return result.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    severity: r.severity as Severity,
    category: r.category as FindingCategory,
    verified: Boolean(r.verified),
    lifecycle: r.lifecycle as FindingLifecycle,
    createdAt: toDate(r.created_at),
    data: r.data as Finding,
    pullRequest: {
      id: String(r.pr_id),
      number: Number(r.number),
      title: String(r.pr_title),
      repositoryFullName: String(r.full_name),
      htmlUrl: String(r.html_url),
      authorLogin: (r.author_login as string | null) ?? null,
      state: r.state as PrState,
      overallRisk: (r.overall_risk as RiskLevel | null) ?? null,
    },
  }));
}
