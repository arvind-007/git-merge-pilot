import { ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useRiskCenter } from '../api/hooks.ts';
import {
  RELATIONSHIP_CONFIDENCES,
  SEVERITIES,
  type RelationshipConfidence,
  type Severity,
} from '../api/types.ts';
import { SeverityBadge, VerifiedBadge } from '../components/badges.tsx';
import { LifecycleBadge } from '../components/findings.tsx';
import { PrTable } from '../components/PrTable.tsx';
import {
  Badge,
  Card,
  CardTitle,
  EmptyState,
  ErrorState,
  Field,
  LoadingBlock,
  PageHeader,
  Select,
} from '../components/ui.tsx';
import { CATEGORY_LABEL, CONFIDENCE_LABEL, SEVERITY_LABEL } from '../lib/format.ts';
import { RelationshipsList } from './ProjectDetailPage.tsx';

export function RiskCenterPage() {
  const rc = useRiskCenter();
  const [minSeverity, setMinSeverity] = useState<Severity>('high');
  const [verifiedOnly, setVerifiedOnly] = useState<'all' | 'verified' | 'concern'>('all');
  const [minConfidence, setMinConfidence] = useState<RelationshipConfidence>('likely');

  if (rc.isPending) return <LoadingBlock />;
  if (rc.isError) return <ErrorState error={rc.error} onRetry={() => void rc.refetch()} />;

  const sevRank = (s: Severity) => SEVERITIES.indexOf(s);
  const findings = rc.data.findings
    .filter((f) => sevRank(f.severity) <= sevRank(minSeverity))
    .filter((f) =>
      verifiedOnly === 'all' ? true : verifiedOnly === 'verified' ? f.verified : !f.verified,
    )
    .sort(
      (a, b) =>
        sevRank(a.severity) - sevRank(b.severity) || Number(b.verified) - Number(a.verified),
    );
  const confRank = (c: RelationshipConfidence) => RELATIONSHIP_CONFIDENCES.indexOf(c);
  const relationships = rc.data.relationships.filter(
    (r) => confRank(r.confidence) <= confRank(minConfidence),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Risk center"
        description="High-risk pull requests, serious findings and overlapping work across every project you can see."
      />

      <Card>
        <CardTitle description="Open pull requests rated high or critical risk.">
          High-risk pull requests
        </CardTitle>
        <PrTable
          prs={rc.data.pullRequests}
          empty={
            <EmptyState icon={<ShieldAlert />} title="No high-risk pull requests">
              Nothing is currently rated high or critical. This view updates as pull requests are
              analyzed.
            </EmptyState>
          }
        />
      </Card>

      <Card>
        <CardTitle description="Security, breaking-change and other findings on open pull requests.">
          Findings
        </CardTitle>
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <Field label="Minimum severity">
            <Select
              value={minSeverity}
              onChange={(e) => setMinSeverity(e.target.value as Severity)}
            >
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABEL[s]} and above
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Show">
            <Select
              value={verifiedOnly}
              onChange={(e) => setVerifiedOnly(e.target.value as typeof verifiedOnly)}
            >
              <option value="all">Verified facts and potential concerns</option>
              <option value="verified">Verified facts only</option>
              <option value="concern">Potential concerns only</option>
            </Select>
          </Field>
        </div>
        {findings.length ? (
          <ul className="divide-y divide-slate-200 dark:divide-slate-700">
            {findings.map((f) => (
              <li key={f.id} className="py-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <SeverityBadge severity={f.severity} />
                  <VerifiedBadge verified={f.verified} />
                  <Badge>{CATEGORY_LABEL[f.category]}</Badge>
                  {f.lifecycle && f.lifecycle !== 'unchanged' && (
                    <LifecycleBadge lifecycle={f.lifecycle} />
                  )}
                </div>
                <div className="mt-1 font-medium break-words">{f.title}</div>
                {f.data?.description && (
                  <p className="mt-0.5 line-clamp-2 text-sm text-slate-600 dark:text-slate-400">
                    {f.data.description}
                  </p>
                )}
                <Link
                  to={`/pull-requests/${f.pullRequest.id}?tab=${f.category === 'security' ? 'security' : f.category === 'breaking_change' || f.category === 'integration' ? 'breaking' : 'summary'}`}
                  className="mt-1 inline-block text-sm break-all text-indigo-700 hover:underline dark:text-indigo-300"
                >
                  {f.pullRequest.repositoryFullName}#{f.pullRequest.number} — {f.pullRequest.title}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No findings at this level">
            Try lowering the minimum severity to see more.
          </EmptyState>
        )}
      </Card>

      <Card>
        <CardTitle description="Open pull requests that touch the same code, data or contracts — possibly across repositories.">
          Overlapping work
        </CardTitle>
        <Field label="Minimum confidence" className="mb-4 max-w-xs">
          <Select
            value={minConfidence}
            onChange={(e) => setMinConfidence(e.target.value as RelationshipConfidence)}
          >
            {RELATIONSHIP_CONFIDENCES.map((c) => (
              <option key={c} value={c}>
                {CONFIDENCE_LABEL[c]}
                {c === 'possible' ? ' (all)' : ' and above'}
              </option>
            ))}
          </Select>
        </Field>
        <RelationshipsList items={relationships} />
      </Card>
    </div>
  );
}
