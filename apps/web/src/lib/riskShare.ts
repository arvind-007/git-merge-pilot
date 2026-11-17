import {
  RISK_DIMENSIONS,
  SEVERITIES,
  type Finding,
  type PrReport,
  type PullRequestDetail,
} from '../api/types.ts';
import { DIMENSION_LABEL, SEVERITY_LABEL } from './format.ts';

const MAX_LINE = 160;

/** First sentence of a free-text explanation, collapsed to one line and capped in length. */
export function oneLiner(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length > MAX_LINE ? `${sentence.slice(0, MAX_LINE - 1).trimEnd()}…` : sentence;
}

/**
 * One line per risk worth telling the PR author about: every risk dimension above "low",
 * each merge blocker, and every breaking-change / security / integration finding above "info",
 * most severe first. Duplicate lines are dropped.
 */
export function riskShareLines(report: PrReport): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  const add = (line: string) => {
    const key = line.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      lines.push(line);
    }
  };

  const byDim = new Map(report.riskScores.map((s) => [s.dimension, s]));
  const dims = RISK_DIMENSIONS.map((d) => byDim.get(d))
    .filter((s) => s && s.level !== 'low')
    .sort((a, b) => b!.score - a!.score);
  for (const s of dims) {
    add(
      `${DIMENSION_LABEL[s!.dimension]} (${SEVERITY_LABEL[s!.level]}): ${oneLiner(s!.rationale)}`,
    );
  }

  for (const blocker of report.mergeReadiness.blockers) add(`Blocker: ${oneLiner(blocker)}`);

  const findings: Finding[] = [
    ...report.security,
    ...report.breakingChanges,
    ...report.integrationImpact,
  ].filter((f) => f.severity !== 'info');
  findings.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  for (const f of findings) add(`[${SEVERITY_LABEL[f.severity]}] ${oneLiner(f.title)}`);

  return lines;
}

/** Plain-text message for chat apps (Slack, WhatsApp, Teams…): header, bullets, PR link. */
export function riskShareText(detail: PullRequestDetail, lines: string[]): string {
  const pr = detail.pullRequest;
  const header = `PR #${pr.number}: ${pr.title} (${detail.repository.fullName})\nRisks found:`;
  const body = lines.length
    ? lines.map((l) => `• ${l}`).join('\n')
    : '• No risks above "low" were found by the automated analysis.';
  return `${header}\n${body}\n\n${pr.htmlUrl}`;
}
