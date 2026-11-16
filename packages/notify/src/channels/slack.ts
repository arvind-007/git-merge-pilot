import type { Severity } from '@gmp/core';
import { parseSlackChannelConfig } from '../channel-config.ts';
import { escapeSlack, oneLine, slackLink } from '../escape.ts';
import type { SendOptions, SlackMessage } from '../types.ts';
import { ChannelSendError } from './email.ts';

const DEFAULT_SLACK_TIMEOUT_MS = 10_000;
/** Slack limits: 3000 chars per section text, 50 blocks per message, ~40k chars for `text`. */
const SECTION_LIMIT = 2900;
const MAX_BLOCKS = 50;
const FALLBACK_TEXT_LIMIT = 3000;

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: ':red_circle: CRITICAL',
  high: ':large_orange_circle: HIGH',
  medium: ':large_yellow_circle: MEDIUM',
  low: ':large_blue_circle: LOW',
  info: ':white_circle: INFO',
};

type Block = Record<string, unknown>;

/** Splits mrkdwn into chunks under the section limit, preferring line boundaries. */
export function chunkMrkdwn(text: string, limit = SECTION_LIMIT): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    let piece = line;
    while (piece.length > limit) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      // Avoid splitting inside an entity or link.
      let cut = limit;
      const amp = piece.lastIndexOf('&', cut);
      if (amp > cut - 6 && amp > 0) cut = amp;
      const lt = piece.lastIndexOf('<', cut);
      const gt = piece.lastIndexOf('>', cut);
      if (lt > gt && lt > 0) cut = lt;
      chunks.push(piece.slice(0, cut));
      piece = piece.slice(cut);
    }
    const next = current ? `${current}\n${piece}` : piece;
    if (next.length > limit) {
      chunks.push(current);
      current = piece;
    } else {
      current = next;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks.filter((c) => c.trim().length > 0);
}

/** Builds the Block Kit payload for a message. All untrusted text is escaped. */
export function buildSlackPayload(msg: SlackMessage): { text: string; blocks: Block[] } {
  const blocks: Block[] = [];
  const title = msg.title ? oneLine(msg.title, 280) : '';
  const severity = msg.severity ? SEVERITY_LABEL[msg.severity] : '';
  if (title) {
    const heading = msg.url ? slackLink(msg.url, title) : escapeSlack(title);
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: severity ? `${severity}  *${heading}*` : `*${heading}*` },
    });
  }
  const body = msg.mrkdwn ?? escapeSlack(msg.text);
  for (const chunk of chunkMrkdwn(body)) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
  }
  const contextParts: string[] = [];
  if (msg.context) contextParts.push(escapeSlack(oneLine(msg.context, 300)));
  if (msg.url && !title) contextParts.push(slackLink(msg.url, 'Open in git-merge-pilot'));
  contextParts.push('git-merge-pilot');
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: contextParts.join(' · ') }] });

  if (blocks.length > MAX_BLOCKS) {
    const kept = blocks.slice(0, MAX_BLOCKS - 2);
    kept.push({ type: 'section', text: { type: 'mrkdwn', text: '_…message truncated_' } });
    kept.push(blocks[blocks.length - 1]!);
    blocks.length = 0;
    blocks.push(...kept);
  }

  const fallbackSource = title
    ? `${severity ? `[${msg.severity!.toUpperCase()}] ` : ''}${title}`
    : msg.text;
  const text = escapeSlack(oneLine(fallbackSource, FALLBACK_TEXT_LIMIT));
  return { text, blocks };
}

/**
 * Posts to a Slack incoming webhook with a timeout. Rejects with {@link ChannelSendError}
 * (whose message never includes the webhook URL, which is a secret).
 */
export async function sendSlack(
  webhookUrl: string,
  msg: SlackMessage,
  options: SendOptions = {},
): Promise<void> {
  const { webhookUrl: url } = parseSlackChannelConfig({ webhookUrl });
  const payload = buildSlackPayload(msg);
  const timeoutMs = options.timeoutMs ?? DEFAULT_SLACK_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ChannelSendError('slack', `Slack webhook timed out after ${timeoutMs}ms`);
    }
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    throw new ChannelSendError('slack', `Slack webhook request failed${code ? ` (${code})` : ''}`);
  }
  if (!res.ok) {
    // Never echo the response body: only the status code is reported.
    await res.text().catch(() => '');
    // 4xx (except 429) are configuration errors (revoked hook, bad payload): not retryable.
    const retryable = res.status === 429 || res.status >= 500;
    throw new ChannelSendError('slack', `Slack webhook responded ${res.status}`, {
      status: res.status,
      retryable,
    });
  }
  // Drain the body so the connection can be reused.
  await res.text().catch(() => '');
}

export { DEFAULT_SLACK_TIMEOUT_MS };
