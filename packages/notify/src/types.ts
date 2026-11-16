import type {
  ChannelKind,
  NotificationKind,
  RelationshipConfidence,
  RelationshipType,
  Recommendation,
  RiskLevel,
  Severity,
} from '@gmp/core';
import type { DbOrTx } from '@gmp/db';

/** Any Drizzle handle (database or transaction) usable for notify queries. */
export type NotifyDb = DbOrTx;

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface NotificationEvent {
  kind: NotificationKind;
  severity: Severity;
  /** Project the event belongs to; null/undefined for org-level events (budget, webhook failure). */
  projectId?: string | null;
  pullRequestId?: string | null;
  title: string;
  /** Plain text (never HTML). Rendered escaped for email/slack. */
  body: string;
  /** Absolute link (http/https) to the relevant page; non-http(s) values are dropped. */
  url?: string | null;
  /**
   * Stable key identifying "the same" notification (e.g. `high_risk:<prId>:<headSha>`).
   * Uniqueness is enforced per (dedup key, channel kind, recipient).
   */
  dedupKey: string;
}

export interface DispatchInput {
  db: NotifyDb;
  orgId: string;
  event: NotificationEvent;
  /** Clock override (tests / replays). Defaults to `new Date()`. */
  now?: Date;
}

export type DispatchSkipReason =
  | 'project_not_found'
  | 'below_min_severity'
  | 'event_not_subscribed'
  | 'digest_disabled'
  | 'no_recipients';

export interface DispatchResult {
  /** The rule that was applied (null when the built-in default was used). */
  ruleId: string | null;
  /** Number of notification rows actually inserted (duplicates are not counted). */
  inserted: number;
  /** Rows that already existed for the dedup key (conflict, nothing written). */
  duplicates: number;
  /** Set when the event was filtered out entirely. */
  skipped?: DispatchSkipReason;
  /** When external deliveries were deferred by quiet hours, the time they become due. */
  deferredUntil: Date | null;
}

/** Notification rule after resolution (a DB row or the built-in default). */
export interface ResolvedRule {
  id: string | null;
  projectId: string | null;
  minSeverity: Severity;
  events: string[];
  channelIds: string[];
  digestEnabled: boolean;
  digestHour: number;
  timezone: string;
  quietStart: string | null;
  quietEnd: string | null;
}

// ---------------------------------------------------------------------------
// Flush
// ---------------------------------------------------------------------------

export interface FlushInput {
  db: NotifyDb;
  orgId: string;
  now?: Date;
  /** Max rows processed per call (default 100). */
  limit?: number;
  /** Max delivery attempts before a row is marked failed (default 5). */
  maxAttempts?: number;
  /** Absolute base URL of the app, used for "open" links when a row has no url. */
  publicUrl?: string;
  /**
   * Claimed rows are leased for this long (default 10 min) so concurrent workers skip them and
   * a crash mid-send makes them due again (at-least-once delivery).
   */
  leaseMs?: number;
  /** Test seam: replaces the real channel senders. */
  senders?: Partial<ChannelSenders>;
}

