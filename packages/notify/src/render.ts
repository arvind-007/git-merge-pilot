import type { Severity } from '@gmp/core';
import { DateTime } from 'luxon';
import { escapeHtml, escapeSlack, htmlLink, oneLine, safeHttpUrl, slackLink } from './escape.ts';
import { normalizeTimezone } from './quiet-hours.ts';
import type {
  DigestData,
  DigestFinding,
  DigestFormat,
  DigestOverlap,
  DigestPr,
  DigestPrRef,
  DigestTotals,
  EmailMessage,
  ProjectDigest,
  SlackMessage,
} from './types.ts';

// ---------------------------------------------------------------------------
// Shared styling (inline styles only: many mail clients strip <style>)
// ---------------------------------------------------------------------------

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SEVERITY_COLORS: Record<Severity, string> = {
  critical: '#b42318',
  high: '#c4320a',
  medium: '#b54708',
  low: '#175cd3',
  info: '#475467',
};

function badge(text: string, color: string): string {
  return `<span style="display:inline-block;padding:1px 6px;border-radius:4px;background:${color};color:#ffffff;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.02em">${escapeHtml(text)}</span>`;
}

function riskColor(level: string | null): string {
  switch (level) {
    case 'critical':
      return SEVERITY_COLORS.critical;
    case 'high':
      return SEVERITY_COLORS.high;
    case 'medium':
      return SEVERITY_COLORS.medium;
    default:
      return SEVERITY_COLORS.low;
  }
}

function fmtDate(d: Date, zone: string, withTime = true): string {
  const dt = DateTime.fromJSDate(d, { zone: normalizeTimezone(zone) });
  return withTime ? dt.toFormat('d LLL yyyy, HH:mm ZZZZ') : dt.toFormat('d LLL yyyy');
}

function humanize(s: string): string {
  return s.replace(/_/g, ' ');
}

function prLabel(pr: { repo: string; number: number; title: string }): string {
  return `${pr.repo}#${pr.number} ${oneLine(pr.title, 160)}`;
}

function prLink(pr: { url: string; appUrl?: string }): string {
  return pr.appUrl ?? pr.url;
}

// ---------------------------------------------------------------------------
// Single notification rendering (used by flushPending)
// ---------------------------------------------------------------------------

export interface RenderableNotification {
  kind: string;
  severity: Severity;
  title: string;
  body: string;
  url: string | null;
  projectName?: string | null;
}

/** Plain-text + HTML email for one notification. All content is escaped. */
export function renderNotificationEmail(
  n: RenderableNotification,
  to: string | string[],
): EmailMessage {
  const subject = `[git-merge-pilot] ${n.severity === 'info' ? '' : `${n.severity.toUpperCase()}: `}${oneLine(n.title, 200)}`;
  const url = safeHttpUrl(n.url);
  const textParts = [oneLine(n.title, 500), '', n.body.trim()];
  if (url) textParts.push('', `Open: ${url}`);
  textParts.push(
    '',
    `-- git-merge-pilot (${humanize(n.kind)}${n.projectName ? `, project ${oneLine(n.projectName, 80)}` : ''})`,
  );

  const color = SEVERITY_COLORS[n.severity];
  const bodyHtml = escapeHtml(n.body.trim()).replace(/\r?\n/g, '<br>');
  const html = [
    `<!doctype html><html><body style="margin:0;padding:0;background:#f5f6f8">`,
    `<div style="max-width:640px;margin:0 auto;padding:24px;font-family:${FONT};color:#101828;font-size:14px;line-height:1.5">`,
    `<div style="background:#ffffff;border:1px solid #e4e7ec;border-top:4px solid ${color};border-radius:8px;padding:20px">`,
    `<div style="margin-bottom:8px">${badge(n.severity, color)} <span style="color:#667085;font-size:12px">${escapeHtml(humanize(n.kind))}${n.projectName ? ` &middot; ${escapeHtml(oneLine(n.projectName, 80))}` : ''}</span></div>`,
    `<h1 style="font-size:18px;margin:0 0 12px 0;color:#101828">${escapeHtml(oneLine(n.title, 500))}</h1>`,
    `<div style="color:#344054">${bodyHtml}</div>`,
    url
      ? `<p style="margin:20px 0 0 0">${htmlLink(url, 'Open in git-merge-pilot', 'display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;padding:8px 14px;border-radius:6px;font-weight:600')}</p>`
      : '',
    `</div>`,
    `<p style="color:#98a2b3;font-size:12px;margin:12px 0 0 0">Sent by git-merge-pilot. Adjust notification rules in Settings &rarr; Notifications.</p>`,
    `</div></body></html>`,
  ].join('');
  return { to, subject, text: textParts.join('\n'), html };
}

