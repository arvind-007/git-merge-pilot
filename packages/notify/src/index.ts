// @gmp/notify — notification channels, dispatcher and daily digest (design §10).
export {
  dispatch,
  resolveRule,
  ruleRejects,
  defaultRule,
  projectRecipients,
  sanitizeNotificationUrl,
  slackDedupKey,
  markNotificationRead,
  MAX_TITLE_LENGTH,
  MAX_BODY_LENGTH,
} from './dispatch.ts';
export {
  flushPending,
  parseAttempts,
  retryDelayMs,
  RETRY_DELAYS_MS,
  DEFAULT_MAX_ATTEMPTS,
} from './flush.ts';
export { buildDigest, isAwaitingReview } from './digest.ts';
export {
  renderDigest,
  digestIsEmpty,
  digestTitle,
  renderNotificationEmail,
  renderNotificationSlack,
  type RenderableNotification,
} from './render.ts';
export {
  sendEmail,
  verifyEmailTransport,
  createSmtpTransport,
  ChannelSendError,
} from './channels/email.ts';
export { sendSlack, buildSlackPayload, chunkMrkdwn } from './channels/slack.ts';
export { testChannel } from './channels/test-channel.ts';
export {
  ChannelConfigError,
  parseChannelConfig,
  parseEmailChannelConfig,
  parseSlackChannelConfig,
  extraSlackWebhookHosts,
  SLACK_WEBHOOK_HOSTS,
  encryptChannelConfig,
  decryptChannelConfig,
  describeChannelConfig,
  isValidMailbox,
} from './channel-config.ts';
export {
  quietHoursEnd,
  isWithinQuietHours,
  parseClockTime,
  normalizeTimezone,
  localDate,
  isDigestDue,
  type QuietHoursWindow,
} from './quiet-hours.ts';
export {
  isMeaningfulChange,
  type MeaningfulChange,
  type MeaningfulChangeInput,
} from './meaningful.ts';
export { escapeHtml, escapeSlack, safeHttpUrl } from './escape.ts';
export type * from './types.ts';

import { sendEmail } from './channels/email.ts';
import { sendSlack } from './channels/slack.ts';

/** Channel senders grouped as in design §10 (`channels.sendEmail`, `channels.sendSlack`). */
export const channels = { sendEmail, sendSlack } as const;
