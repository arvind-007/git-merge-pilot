import { redactSecrets } from '@gmp/core';
import { createTransport } from 'nodemailer';
import { parseEmailChannelConfig } from '../channel-config.ts';
import { oneLine } from '../escape.ts';
import type {
  EmailChannelConfig,
  EmailMessage,
  EmailSendOptions,
  MailTransport,
} from '../types.ts';

const DEFAULT_SMTP_TIMEOUT_MS = 15_000;

/** Error from a channel send. The message is redacted and never contains credentials or URLs. */
export class ChannelSendError extends Error {
  readonly channel: 'email' | 'slack';
  readonly status?: number;
  readonly retryable: boolean;
  constructor(
    channel: 'email' | 'slack',
    message: string,
    opts: { status?: number; retryable?: boolean } = {},
  ) {
    super(redactSecrets(message).text);
    this.name = 'ChannelSendError';
    this.channel = channel;
    if (opts.status !== undefined) this.status = opts.status;
    this.retryable = opts.retryable ?? true;
  }
}

/** Builds a nodemailer SMTP transport with bounded timeouts. */
export function createSmtpTransport(
  config: EmailChannelConfig,
  timeoutMs = DEFAULT_SMTP_TIMEOUT_MS,
): MailTransport {
  return createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: config.requireTls ?? false,
    auth: config.username ? { user: config.username, pass: config.password ?? '' } : undefined,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    disableFileAccess: true,
    disableUrlAccess: true,
  }) as unknown as MailTransport;
}

function describeSmtpError(err: unknown): { message: string; retryable: boolean } {
  const e = err as { code?: string; responseCode?: number; message?: string };
  const code = e?.code ? String(e.code) : undefined;
  const responseCode = typeof e?.responseCode === 'number' ? e.responseCode : undefined;
  // Permanent failures: auth rejected or 5xx responses (other than 552/554 transient variants).
  const retryable = !(
    code === 'EAUTH' ||
    (responseCode !== undefined && responseCode >= 500 && responseCode < 600)
  );
  const parts = ['SMTP send failed'];
  if (code) parts.push(`code=${code}`);
  if (responseCode !== undefined) parts.push(`response=${responseCode}`);
  if (e?.message) parts.push(oneLine(e.message, 300));
  return { message: parts.join(' '), retryable };
}

/**
 * Sends one email via SMTP (nodemailer). `smtpConfig` is validated first. Rejects with
 * {@link ChannelSendError} on failure. Returns the SMTP message id.
 */
export async function sendEmail(
  smtpConfig: EmailChannelConfig,
  msg: EmailMessage,
  options: EmailSendOptions = {},
): Promise<{ messageId: string | null }> {
  const config = parseEmailChannelConfig(smtpConfig);
  const recipients = (Array.isArray(msg.to) ? msg.to : [msg.to])
    .map((r) => r.trim())
    .filter(Boolean);
  if (recipients.length === 0)
    throw new ChannelSendError('email', 'No recipients', { retryable: false });
  for (const r of recipients) {
    if (/[\r\n]/.test(r))
      throw new ChannelSendError('email', 'Invalid recipient address', { retryable: false });
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_SMTP_TIMEOUT_MS;
  const transport = (options.createTransport ?? createSmtpTransport)(config, timeoutMs);
  try {
    const info = await transport.sendMail({
      from: config.from,
      to: recipients.length === 1 ? recipients[0]! : recipients,
      subject: oneLine(msg.subject, 250),
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
    });
    return { messageId: info?.messageId ?? null };
  } catch (err) {
    if (err instanceof ChannelSendError) throw err;
    const d = describeSmtpError(err);
    throw new ChannelSendError('email', d.message, { retryable: d.retryable });
  } finally {
    transport.close?.();
  }
}

/** SMTP handshake + authentication check without sending a message. */
export async function verifyEmailTransport(
  smtpConfig: EmailChannelConfig,
  options: EmailSendOptions = {},
): Promise<void> {
  const config = parseEmailChannelConfig(smtpConfig);
  const transport = (options.createTransport ?? createSmtpTransport)(
    config,
    options.timeoutMs ?? DEFAULT_SMTP_TIMEOUT_MS,
  );
  try {
    if (transport.verify) await transport.verify();
  } catch (err) {
    throw new ChannelSendError('email', describeSmtpError(err).message);
  } finally {
    transport.close?.();
  }
}