/** Slack message for one notification. */
export function renderNotificationSlack(n: RenderableNotification): SlackMessage {
  const msg: SlackMessage = {
    title: n.title,
    severity: n.severity,
    text: n.body,
    url: safeHttpUrl(n.url),
    context: `${humanize(n.kind)}${n.projectName ? ` · ${n.projectName}` : ''}`,
  };
  return msg;
}

// ---------------------------------------------------------------------------
// Digest rendering
// ---------------------------------------------------------------------------

type SectionKey = keyof DigestTotals;

const SECTIONS: ReadonlyArray<{ key: SectionKey; title: string }> = [
  { key: 'highRiskPrs', title: 'High-risk PRs' },
  { key: 'securityFindings', title: 'New security findings' },
  { key: 'overlaps', title: 'Overlapping work' },
  { key: 'awaitingReview', title: 'Awaiting review' },
  { key: 'newPrs', title: 'New PRs' },
  { key: 'mergedPrs', title: 'Merged' },
];

function sectionCount(p: ProjectDigest, key: SectionKey): { shown: number; total: number } {
  const shown = p[key].length;
  return { shown, total: Math.max(shown, p.counts?.[key] ?? shown) };
}

function moreText(c: { shown: number; total: number }): string | null {
  return c.total > c.shown ? `\u2026and ${c.total - c.shown} more` : null;
}

type PrSectionKey = Exclude<SectionKey, 'securityFindings' | 'overlaps'>;

function prItems(p: ProjectDigest, key: SectionKey): DigestPr[] {
  if (key === 'securityFindings' || key === 'overlaps') return [];
  return p[key as PrSectionKey];
}

function projectIsEmpty(p: ProjectDigest): boolean {
  return SECTIONS.every((s) => p[s.key].length === 0);
}

/** True when the digest has nothing to report. */
export function digestIsEmpty(data: DigestData): boolean {
  return data.projects.every(projectIsEmpty);
}

