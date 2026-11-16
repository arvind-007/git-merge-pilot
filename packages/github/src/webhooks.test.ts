import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  normalizeWebhook,
  parseClosingReferences,
  signWebhookPayload,
  verifyWebhookSignature,
} from './webhooks.ts';
import type { NormalizedEvent } from './webhooks.ts';

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./__fixtures__/webhooks/${name}.json`, import.meta.url), 'utf8'),
  );
}

function norm(event: string, name: string): NormalizedEvent {
  const ev = normalizeWebhook(event, fixture(name), { now: new Date('2026-11-14T00:00:00Z') });
  if (!ev) throw new Error(`expected ${name} to normalize`);
  return ev;
}

describe('verifyWebhookSignature', () => {
  const secret = 'whsec-test-value';
  const body = JSON.stringify({ action: 'opened', number: 1 });
  const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  it('accepts a valid signature for string and Buffer bodies', () => {
    expect(verifyWebhookSignature(secret, body, sig)).toBe(true);
    expect(verifyWebhookSignature(secret, Buffer.from(body), sig)).toBe(true);
    expect(
      verifyWebhookSignature(secret, body, sig.toUpperCase().replace('SHA256=', 'sha256=')),
    ).toBe(true);
    expect(verifyWebhookSignature(secret, body, [sig])).toBe(true);
  });

  it('matches signWebhookPayload', () => {
    expect(signWebhookPayload(secret, body)).toBe(sig);
  });

  it('rejects wrong secret, tampered body, and malformed headers', () => {
    expect(verifyWebhookSignature('other', body, sig)).toBe(false);
    expect(verifyWebhookSignature(secret, `${body} `, sig)).toBe(false);
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(secret, body, null)).toBe(false);
    expect(verifyWebhookSignature(secret, body, '')).toBe(false);
    expect(verifyWebhookSignature(secret, body, sig.replace('sha256=', 'sha1='))).toBe(false);
    expect(verifyWebhookSignature(secret, body, sig.slice(0, -2))).toBe(false);
    expect(verifyWebhookSignature(secret, body, `${sig}00`)).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'sha256=zz' + sig.slice(9))).toBe(false);
    expect(verifyWebhookSignature('', body, sig)).toBe(false);
  });
});

describe('parseClosingReferences', () => {
  it('parses same-repo, cross-repo and URL references, ignoring comments/code', () => {
    const refs = parseClosingReferences(
      'Fixes #12, resolves org-a/repo.b#7\ncloses https://github.com/x/y/issues/9\n' +
        'Fixed: #12\nrelated to #44\n```\ncloses #100\n```\n<!-- fixes #101 -->',
    );
    expect(refs).toEqual([
      { number: 12, closing: true },
      { number: 7, repo: 'org-a/repo.b', closing: true },
      { number: 9, repo: 'x/y', closing: true },
    ]);
  });

  it('handles empty input', () => {
    expect(parseClosingReferences(null)).toEqual([]);
    expect(parseClosingReferences('')).toEqual([]);
  });
});

describe('normalizeWebhook: pull_request', () => {
  it('opened', () => {
    const ev = norm('pull_request', 'pull_request.opened');
    expect(ev.type).toBe('pr_opened');
    if (ev.type !== 'pr_opened') return;
    expect(ev.installationId).toBe(424242);
    expect(ev.repository).toMatchObject({
      githubId: 555001,
      owner: 'acme-org',
      name: 'widgets',
      fullName: 'acme-org/widgets',
      private: true,
      defaultBranch: 'main',
    });
    expect(ev.senderLogin).toBe('dev-alice');
    expect(ev.pullRequestNumbers).toEqual([17]);
    expect(ev.occurredAt).toBe('2026-11-14T09:30:00.000Z');
    expect(ev.pullRequest).toMatchObject({
      githubId: 880017,
      number: 17,
      state: 'open',
      draft: false,
      authorLogin: 'dev-alice',
      assignees: ['dev-alice', 'dev-bob'],
      requestedReviewers: ['dev-carol', 'team:backend'],
      labels: ['enhancement', 'api'],
      baseRef: 'main',
      headRef: 'feature/pagination',
      headSha: '1111111111111111111111111111111111111111',
      baseSha: '0000000000000000000000000000000000000000',
      additions: 120,
      deletions: 15,
      changedFiles: 6,
      mergeableState: 'clean',
      headRepoFullName: 'acme-org/widgets',
      openedAt: '2026-11-13T08:00:00.000Z',
    });
    expect(ev.pullRequest.linkedIssues).toEqual([
      { number: 12, closing: true },
      { number: 3, repo: 'acme-org/platform', closing: true },
    ]);
  });

  it('synchronize carries before/after shas', () => {
    const ev = norm('pull_request', 'pull_request.synchronize');
    expect(ev.type).toBe('pr_synchronized');
    if (ev.type !== 'pr_synchronized') return;
    expect(ev.beforeSha).toBe('1111111111111111111111111111111111111111');
    expect(ev.afterSha).toBe('2222222222222222222222222222222222222222');
    expect(ev.pullRequest.headSha).toBe('2222222222222222222222222222222222222222');
  });

  it('closed + merged → pr_merged, closed unmerged → pr_closed', () => {
    const merged = norm('pull_request', 'pull_request.closed.merged');
    expect(merged.type).toBe('pr_merged');
    if (merged.type === 'pr_merged') {
      expect(merged.pullRequest.state).toBe('merged');
      expect(merged.pullRequest.mergedAt).toBe('2026-11-14T12:00:00.000Z');
      expect(merged.occurredAt).toBe('2026-11-14T12:00:00.000Z');
    }
    const closed = norm('pull_request', 'pull_request.closed.unmerged');
    expect(closed.type).toBe('pr_closed');
    if (closed.type === 'pr_closed') expect(closed.pullRequest.state).toBe('closed');
  });

  it('edited lists changed fields; reopened; metadata actions → pr_updated', () => {
    const edited = norm('pull_request', 'pull_request.edited');
    expect(edited.type).toBe('pr_edited');
    if (edited.type === 'pr_edited') expect(edited.changedFields).toEqual(['title', 'body']);
    expect(norm('pull_request', 'pull_request.reopened').type).toBe('pr_reopened');
    expect(norm('pull_request', 'pull_request.labeled').type).toBe('pr_updated');
    const p = fixture('pull_request.labeled') as Record<string, unknown>;
    for (const action of [
      'ready_for_review',
      'converted_to_draft',
      'review_requested',
      'assigned',
    ]) {
      expect(normalizeWebhook('pull_request', { ...p, action })?.type).toBe('pr_updated');
    }
  });
});