export interface ChannelSenders {
  email: (config: EmailChannelConfig, msg: EmailMessage) => Promise<unknown>;
  slack: (webhookUrl: string, msg: SlackMessage) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export interface EmailChannelConfig {
  host: string;
  port: number;
  /** Implicit TLS (port 465). When false, STARTTLS is used if offered (or required via requireTls). */
  secure: boolean;
  requireTls?: boolean;
  username?: string;
  password?: string;
  /** Envelope/header From, e.g. `"git-merge-pilot" <alerts@example.com>`. */
  from: string;
  /** Optional address used by testChannel when no explicit recipient is given. */
  testRecipient?: string;
}

export interface SlackChannelConfig {
  webhookUrl: string;
}

export type ChannelConfig = EmailChannelConfig | SlackChannelConfig | Record<string, never>;

export interface EmailMessage {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
}

export interface SlackMessage {
  /** Fallback/notification text (plain text; escaped before sending). */
  text: string;
  title?: string;
  severity?: Severity;
  url?: string | null;
  /** Pre-rendered Slack mrkdwn body (already escaped, e.g. from renderDigest(…, 'slack')). */
  mrkdwn?: string;
  /** Short context line (plain text), e.g. "high_risk · project X". */
  context?: string;
}

export interface SendOptions {
  /** Timeout in ms (default 10s for Slack, 15s socket/connection for SMTP). */
  timeoutMs?: number;
}

export interface MailTransport {
  sendMail(mail: {
    from: string;
    to: string | string[];
    subject: string;
    text: string;
    html?: string;
  }): Promise<{ messageId?: string }>;
  verify?(): Promise<unknown>;
  close?(): void;
}

export interface EmailSendOptions extends SendOptions {
  /** Test seam: build the transport yourself instead of nodemailer SMTP. */
  createTransport?: (config: EmailChannelConfig, timeoutMs: number) => MailTransport;
}

export interface TestChannelInput {
  kind: ChannelKind;
  /** encryptJson() blob from notification_channels.config_enc. */
  configEnc?: string | null;
  /** Or an already-decrypted config (e.g. a form value being tested before save). */
  config?: unknown;
  name?: string;
}

export interface TestChannelOptions {
  /** Email recipient for the test message; defaults to config.testRecipient. */
  to?: string;
  email?: EmailSendOptions;
  slack?: SendOptions;
  /** Test seam: replaces the real channel senders. */
  senders?: Partial<ChannelSenders>;
  /** Verify-only for email (SMTP handshake + auth) when no recipient is available. Default true. */
  verifyEmailWithoutRecipient?: boolean;
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

export interface DigestPr {
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  /** Link to the PR page inside git-merge-pilot when publicUrl was given. */
  appUrl?: string;
  author: string | null;
  draft: boolean;
  risk: RiskLevel | null;
  recommendation: Recommendation | null;
  openedAt: Date | null;
  mergedAt: Date | null;
  reviewDecision: string | null;
}

export interface DigestFinding {
  id: string;
  pullRequestId: string;
  repo: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  appUrl?: string;
  severity: Severity;
  title: string;
  verified: boolean;
  createdAt: Date;
}

export interface DigestPrRef {
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  appUrl?: string;
  /** The PR is in a repository outside the digest's project: shown without any details. */
  hidden?: boolean;
}

export interface DigestOverlap {
  id: string;
  type: RelationshipType;
  confidence: RelationshipConfidence;
  summary: string;
  prA: DigestPrRef;
  prB: DigestPrRef;
}

export interface ProjectDigest {
  projectId: string;
  projectName: string;
  newPrs: DigestPr[];
  mergedPrs: DigestPr[];
  highRiskPrs: DigestPr[];
  securityFindings: DigestFinding[];
  overlaps: DigestOverlap[];
  awaitingReview: DigestPr[];
  /** Full counts per section before truncation to `maxItemsPerSection`. */
  counts: DigestTotals;
}

export interface DigestTotals {
  newPrs: number;
  mergedPrs: number;
  highRiskPrs: number;
  securityFindings: number;
  overlaps: number;
  awaitingReview: number;
}

export interface DigestData {
  orgId: string;
  orgName: string;
  timezone: string;
  since: Date;
  until: Date;
  generatedAt: Date;
  projects: ProjectDigest[];
  totals: DigestTotals;
}

export interface BuildDigestInput {
  db: NotifyDb;
  orgId: string;
  /** Limit to one project; otherwise every non-paused project in the org. */
  projectId?: string | null;
  since: Date;
  until: Date;
  /** Absolute app base URL; adds `appUrl` links to PR pages. */
  publicUrl?: string;
  /** Max items per section (default 25). */
  maxItemsPerSection?: number;
  /** Minimum severity of security findings to include (default 'medium'). */
  minFindingSeverity?: Severity;
}

export type DigestFormat = 'email_html' | 'text' | 'slack';
