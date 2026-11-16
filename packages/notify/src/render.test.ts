import { describe, expect, it } from 'vitest';
import { escapeHtml, escapeSlack, htmlLink, safeHttpUrl, slackLink } from './escape.ts';
import { digestIsEmpty, digestTitle, renderDigest, renderNotificationEmail } from './render.ts';
import type { DigestData, DigestPr, ProjectDigest } from './types.ts';

const since = new Date('2026-11-13T09:00:00Z');
const until = new Date('2026-11-14T09:00:00Z');

function pr(over: Partial<DigestPr> = {}): DigestPr {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    repo: 'acme/api',
    number: 42,
    title: 'Add billing endpoint',
    url: 'https://github.com/acme/api/pull/42',
    author: 'dev1',
    draft: false,
    risk: 'high',
    recommendation: 'merge_after_checks',
    openedAt: new Date('2026-11-13T12:00:00Z'),
    mergedAt: null,
    reviewDecision: 'REVIEW_REQUIRED',
    ...over,
  };
}

function project(over: Partial<ProjectDigest> = {}): ProjectDigest {
  const p: ProjectDigest = {
    projectId: 'p1',
    projectName: 'Payments',
    newPrs: [],
    mergedPrs: [],
    highRiskPrs: [],
    securityFindings: [],
    overlaps: [],
    awaitingReview: [],
    counts: {
      newPrs: 0,
      mergedPrs: 0,
      highRiskPrs: 0,
      securityFindings: 0,
      overlaps: 0,
      awaitingReview: 0,
    },
    ...over,
  };
  for (const k of Object.keys(p.counts) as (keyof ProjectDigest['counts'])[]) {
    p.counts[k] = Math.max(p.counts[k], p[k].length);
  }
  return p;
}

function digest(projects: ProjectDigest[]): DigestData {
  const totals = {
    newPrs: 0,
    mergedPrs: 0,
    highRiskPrs: 0,
    securityFindings: 0,
    overlaps: 0,
    awaitingReview: 0,
  };
  for (const p of projects)
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += p.counts[k];
  return {
    orgId: 'o1',
    orgName: 'Acme & Co',
    timezone: 'Europe/Berlin',
    since,
    until,
    generatedAt: until,
    projects,
    totals,
  };
}

const EVIL = `<script>alert("x")</script> & 'quoted' <!channel> <@U123>`;