function ageText(from: Date | null, until: Date): string {
  if (!from) return '';
  const hours = Math.max(0, Math.floor((until.getTime() - from.getTime()) / 3_600_000));
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function prMeta(pr: DigestPr, key: SectionKey, until: Date): string[] {
  const meta: string[] = [];
  if (pr.author) meta.push(`by ${pr.author}`);
  if (key === 'highRiskPrs' && pr.risk) meta.push(`${pr.risk} risk`);
  if (key === 'highRiskPrs' && pr.recommendation) meta.push(humanize(pr.recommendation));
  if (key === 'awaitingReview') {
    const age = ageText(pr.openedAt, until);
    if (age) meta.push(`open ${age}`);
  }
  if (key === 'newPrs' && pr.draft) meta.push('draft');
  if (key === 'newPrs' && pr.risk) meta.push(`${pr.risk} risk`);
  return meta;
}

function refLabel(r: DigestPrRef): string {
  return r.hidden ? 'a PR in another repository' : `${r.repo}#${r.number}`;
}

function totalsLine(data: DigestData): string {
  const t = data.totals;
  return [
    `${t.highRiskPrs} high-risk`,
    `${t.securityFindings} new security finding${t.securityFindings === 1 ? '' : 's'}`,
    `${t.overlaps} overlap${t.overlaps === 1 ? '' : 's'}`,
    `${t.awaitingReview} awaiting review`,
    `${t.newPrs} new`,
    `${t.mergedPrs} merged`,
  ].join(' · ');
}

// ---- text ----

function renderText(data: DigestData): string {
  const zone = data.timezone;
  const lines: string[] = [];
  lines.push(`git-merge-pilot daily digest — ${oneLine(data.orgName, 120)}`);
  lines.push(`${fmtDate(data.since, zone)} → ${fmtDate(data.until, zone)}`);
  lines.push(totalsLine(data));
  if (digestIsEmpty(data)) {
    lines.push('', 'No pull request activity in this period.');
    return lines.join('\n');
  }
  for (const p of data.projects) {
    if (projectIsEmpty(p)) continue;
    lines.push('', `== ${oneLine(p.projectName, 120)} ==`);
    for (const s of SECTIONS) {
      const c = sectionCount(p, s.key);
      if (!c.shown) continue;
      lines.push('', `${s.title} (${c.total})`);
      if (s.key === 'securityFindings') {
        for (const f of p.securityFindings) {
          lines.push(
            `- [${f.severity.toUpperCase()}] ${oneLine(f.title, 200)}${f.verified ? '' : ' (potential concern)'} — ${f.repo}#${f.prNumber} ${f.appUrl ?? f.prUrl}`,
          );
        }
      } else if (s.key === 'overlaps') {
        for (const o of p.overlaps) {
          lines.push(
            `- ${refLabel(o.prA)} ↔ ${refLabel(o.prB)}: ${humanize(o.type)} (${o.confidence}) — ${oneLine(o.summary, 240)}`,
          );
        }
      } else {
        for (const pr of prItems(p, s.key)) {
          const meta = prMeta(pr, s.key, data.until);
          lines.push(`- ${prLabel(pr)}${meta.length ? ` (${meta.join(', ')})` : ''} ${prLink(pr)}`);
        }
      }
      const more = moreText(c);
      if (more) lines.push(`  ${more}`);
    }
  }
  return lines.join('\n');
}

// ---- slack mrkdwn ----

function renderSlack(data: DigestData): string {
  const zone = data.timezone;
  const lines: string[] = [];
  lines.push(`*git-merge-pilot daily digest — ${escapeSlack(oneLine(data.orgName, 120))}*`);
  lines.push(
    `_${escapeSlack(fmtDate(data.since, zone))} → ${escapeSlack(fmtDate(data.until, zone))}_`,
  );
  lines.push(escapeSlack(totalsLine(data)));
  if (digestIsEmpty(data)) {
    lines.push('', 'No pull request activity in this period.');
    return lines.join('\n');
  }
  for (const p of data.projects) {
    if (projectIsEmpty(p)) continue;
    lines.push('', `*:file_folder: ${escapeSlack(oneLine(p.projectName, 120))}*`);
    for (const s of SECTIONS) {
      const c = sectionCount(p, s.key);
      if (!c.shown) continue;
      lines.push(`*${s.title}* (${c.total})`);
      if (s.key === 'securityFindings') {
        for (const f of p.securityFindings) {
          lines.push(
            `• \`${f.severity.toUpperCase()}\` ${escapeSlack(oneLine(f.title, 200))}${f.verified ? '' : ' _(potential concern)_'} — ${slackLink(f.appUrl ?? f.prUrl, `${f.repo}#${f.prNumber}`)}`,
          );
        }
      } else if (s.key === 'overlaps') {
        for (const o of p.overlaps) {
          lines.push(
            `• ${slackLink(prLink(o.prA), refLabel(o.prA))} ↔ ${slackLink(prLink(o.prB), refLabel(o.prB))}: ${escapeSlack(humanize(o.type))} (${o.confidence}) — ${escapeSlack(oneLine(o.summary, 240))}`,
          );
        }
      } else {
        for (const pr of prItems(p, s.key)) {
          const meta = prMeta(pr, s.key, data.until);
          lines.push(
            `• ${slackLink(prLink(pr), prLabel(pr))}${meta.length ? ` _(${escapeSlack(meta.join(', '))})_` : ''}`,
          );
        }
      }
      const more = moreText(c);
      if (more) lines.push(`_${more}_`);
    }
  }
  return lines.join('\n');
}

// ---- email html ----

const CELL = 'padding:6px 0;border-bottom:1px solid #f2f4f7;vertical-align:top';
const LINK_STYLE = 'color:#1d4ed8;text-decoration:none';

function htmlPrRow(pr: DigestPr, key: SectionKey, until: Date): string {
  const meta = prMeta(pr, key, until);
  const risk = key === 'highRiskPrs' && pr.risk ? `${badge(pr.risk, riskColor(pr.risk))} ` : '';
  return `<tr><td style="${CELL}">${risk}${htmlLink(prLink(pr), `${pr.repo}#${pr.number}`, LINK_STYLE)} ${escapeHtml(oneLine(pr.title, 160))}${meta.length ? `<br><span style="color:#667085;font-size:12px">${escapeHtml(meta.join(' · '))}</span>` : ''}</td></tr>`;
}

function htmlFindingRow(f: DigestFinding): string {
  return `<tr><td style="${CELL}">${badge(f.severity, SEVERITY_COLORS[f.severity])} ${escapeHtml(oneLine(f.title, 200))}${f.verified ? '' : ' <em style="color:#667085">(potential concern)</em>'}<br><span style="color:#667085;font-size:12px">${htmlLink(f.appUrl ?? f.prUrl, `${f.repo}#${f.prNumber}`, LINK_STYLE)} ${escapeHtml(oneLine(f.prTitle, 120))}</span></td></tr>`;
}

function htmlOverlapRow(o: DigestOverlap): string {
  return `<tr><td style="${CELL}">${htmlLink(prLink(o.prA), refLabel(o.prA), LINK_STYLE)} &harr; ${htmlLink(prLink(o.prB), refLabel(o.prB), LINK_STYLE)} <span style="color:#667085;font-size:12px">${escapeHtml(humanize(o.type))} &middot; ${escapeHtml(o.confidence)}</span><br><span style="color:#344054">${escapeHtml(oneLine(o.summary, 240))}</span></td></tr>`;
}

function renderEmailHtml(data: DigestData): string {
  const zone = data.timezone;
  const out: string[] = [];
  out.push(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>git-merge-pilot daily digest</title></head>`,
    `<body style="margin:0;padding:0;background:#f5f6f8">`,
    `<div style="max-width:680px;margin:0 auto;padding:24px 16px;font-family:${FONT};color:#101828;font-size:14px;line-height:1.5">`,
    `<h1 style="font-size:20px;margin:0 0 4px 0">git-merge-pilot daily digest</h1>`,
    `<p style="margin:0 0 4px 0;color:#344054">${escapeHtml(oneLine(data.orgName, 120))}</p>`,
    `<p style="margin:0 0 16px 0;color:#667085;font-size:12px">${escapeHtml(fmtDate(data.since, zone))} &rarr; ${escapeHtml(fmtDate(data.until, zone))}</p>`,
    `<p style="margin:0 0 16px 0;padding:10px 12px;background:#ffffff;border:1px solid #e4e7ec;border-radius:8px;color:#344054">${escapeHtml(totalsLine(data))}</p>`,
  );
  if (digestIsEmpty(data)) {
    out.push(`<p style="color:#667085">No pull request activity in this period.</p>`);
  }
  for (const p of data.projects) {
    if (projectIsEmpty(p)) continue;
    out.push(
      `<div style="background:#ffffff;border:1px solid #e4e7ec;border-radius:8px;padding:16px 20px;margin:0 0 16px 0">`,
      `<h2 style="font-size:16px;margin:0 0 8px 0;color:#101828">${escapeHtml(oneLine(p.projectName, 120))}</h2>`,
    );
    for (const s of SECTIONS) {
      const c = sectionCount(p, s.key);
      if (!c.shown) continue;
      out.push(
        `<h3 style="font-size:13px;margin:14px 0 4px 0;color:#475467;text-transform:uppercase;letter-spacing:0.03em">${escapeHtml(s.title)} (${c.total})</h3>`,
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse">`,
      );
      if (s.key === 'securityFindings') out.push(...p.securityFindings.map(htmlFindingRow));
      else if (s.key === 'overlaps') out.push(...p.overlaps.map(htmlOverlapRow));
      else out.push(...prItems(p, s.key).map((pr) => htmlPrRow(pr, s.key, data.until)));
      out.push(`</table>`);
      const more = moreText(c);
      if (more)
        out.push(
          `<p style="margin:4px 0 0 0;color:#667085;font-size:12px">${escapeHtml(more)}</p>`,
        );
    }
    out.push(`</div>`);
  }
  out.push(
    `<p style="color:#98a2b3;font-size:12px;margin:8px 0 0 0">Potential concerns are AI or heuristic inferences; verified facts come from deterministic analysis and GitHub data. Sent by git-merge-pilot.</p>`,
    `</div></body></html>`,
  );
  return out.join('');
}

/** Renders a digest as email HTML (escaped, inline styles), plain text, or Slack mrkdwn. */
export function renderDigest(data: DigestData, format: DigestFormat): string {
  switch (format) {
    case 'email_html':
      return renderEmailHtml(data);
    case 'text':
      return renderText(data);
    case 'slack':
      return renderSlack(data);
  }
}

/** Subject/title line for a digest notification. */
export function digestTitle(data: DigestData): string {
  const t = data.totals;
  const highlights: string[] = [];
  if (t.highRiskPrs) highlights.push(`${t.highRiskPrs} high-risk`);
  if (t.securityFindings) highlights.push(`${t.securityFindings} security`);
  if (t.overlaps) highlights.push(`${t.overlaps} overlap${t.overlaps === 1 ? '' : 's'}`);
  const date = DateTime.fromJSDate(data.until, { zone: normalizeTimezone(data.timezone) }).toFormat(
    'd LLL yyyy',
  );
  return `Daily digest ${date}${highlights.length ? ` — ${highlights.join(', ')}` : ''}`;
}
