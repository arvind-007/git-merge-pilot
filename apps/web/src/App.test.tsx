import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from './api/client.ts';
import type { PrReport, PullRequestDetail } from './api/types.ts';
import { App } from './App.tsx';
import { NO_SECURITY_ISSUES_TEXT } from './pages/PullRequestPage.tsx';
import { mockFetch, renderWithProviders } from './test/utils.tsx';

const me = {
  user: { id: 'u1', email: 'admin@example.com', name: 'Ada Admin', role: 'admin', timezone: 'UTC' },
  org: { id: 'o1', name: 'Example Org', timezone: 'UTC' },
  csrfToken: 'csrf',
};

const report: PrReport = {
  executiveSummary: 'Adds a retry to the payment webhook handler.',
  businessImpact: 'Fewer failed payments.',
  technicalSummary: 'Wraps handler in retry.',
  affectedAreas: {
    modules: ['payments'],
    services: [],
    apis: [],
    databaseTables: [],
    sharedComponents: [],
    integrations: [],
    configuration: [],
    infrastructure: [],
  },
  breakingChanges: [],
  security: [],
  integrationImpact: [],
  overlappingWork: [],
  testing: { testsAdded: [], testsModified: [], missingTests: [], ciSummary: 'All checks passed.' },
  deployment: { migrations: [], envChanges: [], configChanges: [], ordering: [], notes: '' },
  rollback: { difficulty: 'easy', notes: 'Revert.' },
  recommendedActions: [],
  riskScores: [
    {
      dimension: 'security',
      score: 10,
      level: 'low',
      rationale: 'No sensitive code touched.',
      evidence: [],
    },
    {
      dimension: 'breaking_change',
      score: 0,
      level: 'low',
      rationale: 'No exports changed.',
      evidence: [],
    },
    {
      dimension: 'integration',
      score: 20,
      level: 'low',
      rationale: 'Internal only.',
      evidence: [],
    },
    {
      dimension: 'regression',
      score: 35,
      level: 'medium',
      rationale: 'Touches retry logic.',
      evidence: [],
    },
    { dimension: 'database', score: 0, level: 'low', rationale: 'No DB changes.', evidence: [] },
    {
      dimension: 'deployment',
      score: 5,
      level: 'low',
      rationale: 'Standard deploy.',
      evidence: [],
    },
  ],
  overallRisk: 'medium',
  mergeReadiness: {
    recommendation: 'ready_to_merge',
    blockers: [],
    checks: [],
    rationale: 'Checks pass and approved.',
  },
  confidence: { score: 80, rationale: 'Small diff.' },
  generatedBy: 'deterministic',
  limitations: ['AI disabled for this repo'],
};

const prDetail: PullRequestDetail = {
  pullRequest: {
    id: 'pr1',
    repositoryId: 'r1',
    githubId: 1,
    number: 42,
    title: 'Retry payment webhooks',
    body: null,
    state: 'open',
    draft: false,
    authorLogin: 'dev1',
    assignees: [],
    requestedReviewers: [],
    labels: [],
    baseRef: 'main',
    headRef: 'retry',
    headSha: 'abc1234def',
    baseSha: null,
    mergeableState: 'clean',
    reviewDecision: 'APPROVED',
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    htmlUrl: 'https://github.com/acme/api/pull/42',
    openedAt: null,
    closedAt: null,
    mergedAt: null,
    lastEventAt: null,
    linkedIssues: [],
  },
  repository: {
    id: 'r1',
    fullName: 'acme/api',
    owner: 'acme',
    name: 'api',
    aiMode: 'off',
    defaultBranch: 'main',
  },
  analysis: {
    id: 'a1',
    pullRequestId: 'pr1',
    headSha: 'abc1234def',
    baseSha: null,
    previousAnalysisId: null,
    kind: 'full',
    status: 'completed',
    report,
    overallRisk: 'medium',
    recommendation: 'ready_to_merge',
    confidence: 80,
    generatedBy: 'deterministic',
    aiUsage: null,
    error: null,
    startedAt: null,
    completedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  },
  findings: [],
  relationships: [],
  checks: [],
  reviews: [],
};

