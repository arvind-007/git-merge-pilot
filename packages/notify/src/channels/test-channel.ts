import { redactSecrets } from '@gmp/core';
import { decryptChannelConfig, parseChannelConfig } from '../channel-config.ts';
import { oneLine } from '../escape.ts';
import { renderNotificationEmail, renderNotificationSlack } from '../render.ts';
import type {
  ChannelConfig,
  EmailChannelConfig,
  SlackChannelConfig,
  TestChannelInput,
  TestChannelOptions,
} from '../types.ts';
import { sendEmail, verifyEmailTransport } from './email.ts';
import { sendSlack } from './slack.ts';

const TEST_NOTIFICATION = {
  kind: 'test',
  severity: 'info' as const,
  title: 'git-merge-pilot test notification',
  body: 'This is a test message from git-merge-pilot. If you can read it, this notification channel is configured correctly.',
  url: null,
};

/**
 * Sends a test message through a channel (or, for email without a recipient, verifies the SMTP
 * connection and credentials). Never throws; errors are returned redacted.
 */
export async function testChannel(
  channel: TestChannelInput,
  options: TestChannelOptions = {},
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (channel.kind === 'in_app') return { ok: true };
    const config: ChannelConfig =
      channel.config !== undefined
        ? parseChannelConfig(channel.kind, channel.config)
        : decryptChannelConfig(channel.kind, channel.configEnc ?? null);

    if (channel.kind === 'email') {
      const cfg = config as EmailChannelConfig;
      const to = options.to ?? cfg.testRecipient;
      if (!to) {
        if (options.verifyEmailWithoutRecipient === false) {
          return { ok: false, error: 'No test recipient configured' };
        }
        await verifyEmailTransport(cfg, options.email);
        return { ok: true };
      }
      const msg = renderNotificationEmail(TEST_NOTIFICATION, to);
      if (options.senders?.email) await options.senders.email(cfg, msg);
      else await sendEmail(cfg, msg, options.email);
      return { ok: true };
    }

    const cfg = config as SlackChannelConfig;
    const msg = renderNotificationSlack(TEST_NOTIFICATION);
    if (options.senders?.slack) await options.senders.slack(cfg.webhookUrl, msg);
    else await sendSlack(cfg.webhookUrl, msg, options.slack);
    return { ok: true };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return { ok: false, error: oneLine(redactSecrets(raw).text, 500) };
  }
}