describe('normalizeWebhook: reviews and comments', () => {
  it('review submitted (state upper-cased) and dismissed', () => {
    const ev = norm('pull_request_review', 'pull_request_review.submitted');
    expect(ev.type).toBe('review_submitted');
    if (ev.type !== 'review_submitted') return;
    expect(ev.review).toMatchObject({
      githubId: 990001,
      reviewerLogin: 'dev-carol',
      state: 'APPROVED',
      submittedAt: '2026-11-14T10:00:00.000Z',
    });
    expect(ev.pullRequest.number).toBe(17);
    // review payloads carry a PR without size stats
    expect(ev.pullRequest.additions).toBeNull();
    const dismissed = norm('pull_request_review', 'pull_request_review.dismissed');
    expect(dismissed.type === 'review_submitted' && dismissed.review.state).toBe('DISMISSED');
  });

  it('review comment', () => {
    const ev = norm('pull_request_review_comment', 'pull_request_review_comment.created');
    expect(ev.type).toBe('review_comment');
    if (ev.type !== 'review_comment') return;
    expect(ev.comment).toMatchObject({
      githubId: 770001,
      path: 'src/api/widgets.ts',
      line: 42,
      authorLogin: 'dev-carol',
    });
    expect(ev.pullRequestNumbers).toEqual([17]);
  });

  it('issue_comment on a PR is kept; on a plain issue is ignored', () => {
    const ev = norm('issue_comment', 'issue_comment.created.pr');
    expect(ev.type).toBe('issue_comment');
    if (ev.type === 'issue_comment') {
      expect(ev.pullRequestNumber).toBe(17);
      expect(ev.comment.body).toBe('Depends on #15');
    }
    expect(normalizeWebhook('issue_comment', fixture('issue_comment.created.issue'))).toBeNull();
  });
});

describe('normalizeWebhook: checks and statuses', () => {
  it('check_run keeps only PRs whose base is this repository', () => {
    const ev = norm('check_run', 'check_run.completed');
    expect(ev.type).toBe('check_updated');
    if (ev.type !== 'check_updated') return;
    expect(ev.pullRequestNumbers).toEqual([17]);
    expect(ev.check).toMatchObject({
      kind: 'check_run',
      name: 'ci / test',
      status: 'completed',
      conclusion: 'failure',
      headSha: '1111111111111111111111111111111111111111',
      url: 'https://github.com/acme-org/widgets/runs/330001',
      appSlug: 'github-actions',
      completedAt: '2026-11-14T09:45:00.000Z',
    });
  });

  it('check_suite', () => {
    const ev = norm('check_suite', 'check_suite.completed');
    expect(ev.type).toBe('check_updated');
    if (ev.type !== 'check_updated') return;
    expect(ev.check.kind).toBe('check_suite');
    expect(ev.check.name).toBe('GitHub Actions');
    expect(ev.check.conclusion).toBe('success');
    expect(ev.pullRequestNumbers).toEqual([17]);
  });

  it('status has no PR numbers (lookup by sha) and lists branches', () => {
    const ev = norm('status', 'status');
    expect(ev.type).toBe('status_updated');
    if (ev.type !== 'status_updated') return;
    expect(ev.pullRequestNumbers).toEqual([]);
    expect(ev.status).toEqual({
      sha: '1111111111111111111111111111111111111111',
      context: 'ci/legacy',
      state: 'success',
      description: 'Build passed',
      targetUrl: 'https://ci.example/build/1',
      branches: ['feature/pagination'],
    });
  });
});

