/** Escapes text for safe inclusion in HTML element content and quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escapes text for Slack mrkdwn: `&`, `<` and `>` are control characters (they form links and
 * mentions such as `<!channel>`), so untrusted text must never contain them raw.
 */
export function escapeSlack(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Returns a normalised absolute http(s) URL, or null for anything else (javascript:, data:,
 * relative paths, malformed input). Used before emitting any link.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Slack link `<url|label>`; falls back to escaped label when the URL is not http(s). */
export function slackLink(url: string | null | undefined, label: string): string {
  const safe = safeHttpUrl(url);
  // `|` cannot be escaped inside a link label; swap it for a lookalike.
  const text = escapeSlack(label.replace(/\|/g, '∣'));
  if (!safe) return text;
  const href = safe.replace(/\|/g, '%7C').replace(/</g, '%3C').replace(/>/g, '%3E');
  return `<${href}|${text}>`;
}

/** HTML anchor with inline style; plain escaped text when the URL is not http(s). */
export function htmlLink(url: string | null | undefined, label: string, style = ''): string {
  const safe = safeHttpUrl(url);
  if (!safe) return escapeHtml(label);
  const styleAttr = style ? ` style="${escapeHtml(style)}"` : '';
  return `<a href="${escapeHtml(safe)}"${styleAttr}>${escapeHtml(label)}</a>`;
}

/** Collapses whitespace/newlines (for subjects, one-line labels). */
export function oneLine(value: string, max = 200): string {
  const s = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Truncates long text with an ellipsis marker. */
export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
