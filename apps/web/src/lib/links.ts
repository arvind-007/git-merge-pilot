import type { Evidence } from '../api/types.ts';

export const DEFAULT_GITHUB_WEB_URL = 'https://github.com';

/**
 * Return the URL only if it is an absolute http(s) URL or an app-relative path.
 * Repository/AI-provided URLs are untrusted: `javascript:`, `data:` etc. are rejected.
 */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;
  try {
    const u = new URL(trimmed);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/** Link to a file (and optional line range) in a repository at a given ref. */
export function githubFileUrl(opts: {
  webUrl?: string | undefined;
  repo: string;
  ref: string;
  path: string;
  line?: number | undefined;
  endLine?: number | undefined;
}): string {
  const base = (opts.webUrl ?? DEFAULT_GITHUB_WEB_URL).replace(/\/+$/, '');
  const repo = opts.repo.split('/').map(encodeURIComponent).join('/');
  let url = `${base}/${repo}/blob/${encodeURIComponent(opts.ref)}/${encodePath(opts.path)}`;
  if (opts.line && opts.line > 0) {
    url += `#L${opts.line}`;
    if (opts.endLine && opts.endLine > opts.line) url += `-L${opts.endLine}`;
  }
  return url;
}

/**
 * Best link for an evidence item: its own (validated) URL, else a blob link built from
 * repo + path + line at the commit the line refers to (the evidence's own ref; for removed
 * code the base commit; otherwise the analysed head), else null.
 */
export function evidenceUrl(
  ev: Evidence,
  ctx: { webUrl?: string | undefined; ref?: string | undefined; baseRef?: string | undefined },
): string | null {
  const own = safeUrl(ev.url);
  if (own) return own;
  const ref = ev.ref ?? (ev.side === 'base' ? ctx.baseRef : ctx.ref);
  if (ev.path && ev.repo && ev.repo.includes('/') && ref) {
    return githubFileUrl({
      webUrl: ctx.webUrl,
      repo: ev.repo,
      ref,
      path: ev.path,
      line: ev.line,
      endLine: ev.endLine,
    });
  }
  return null;
}

export function evidenceLabel(ev: Evidence): string {
  if (!ev.path) return ev.repo;
  let s = ev.path;
  if (ev.line) s += `:${ev.line}`;
  if (ev.endLine && ev.line && ev.endLine > ev.line) s += `–${ev.endLine}`;
  return s;
}

/** Install link for a GitHub App. */
export function appInstallUrl(htmlUrl: string | null | undefined): string | null {
  const safe = safeUrl(htmlUrl);
  return safe ? `${safe.replace(/\/+$/, '')}/installations/new` : null;
}

/**
 * Submit the GitHub App manifest to GitHub. GitHub's manifest flow requires a top-level form POST
 * with a single `manifest` field containing the JSON.
 */
export function submitManifestForm(
  postUrl: string,
  manifest: Record<string, unknown>,
  doc: Document = document,
): HTMLFormElement {
  const target = safeUrl(postUrl);
  if (!target || target.startsWith('/'))
    throw new Error('GitHub returned an invalid app creation URL.');
  const form = doc.createElement('form');
  form.method = 'post';
  form.action = target;
  form.style.display = 'none';
  const input = doc.createElement('input');
  input.type = 'hidden';
  input.name = 'manifest';
  input.value = JSON.stringify(manifest);
  form.appendChild(input);
  doc.body.appendChild(form);
  form.submit();
  return form;
}
