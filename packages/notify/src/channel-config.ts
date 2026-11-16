import { decryptJson, encryptJson, type ChannelKind } from '@gmp/core';
import type { ChannelConfig, EmailChannelConfig, SlackChannelConfig } from './types.ts';

/** Raised for invalid channel configuration. Messages never include secret values. */
export class ChannelConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid notification channel config: ${issues.join('; ')}`);
    this.name = 'ChannelConfigError';
    this.issues = issues;
  }
}

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** Accepts `user@host` or `"Name" <user@host>` / `Name <user@host>`. */
export function isValidMailbox(value: string): boolean {
  const v = value.trim();
  if (/[\r\n]/.test(v)) return false;
  const angle = /^(?:"[^"\r\n]*"|[^<>"\r\n]*)\s*<([^<>\s]+)>$/.exec(v);
  if (angle) return EMAIL_RE.test(angle[1] ?? '');
  return EMAIL_RE.test(v);
}

function str(raw: Record<string, unknown>, key: string): string | undefined {
  const v = raw[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** Validates and normalises an SMTP channel config (unknown input → typed config). */
export function parseEmailChannelConfig(input: unknown): EmailChannelConfig {
  const issues: string[] = [];
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const host = str(raw, 'host');
  if (!host) issues.push('host is required');
  else if (!/^[A-Za-z0-9.-]+$|^\[[0-9a-fA-F:]+\]$/.test(host)) issues.push('host is invalid');

  const secure = raw.secure === true || raw.secure === 'true';
  let port: number;
  if (raw.port === undefined || raw.port === null || raw.port === '') {
    port = secure ? 465 : 587;
  } else {
    port = typeof raw.port === 'number' ? raw.port : Number(raw.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      issues.push('port must be an integer between 1 and 65535');
    }
  }

  const from = str(raw, 'from');
  if (!from) issues.push('from is required');
  else if (!isValidMailbox(from)) issues.push('from is not a valid email address');

  const username = str(raw, 'username') ?? str(raw, 'user');
  const password =
    typeof raw.password === 'string'
      ? raw.password
      : typeof raw.pass === 'string'
        ? raw.pass
        : undefined;
  if (password && !username) issues.push('username is required when password is set');

  const testRecipient = str(raw, 'testRecipient');
  if (testRecipient && !isValidMailbox(testRecipient))
    issues.push('testRecipient is not a valid email address');

  if (issues.length) throw new ChannelConfigError(issues);
  const cfg: EmailChannelConfig = { host: host!, port, secure, from: from! };
  if (raw.requireTls === true || raw.requireTls === 'true') cfg.requireTls = true;
  if (username) cfg.username = username;
  if (password) cfg.password = password;
  if (testRecipient) cfg.testRecipient = testRecipient;
  return cfg;
}

/** Hosts that serve Slack incoming webhooks. */
export const SLACK_WEBHOOK_HOSTS: readonly string[] = ['hooks.slack.com', 'hooks.slack-gov.com'];
const SLACK_WEBHOOK_PATH_RE = /^\/(services|workflows|triggers)\//;

/**
 * Extra webhook hosts an operator explicitly allows (Slack-compatible services such as a
 * self-hosted chat server), from `GMP_SLACK_EXTRA_WEBHOOK_HOSTS` (comma-separated).
 */
export function extraSlackWebhookHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.GMP_SLACK_EXTRA_WEBHOOK_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Validates a Slack incoming-webhook config. Only https URLs on Slack's webhook hosts (or hosts
 * an operator allowed explicitly) are accepted, so the server cannot be pointed at internal
 * endpoints.
 */
export function parseSlackChannelConfig(
  input: unknown,
  opts: { extraHosts?: readonly string[] } = {},
): SlackChannelConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const url = str(raw, 'webhookUrl') ?? str(raw, 'url');
  if (!url) throw new ChannelConfigError(['webhookUrl is required']);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ChannelConfigError(['webhookUrl is not a valid URL']);
  }
  if (parsed.protocol !== 'https:') throw new ChannelConfigError(['webhookUrl must use https']);
  if (parsed.username || parsed.password) {
    throw new ChannelConfigError(['webhookUrl must not contain credentials']);
  }
  const host = parsed.hostname.toLowerCase();
  const extra = opts.extraHosts ?? extraSlackWebhookHosts();
  if (extra.includes(host) && parsed.port === '') return { webhookUrl: parsed.toString() };
  if (
    !SLACK_WEBHOOK_HOSTS.includes(host) ||
    parsed.port !== '' ||
    !SLACK_WEBHOOK_PATH_RE.test(parsed.pathname)
  ) {
    throw new ChannelConfigError([
      'webhookUrl must be a Slack incoming webhook (https://hooks.slack.com/services/…)',
    ]);
  }
  return { webhookUrl: parsed.toString() };
}

/** Validates a config for the given channel kind (in_app has no config). */
export function parseChannelConfig(kind: 'email', input: unknown): EmailChannelConfig;
export function parseChannelConfig(kind: 'slack', input: unknown): SlackChannelConfig;
export function parseChannelConfig(kind: ChannelKind, input: unknown): ChannelConfig;
export function parseChannelConfig(kind: ChannelKind, input: unknown): ChannelConfig {
  switch (kind) {
    case 'email':
      return parseEmailChannelConfig(input);
    case 'slack':
      return parseSlackChannelConfig(input);
    case 'in_app':
      return {};
  }
}

/** Validates then encrypts a config for storage in notification_channels.config_enc. */
export function encryptChannelConfig(
  kind: ChannelKind,
  input: unknown,
  key?: Buffer,
): string | null {
  if (kind === 'in_app') return null;
  return encryptJson(parseChannelConfig(kind, input), key);
}

/** Decrypts and validates notification_channels.config_enc. */
export function decryptChannelConfig(
  kind: 'email',
  configEnc: string | null,
  key?: Buffer,
): EmailChannelConfig;
export function decryptChannelConfig(
  kind: 'slack',
  configEnc: string | null,
  key?: Buffer,
): SlackChannelConfig;
export function decryptChannelConfig(
  kind: ChannelKind,
  configEnc: string | null,
  key?: Buffer,
): ChannelConfig;
export function decryptChannelConfig(
  kind: ChannelKind,
  configEnc: string | null,
  key?: Buffer,
): ChannelConfig {
  if (kind === 'in_app') return {};
  if (!configEnc) throw new ChannelConfigError(['channel has no stored configuration']);
  let raw: unknown;
  try {
    raw = decryptJson<unknown>(configEnc, key);
  } catch {
    throw new ChannelConfigError(['stored configuration could not be decrypted']);
  }
  return parseChannelConfig(kind, raw);
}

/**
 * Redacted view safe to return from the API: secrets replaced by `configured: true` flags
 * (design §14 write-only fields).
 */
export function describeChannelConfig(
  kind: ChannelKind,
  config: ChannelConfig,
): Record<string, unknown> {
  if (kind === 'email') {
    const c = config as EmailChannelConfig;
    return {
      host: c.host,
      port: c.port,
      secure: c.secure,
      requireTls: c.requireTls ?? false,
      username: c.username ?? null,
      passwordConfigured: Boolean(c.password),
      from: c.from,
      testRecipient: c.testRecipient ?? null,
    };
  }
  if (kind === 'slack') {
    const c = config as SlackChannelConfig;
    let host: string | null;
    try {
      host = new URL(c.webhookUrl).host;
    } catch {
      host = null;
    }
    return { webhookConfigured: Boolean(c.webhookUrl), webhookHost: host };
  }
  return {};
}