describe('normalizeWebhook: push', () => {
  it('default-branch push with changed paths', () => {
    const ev = norm('push', 'push.default_branch');
    expect(ev.type).toBe('push');
    if (ev.type !== 'push') return;
    expect(ev.push).toMatchObject({
      ref: 'refs/heads/main',
      branch: 'main',
      isDefaultBranch: true,
      commitCount: 2,
      headCommitSha: '3333333333333333333333333333333333333333',
      forced: false,
    });
    expect(ev.push.changedPaths).toEqual(['src/new.ts', 'package.json', 'README.md', 'old.txt']);
    expect(ev.occurredAt).toBe('2026-11-14T12:00:00.000Z');
  });

  it('tag pushes are ignored', () => {
    expect(normalizeWebhook('push', fixture('push.tag'))).toBeNull();
  });
});

describe('normalizeWebhook: installation & repository', () => {
  it('installation created lists repositories', () => {
    const ev = norm('installation', 'installation.created');
    expect(ev.type).toBe('installation_changed');
    if (ev.type !== 'installation_changed') return;
    expect(ev.action).toBe('created');
    expect(ev.installationId).toBe(424242);
    expect(ev.repository).toBeNull();
    expect(ev.installation).toMatchObject({
      installationId: 424242,
      appId: 12345,
      accountLogin: 'acme-org',
      accountType: 'Organization',
      repositorySelection: 'selected',
      suspendedAt: null,
    });
    expect(ev.installation.permissions).toEqual({
      metadata: 'read',
      contents: 'read',
      pull_requests: 'read',
    });
    expect(ev.repositories.map((r) => r.fullName)).toEqual([
      'acme-org/widgets',
      'acme-org/gadgets',
    ]);
    expect(ev.repositories[0]).toEqual({
      githubId: 555001,
      fullName: 'acme-org/widgets',
      owner: 'acme-org',
      name: 'widgets',
      private: true,
    });
  });

  it('installation suspend/deleted', () => {
    const s = norm('installation', 'installation.suspend');
    expect(s.type === 'installation_changed' && s.installation.suspendedAt).toBe(
      '2026-11-14T14:00:00.000Z',
    );
    expect(norm('installation', 'installation.deleted').action).toBe('deleted');
  });

  it('installation_repositories added/removed', () => {
    const added = norm('installation_repositories', 'installation_repositories.added');
    expect(added.type).toBe('installation_repos_changed');
    if (added.type !== 'installation_repos_changed') return;
    expect(added.repositoriesAdded.map((r) => r.fullName)).toEqual(['acme-org/sprockets']);
    expect(added.repositoriesRemoved).toEqual([]);
    expect(added.repositorySelection).toBe('selected');
    const removed = norm('installation_repositories', 'installation_repositories.removed');
    expect(
      removed.type === 'installation_repos_changed' && removed.repositoriesRemoved[0]?.githubId,
    ).toBe(555002);
  });

  it('repository renamed / archived', () => {
    const ev = norm('repository', 'repository.renamed');
    expect(ev.type).toBe('repository_changed');
    if (ev.type !== 'repository_changed') return;
    expect(ev.repository.fullName).toBe('acme-org/widgets-v2');
    expect(ev.changes).toEqual({ repository: { name: { from: 'widgets' } } });
    const archived = norm('repository', 'repository.archived');
    expect(archived.repository?.archived).toBe(true);
  });
});

describe('normalizeWebhook: irrelevant or malformed input', () => {
  it('returns null for ping, unknown events and garbage', () => {
    expect(normalizeWebhook('ping', fixture('ping'))).toBeNull();
    expect(normalizeWebhook('star', { action: 'created' })).toBeNull();
    expect(normalizeWebhook('pull_request', null)).toBeNull();
    expect(normalizeWebhook('pull_request', 'string')).toBeNull();
    expect(normalizeWebhook('pull_request', [])).toBeNull();
    expect(normalizeWebhook('pull_request', { action: 'opened' })).toBeNull();
    expect(
      normalizeWebhook('pull_request', { action: 'opened', pull_request: { number: 'x' } }),
    ).toBeNull();
    expect(normalizeWebhook('check_run', { action: 'completed', check_run: {} })).toBeNull();
    expect(
      normalizeWebhook('installation', { action: 'weird', installation: { id: 1 } }),
    ).toBeNull();
    expect(
      normalizeWebhook('pull_request_review', {
        ...(fixture('pull_request_review.submitted') as object),
        action: 'deleted',
      }),
    ).toBeNull();
  });

  it('falls back to `now` when timestamps are missing', () => {
    const payload = fixture('status') as Record<string, unknown>;
    delete payload.updated_at;
    delete payload.created_at;
    const ev = normalizeWebhook('status', payload, { now: new Date('2026-01-02T03:04:05Z') });
    expect(ev?.occurredAt).toBe('2026-01-02T03:04:05.000Z');
  });
});
