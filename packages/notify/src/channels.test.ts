import { randomBytes } from 'node:crypto';
import { encryptJson } from '@gmp/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChannelConfigError,
  decryptChannelConfig,
  describeChannelConfig,
  encryptChannelConfig,
  parseEmailChannelConfig,
  extraSlackWebhookHosts,
  parseSlackChannelConfig,
} from './channel-config.ts';
import { ChannelSendError, sendEmail } from './channels/email.ts';
import { buildSlackPayload, chunkMrkdwn, sendSlack } from './channels/slack.ts';
import { testChannel } from './channels/test-channel.ts';
import { isMeaningfulChange } from './meaningful.ts';
import type { EmailChannelConfig, MailTransport } from './types.ts';

const KEY = randomBytes(32);
// Built at runtime so no webhook-looking literal sits in the source.
const HOOK = ['https://hooks.slack.com', 'services', 'T000', 'B000', 'notarealsecret'].join('/');

const smtp: EmailChannelConfig = {
  host: 'smtp.example.test',
  port: 587,
  secure: false,
  username: 'mailer',
  password: 'pw-not-real',
  from: '"git-merge-pilot" <alerts@example.test>',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('channel config', () => {
  it('validates email configs and applies defaults', () => {
    expect(
      parseEmailChannelConfig({ host: 'mail.example.test', from: 'a@example.test', secure: true }),
    ).toEqual({
      host: 'mail.example.test',
      port: 465,
      secure: true,
      from: 'a@example.test',
    });
    expect(() =>
      parseEmailChannelConfig({ host: 'bad host', from: 'nope', port: 70000, password: 'x' }),
    ).toThrow(ChannelConfigError);
    try {
      parseEmailChannelConfig({ password: 'super-secret-value' });
    } catch (err) {
      expect((err as ChannelConfigError).issues).toContain('host is required');
      expect((err as Error).message).not.toContain('super-secret-value');
    }
    expect(() => parseEmailChannelConfig({ ...smtp, from: 'a@b.co\r\nBcc: x@y.z' })).toThrow(
      ChannelConfigError,
    );
  });

  it('requires https slack webhooks without credentials', () => {
    expect(parseSlackChannelConfig({ webhookUrl: HOOK }).webhookUrl).toBe(HOOK);
    expect(() => parseSlackChannelConfig({ webhookUrl: 'http://hooks.example.test/x' })).toThrow(
      /https/,
    );
    expect(() =>
      parseSlackChannelConfig({ webhookUrl: 'https://u:p@hooks.example.test/x' }),
    ).toThrow(/credentials/);
    expect(() => parseSlackChannelConfig({})).toThrow(/required/);
  });

  it('only accepts Slack webhook hosts unless a host is explicitly allowed', () => {
    for (const url of [
      'https://10.0.0.5:8443/internal-admin/reset',
      'https://internal-service.local/services/x',
      'https://hooks.slack.com.evil.example/services/x',
      'https://hooks.slack.com:8443/services/x',
      'https://hooks.slack.com/api/other',
    ]) {
      expect(() => parseSlackChannelConfig({ webhookUrl: url }, { extraHosts: [] })).toThrow(
        /Slack incoming webhook/,
      );
    }
    expect(
      parseSlackChannelConfig(
        { webhookUrl: 'https://hooks.slack-gov.com/workflows/T1/A1/x' },
        { extraHosts: [] },
      ).webhookUrl,
    ).toBe('https://hooks.slack-gov.com/workflows/T1/A1/x');
    expect(
      parseSlackChannelConfig(
        { webhookUrl: 'https://chat.example.org/hooks/abc' },
        { extraHosts: ['chat.example.org'] },
      ).webhookUrl,
    ).toBe('https://chat.example.org/hooks/abc');
    expect(
      extraSlackWebhookHosts({ GMP_SLACK_EXTRA_WEBHOOK_HOSTS: ' Chat.Example.org, ,x.y ' }),
    ).toEqual(['chat.example.org', 'x.y']);
  });

  it('round-trips encrypted configs and describes them without secrets', () => {
    const enc = encryptChannelConfig('email', smtp, KEY)!;
    expect(enc.startsWith('v1:')).toBe(true);
    expect(enc).not.toContain('pw-not-real');
    const dec = decryptChannelConfig('email', enc, KEY);
    expect(dec.password).toBe('pw-not-real');
    const described = describeChannelConfig('email', dec);
    expect(JSON.stringify(described)).not.toContain('pw-not-real');
    expect(described.passwordConfigured).toBe(true);
    const slack = describeChannelConfig('slack', { webhookUrl: HOOK });
    expect(JSON.stringify(slack)).not.toContain('notarealsecret');
    expect(encryptChannelConfig('in_app', {}, KEY)).toBeNull();
    expect(() => decryptChannelConfig('email', enc, randomBytes(32))).toThrow(
      /could not be decrypted/,
    );
    expect(() => decryptChannelConfig('slack', null, KEY)).toThrow(ChannelConfigError);
  });
});

describe('sendEmail', () => {
  it('sends through the transport with sanitized subject and closes it', async () => {
    const sent: unknown[] = [];
    let closed = false;
    const transport: MailTransport = {
      sendMail: async (m) => {
        sent.push(m);
        return { messageId: '<id@test>' };
      },
      close: () => {
        closed = true;
      },
    };
    const res = await sendEmail(
      smtp,
      { to: 'pm@example.test', subject: 'Hi\r\nthere', text: 'body', html: '<p>body</p>' },
      { createTransport: () => transport },
    );
    expect(res.messageId).toBe('<id@test>');
    expect(closed).toBe(true);
    expect(sent[0]).toMatchObject({
      from: smtp.from,
      to: 'pm@example.test',
      subject: 'Hi there',
      html: '<p>body</p>',
    });
  });

  it('maps SMTP errors to redacted ChannelSendErrors with retryability', async () => {
    const fail = (err: unknown) => ({
      sendMail: async () => {
        throw err;
      },
    });
    const fakeToken = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
    const auth = Object.assign(new Error(`Invalid login: 535 ${fakeToken}`), {
      code: 'EAUTH',
      responseCode: 535,
    });
    await expect(
      sendEmail(
        smtp,
        { to: 'a@b.co', subject: 's', text: 't' },
        { createTransport: () => fail(auth) },
      ),
    ).rejects.toSatisfy(
      (e: ChannelSendError) =>
        e instanceof ChannelSendError && !e.retryable && !e.message.includes(fakeToken),
    );
    const conn = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNECTION' });
    await expect(
      sendEmail(
        smtp,
        { to: 'a@b.co', subject: 's', text: 't' },
        { createTransport: () => fail(conn) },
      ),
    ).rejects.toSatisfy((e: ChannelSendError) => e.retryable && e.message.includes('ECONNECTION'));
    await expect(sendEmail(smtp, { to: [], subject: 's', text: 't' })).rejects.toThrow(
      /No recipients/,
    );
  });
});

describe('sendSlack', () => {
  it('posts Block Kit JSON with escaped text', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('ok', { status: 200 });
    });
    await sendSlack(HOOK, {
      title: 'Risk <!channel>',
      severity: 'high',
      text: 'a & b',
      url: 'https://gmp.example.test/x',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(HOOK);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(calls[0]!.init.body)) as {
      text: string;
      blocks: Array<{ type: string; text?: { text: string } }>;
    };
    expect(body.text).toBe('[HIGH] Risk &lt;!channel&gt;');
    expect(body.blocks[0]!.text!.text).toContain(
      '<https://gmp.example.test/x|Risk &lt;!channel&gt;>',
    );
    expect(body.blocks[1]!.text!.text).toBe('a &amp; b');
    expect(body.blocks.at(-1)!.type).toBe('context');
  });

  it('times out and never leaks the webhook URL in errors', async () => {
    vi.stubGlobal(
      'fetch',
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    const err = await sendSlack(HOOK, { text: 'x' }, { timeoutMs: 30 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelSendError);
    expect((err as Error).message).toMatch(/timed out after 30ms/);
    expect((err as Error).message).not.toContain('notarealsecret');
  });

  it('classifies HTTP errors', async () => {
    vi.stubGlobal('fetch', async () => new Response('invalid_token', { status: 403 }));
    const e403 = (await sendSlack(HOOK, { text: 'x' }).catch(
      (e: unknown) => e,
    )) as ChannelSendError;
    expect(e403.status).toBe(403);
    expect(e403.retryable).toBe(false);
    expect(e403.message).toBe('Slack webhook responded 403');
    expect(e403.message).not.toContain('invalid_token');
    vi.stubGlobal('fetch', async () => new Response('busy', { status: 503 }));
    const e503 = (await sendSlack(HOOK, { text: 'x' }).catch(
      (e: unknown) => e,
    )) as ChannelSendError;
    expect(e503.retryable).toBe(true);
  });

  it('chunks long bodies under the Slack section limit and caps blocks', () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(200)}`).join('\n');
    const chunks = chunkMrkdwn(long);
    expect(chunks.every((c) => c.length <= 2900)).toBe(true);
    expect(chunks.join('\n').replace(/\n/g, '')).toBe(long.replace(/\n/g, ''));
    const payload = buildSlackPayload({ text: long });
    expect(payload.blocks.length).toBeLessThanOrEqual(50);
    const huge = buildSlackPayload({ text: 'y'.repeat(10_000) });
    expect(
      huge.blocks.every(
        (b) => !('text' in b) || String((b as { text: { text: string } }).text.text).length <= 2900,
      ),
    ).toBe(true);
  });
});

describe('testChannel', () => {
  it('sends a test message via injected senders and reports errors redacted', async () => {
    const slackCalls: string[] = [];
    const ok = await testChannel(
      { kind: 'slack', configEnc: encryptJson({ webhookUrl: HOOK }, KEY) },
      { senders: { slack: async (url) => void slackCalls.push(url) } },
    ).catch((e: unknown) => e);
    // configEnc encrypted with KEY but default key lookup is used → fails cleanly without throwing.
    expect(ok).toMatchObject({ ok: false });
    expect(slackCalls).toHaveLength(0);

    const res = await testChannel(
      { kind: 'slack', config: { webhookUrl: HOOK } },
      { senders: { slack: async (url) => void slackCalls.push(url) } },
    );
    expect(res).toEqual({ ok: true });
    expect(slackCalls).toEqual([HOOK]);

    const emails: string[] = [];
    const res2 = await testChannel(
      { kind: 'email', config: smtp },
      {
        to: 'pm@example.test',
        senders: { email: async (_c, m) => void emails.push(String(m.to)) },
      },
    );
    expect(res2).toEqual({ ok: true });
    expect(emails).toEqual(['pm@example.test']);

    const res3 = await testChannel(
      { kind: 'email', config: smtp },
      {
        to: 'pm@example.test',
        senders: {
          email: async () => Promise.reject(new Error('boom token=abcdef1234567890abcdef')),
        },
      },
    );
    expect(res3.ok).toBe(false);
    expect(res3.error).toContain('boom');
    expect(res3.error).not.toContain('abcdef1234567890abcdef');

    expect(await testChannel({ kind: 'in_app' })).toEqual({ ok: true });
    expect(
      (await testChannel({ kind: 'email', config: smtp }, { verifyEmailWithoutRecipient: false }))
        .ok,
    ).toBe(false);
  });
});

describe('isMeaningfulChange', () => {
  it('flags risk increases, new high findings and new confirmed/likely relationships', () => {
    expect(
      isMeaningfulChange({
        previousRisk: 'low',
        currentRisk: 'medium',
        newFindings: [],
        newRelationships: [],
      }),
    ).toEqual({
      meaningful: true,
      reasons: ['risk_increased'],
    });
    expect(
      isMeaningfulChange({
        previousRisk: 'high',
        currentRisk: 'medium',
        newFindings: [{ severity: 'medium' }],
        newRelationships: [{ confidence: 'possible' }],
      }).meaningful,
    ).toBe(false);
    expect(
      isMeaningfulChange({
        previousRisk: null,
        currentRisk: 'high',
        newFindings: [{ severity: 'critical' }],
        newRelationships: [{ confidence: 'likely' }],
      }).reasons,
    ).toEqual(['risk_increased', 'new_high_finding', 'new_relationship']);
    expect(
      isMeaningfulChange({
        previousRisk: null,
        currentRisk: 'medium',
        newFindings: [],
        newRelationships: [],
      }).meaningful,
    ).toBe(false);
  });
});