describe('routing & auth guard', () => {
  beforeEach(() => setCsrfToken(null));
  afterEach(() => vi.unstubAllGlobals());

  it('sends a fresh install to the setup wizard', async () => {
    mockFetch({
      'GET /api/setup/status': { body: { completed: false, adminCreated: false, step: 1 } },
      'GET /api/auth/me': { status: 401, body: { message: 'unauthenticated' } },
    });
    renderWithProviders(<App />, { route: '/' });
    expect(
      await screen.findByRole('heading', { name: /create your admin account/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/setup token/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/organization name/i)).not.toBeInTheDocument();
    const tz = screen.getByLabelText(/time zone/i) as HTMLSelectElement;
    expect(tz.value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  });

  it('hides the setup token field when the setup link carries the token', async () => {
    mockFetch({
      'GET /api/setup/status': { body: { completed: false, adminCreated: false, step: 1 } },
      'GET /api/auth/me': { status: 401, body: { message: 'unauthenticated' } },
    });
    renderWithProviders(<App />, { route: '/setup?token=abc123' });
    expect(
      await screen.findByRole('heading', { name: /create your admin account/i }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/setup token/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/your name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^email/i)).toBeInTheDocument();
  });

  it('sends signed-out users to the login page', async () => {
    mockFetch({
      'GET /api/setup/status': { body: { completed: true, adminCreated: true, step: 7 } },
      'GET /api/auth/me': { status: 401, body: { message: 'unauthenticated' } },
    });
    renderWithProviders(<App />, { route: '/projects' });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows the app shell for signed-in users', async () => {
    mockFetch({
      'GET /api/setup/status': { body: { completed: true, adminCreated: true, step: 7 } },
      'GET /api/auth/me': { body: me },
      'GET /api/overview': {
        body: {
          stats: { openPrs: 3 },
          ai: { enabled: true, budgetExhausted: true, spentUsd: 100, capUsd: 100 },
        },
      },
      'GET /api/notifications': { body: [] },
    });
    renderWithProviders(<App />, { route: '/' });
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(await screen.findByText(/AI budget reached/i)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /settings/i }).length).toBeGreaterThan(0);
  });
});

describe('pull request report', () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup() {
    mockFetch({
      'GET /api/setup/status': { body: { completed: true, adminCreated: true, step: 7 } },
      'GET /api/auth/me': { body: { ...me, user: { ...me.user, role: 'member' } } },
      'GET /api/overview': { body: {} },
      'GET /api/notifications': { body: [] },
      'GET /api/github/status': { body: { connected: true, app: null, installations: [] } },
      'GET /api/pull-requests/pr1': { body: prDetail },
      'GET /api/pull-requests/pr1/analyses': { body: [] },
    });
  }

  it('never claims the change is secure when no security issues are found', async () => {
    setup();
    renderWithProviders(<App />, { route: '/pull-requests/pr1?tab=security' });
    expect(await screen.findByText(NO_SECURITY_ISSUES_TEXT)).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/\bis secure\b|\bsecure pr\b/i);
  });

  it('shows plain-language summary, AI-off banner and limitations', async () => {
    setup();
    renderWithProviders(<App />, { route: '/pull-requests/pr1' });
    expect(
      await screen.findByText('Adds a retry to the payment webhook handler.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/AI is turned off for this repository/i)).toBeInTheDocument();
    expect(screen.getByText('AI disabled for this repo')).toBeInTheDocument();
    expect(screen.getAllByText('Ready to merge').length).toBeGreaterThan(0);
    // Members don't get the admin-only re-analyze action.
    expect(screen.queryByRole('button', { name: /re-analyze/i })).toBeNull();
  });

  it('renders all six risk dimensions with scores', async () => {
    setup();
    renderWithProviders(<App />, { route: '/pull-requests/pr1?tab=risk' });
    await waitFor(() => expect(screen.getAllByRole('meter')).toHaveLength(6));
    for (const label of [
      'Security',
      'Breaking changes',
      'Integration',
      'Regression',
      'Database',
      'Deployment',
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('Touches retry logic.')).toBeInTheDocument();
  });
});
