import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Finding } from '../api/types.ts';
import { DATA_NEVER_SENT, DataFlowConsent } from '../features/ai.tsx';
import { validateRule } from '../features/notify.tsx';
import { VerifiedBadge } from './badges.tsx';
import { FindingCard } from './findings.tsx';
import { Markdown } from './Markdown.tsx';

const finding: Finding = {
  fingerprint: 'fp1',
  category: 'security',
  severity: 'high',
  title: '<img src=x onerror=alert(1)> Hardcoded token',
  description: 'A token appears to be committed.\nRotate it.',
  technicalDetail: 'Matched rule github_token',
  evidence: [{ repo: 'acme/api', path: 'src/config.ts', line: 12, source: 'diff' }],
  verified: true,
  source: 'rule',
  ruleId: 'github_token',
};

describe('VerifiedBadge', () => {
  it('distinguishes verified facts from potential concerns', () => {
    const { rerender } = render(<VerifiedBadge verified />);
    expect(screen.getByText('Verified fact')).toBeInTheDocument();
    rerender(<VerifiedBadge verified={false} />);
    expect(screen.getByText('Potential concern')).toBeInTheDocument();
  });
});

describe('FindingCard', () => {
  it('renders untrusted text as text and links evidence to GitHub lines', () => {
    const { container } = render(<FindingCard finding={finding} ctx={{ ref: 'deadbeef' }} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/Hardcoded token/)).toHaveTextContent(
      '<img src=x onerror=alert(1)> Hardcoded token',
    );
    expect(screen.getByText('Verified fact')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /show technical details/i }));
    const link = screen.getByRole('link', { name: /src\/config\.ts:12/ });
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/acme/api/blob/deadbeef/src/config.ts#L12',
    );
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });
});

describe('Markdown', () => {
  it('does not render raw HTML or javascript: links', () => {
    const { container } = render(
      <Markdown
        text={
          'Hello <script>alert(1)</script> <img src=x onerror=alert(1)>\n\n[click](javascript:alert(1)) [ok](https://example.com)'
        }
      />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    const links = Array.from(container.querySelectorAll('a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/']);
    expect(screen.getByText('click')).toBeInTheDocument();
  });
});

describe('DataFlowConsent', () => {
  it('requires explicit acknowledgement before AI can be enabled', () => {
    const onEnable = vi.fn();
    render(
      <DataFlowConsent
        repos={[]}
        onRepoModeChange={() => undefined}
        onEnable={onEnable}
        onSkip={() => undefined}
      />,
    );
    for (const item of DATA_NEVER_SENT) expect(screen.getByText(item)).toBeInTheDocument();
    const enable = screen.getByRole('button', { name: /enable ai analysis/i });
    expect(enable).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I understand what will be sent/i));
    expect(enable).toBeEnabled();
    fireEvent.click(enable);
    expect(onEnable).toHaveBeenCalledOnce();
  });

  it('offers per-repository AI modes', () => {
    const onMode = vi.fn();
    const repo = {
      id: 'r1',
      githubId: 1,
      owner: 'acme',
      name: 'api',
      fullName: 'acme/api',
      private: true,
      defaultBranch: 'main',
      archived: false,
      monitoringEnabled: true,
      aiMode: 'full' as const,
      excludePaths: [],
      lastDiscoveredAt: null,
      lastPolledAt: null,
    };
    render(<DataFlowConsent repos={[repo]} onRepoModeChange={onMode} onEnable={() => undefined} />);
    fireEvent.click(screen.getByRole('radio', { name: /metadata only/i }));
    expect(onMode).toHaveBeenCalledWith(repo, 'metadata_only');
  });
});

describe('validateRule', () => {
  const base = {
    projectId: null,
    minSeverity: 'high' as const,
    events: [],
    channelIds: ['c1'],
    digestEnabled: true,
    digestHour: 9,
    timezone: 'UTC',
    quietStart: null,
    quietEnd: null,
  };
  it('accepts a valid rule and flags incomplete quiet hours', () => {
    expect(validateRule(base)).toBeNull();
    expect(validateRule({ ...base, quietStart: '22:00' })).toMatch(/both/);
    expect(validateRule({ ...base, quietStart: '22:00', quietEnd: '07:00' })).toBeNull();
    expect(validateRule({ ...base, channelIds: [] })).toMatch(/channel/);
    expect(validateRule({ ...base, digestHour: 24 })).toMatch(/0 and 23/);
  });
});