describe('escaping helpers', () => {
  it('escapes HTML metacharacters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
  it('escapes Slack control characters', () => {
    expect(escapeSlack('<!channel> & <@U1>')).toBe('&lt;!channel&gt; &amp; &lt;@U1&gt;');
  });
  it('only allows http(s) URLs', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,hi')).toBeNull();
    expect(safeHttpUrl('/relative')).toBeNull();
    expect(safeHttpUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(htmlLink('javascript:alert(1)', '<b>x</b>')).toBe('&lt;b&gt;x&lt;/b&gt;');
    expect(htmlLink('https://e.com/"x', 'ok')).toBe('<a href="https://e.com/%22x">ok</a>');
  });
  it('builds safe Slack links', () => {
    expect(slackLink('https://e.com/a|b>c', 'a|b <x>')).toBe(
      '<https://e.com/a%7Cb%3Ec|a∣b &lt;x&gt;>',
    );
    expect(slackLink('javascript:x', 'label')).toBe('label');
  });
});

describe('renderDigest', () => {
  const data = digest([
    project({
      projectName: `Payments <img src=x onerror=alert(1)>`,
      highRiskPrs: [pr({ title: EVIL, risk: 'critical' })],
      securityFindings: [
        {
          id: 'f1',
          pullRequestId: 'pr1',
          repo: 'acme/api',
          prNumber: 42,
          prTitle: EVIL,
          prUrl: 'javascript:alert(1)',
          severity: 'high',
          title: `SQL injection in "<query>"`,
          verified: false,
          createdAt: until,
        },
      ],
      overlaps: [
        {
          id: 'r1',
          type: 'same_file',
          confidence: 'confirmed',
          summary: 'Both edit <src/billing.ts>',
          prA: {
            id: 'a',
            repo: 'acme/api',
            number: 42,
            title: 't',
            url: 'https://github.com/acme/api/pull/42',
          },
          prB: {
            id: 'b',
            repo: 'acme/web',
            number: 7,
            title: 't',
            url: 'https://github.com/acme/web/pull/7',
          },
        },
      ],
      awaitingReview: [pr({ number: 43, openedAt: new Date('2026-11-10T09:00:00Z') })],
      newPrs: [pr({ number: 44, draft: true })],
      mergedPrs: [pr({ number: 40, mergedAt: new Date('2026-11-13T15:00:00Z') })],
    }),
  ]);

  it('email_html escapes every untrusted string and uses inline styles only', () => {
    const html = renderDigest(data, 'email_html');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<style');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('Payments &lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('Acme &amp; Co');
    expect(html).toContain('SQL injection in &quot;&lt;query&gt;&quot;');
    expect(html).toContain('(potential concern)');
    expect(html).toContain('href="https://github.com/acme/api/pull/42"');
    expect(html).toMatch(/style="[^"]+"/);
    // Section headings with counts.
    for (const h of [
      'High-risk PRs (1)',
      'New security findings (1)',
      'Overlapping work (1)',
      'Awaiting review (1)',
      'New PRs (1)',
      'Merged (1)',
    ]) {
      expect(html).toContain(h);
    }
  });

  it('slack escapes control characters so titles cannot ping or inject links', () => {
    const s = renderDigest(data, 'slack');
    expect(s).not.toContain('<!channel>');
    expect(s).not.toContain('<@U123>');
    expect(s).not.toContain('<script>');
    expect(s).toContain('&lt;!channel&gt;');
    expect(s).toContain('<https://github.com/acme/api/pull/42|acme/api#42');
    expect(s).toContain('Both edit &lt;src/billing.ts&gt;');
    // Non-http PR url is rendered as plain text, not a link.
    expect(s).not.toContain('javascript:');
  });

  it('text format lists sections with links, times in org timezone and age', () => {
    const t = renderDigest(data, 'text');
    expect(t).toContain('git-merge-pilot daily digest — Acme & Co');
    expect(t).toContain('13 Nov 2026, 10:00'); // Europe/Berlin = UTC+1
    expect(t).toContain('High-risk PRs (1)');
    expect(t).toContain('critical risk');
    expect(t).toContain('acme/api#42 ↔ acme/web#7: same file (confirmed)');
    expect(t).toContain('open 4d');
    expect(t).toContain('draft');
    expect(t).toContain('https://github.com/acme/api/pull/42');
  });

  it('prefers app links when present and reports truncated sections', () => {
    const p = project({
      awaitingReview: [pr({ appUrl: 'https://gmp.example.com/pull-requests/x' })],
    });
    p.counts.awaitingReview = 5;
    const d = digest([p]);
    expect(renderDigest(d, 'text')).toContain('https://gmp.example.com/pull-requests/x');
    expect(renderDigest(d, 'text')).toContain('Awaiting review (5)');
    expect(renderDigest(d, 'text')).toContain('…and 4 more');
    expect(renderDigest(d, 'slack')).toContain('and 4 more');
    expect(renderDigest(d, 'email_html')).toContain('and 4 more');
  });

  it('handles an empty digest in every format', () => {
    const d = digest([project()]);
    expect(digestIsEmpty(d)).toBe(true);
    for (const f of ['email_html', 'text', 'slack'] as const) {
      expect(renderDigest(d, f)).toContain('No pull request activity in this period.');
    }
    expect(digestIsEmpty(data)).toBe(false);
  });

  it('builds a digest title with highlights', () => {
    expect(digestTitle(data)).toBe('Daily digest 14 Nov 2026 — 1 high-risk, 1 security, 1 overlap');
  });
});

describe('renderNotificationEmail', () => {
  it('escapes body/title and strips newlines from the subject', () => {
    const m = renderNotificationEmail(
      {
        kind: 'security_finding',
        severity: 'high',
        title: 'Secret in <b>config</b>\nBcc: victim@example.com',
        body: 'line1\n<script>x</script>',
        url: 'https://gmp.example.com/pull-requests/1',
        projectName: 'P&Q',
      },
      'pm@example.com',
    );
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.subject).toBe(
      '[git-merge-pilot] HIGH: Secret in <b>config</b> Bcc: victim@example.com',
    );
    expect(m.html).toContain('line1<br>&lt;script&gt;x&lt;/script&gt;');
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('P&amp;Q');
    expect(m.text).toContain('Open: https://gmp.example.com/pull-requests/1');
  });
  it('drops non-http links', () => {
    const m = renderNotificationEmail(
      { kind: 'high_risk', severity: 'info', title: 't', body: 'b', url: 'javascript:alert(1)' },
      'a@b.co',
    );
    expect(m.html).not.toContain('javascript:');
    expect(m.text).not.toContain('Open:');
    expect(m.subject).toBe('[git-merge-pilot] t');
  });
});
