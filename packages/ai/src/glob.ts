/**
 * Glob matcher for `repositories.exclude_paths`: minimatch syntax with gitignore-like semantics.
 *
 * - `*` matches within one path segment, `**` across segments, `?` one char, `[abc]`/`[!a-z]` classes,
 *   `{a,b}` alternation. Dotfiles are matched.
 * - A pattern without a slash (e.g. `*.pem`, `node_modules`) matches at any depth.
 * - A pattern with a slash is anchored at the repo root (`docs/*.md`, `/secrets/**`).
 * - A pattern also matches everything below a matching directory (`vendor` excludes `vendor/x/y.js`).
 * - A leading `!` re-includes paths excluded by earlier patterns; the last matching pattern wins.
 * - Empty lines and lines starting with `#` are ignored.
 */

import { Minimatch } from 'minimatch';

interface CompiledPattern {
  negate: boolean;
  /** Pattern is anchored at the repo root (contains a slash). */
  anchored: boolean;
  mm: Minimatch;
}

export function normalizeRepoPath(path: string): string {
  let p = path.replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/^\/+/, '');
  return p;
}

function compilePattern(raw: string): CompiledPattern | null {
  let pattern = raw.trim();
  if (!pattern || pattern.startsWith('#')) return null;
  let negate = false;
  if (pattern.startsWith('!')) {
    negate = true;
    pattern = pattern.slice(1).trim();
  }
  while (pattern.startsWith('./')) pattern = pattern.slice(2);
  pattern = pattern.replace(/\/+$/, '');
  const anchored = pattern.startsWith('/') || pattern.includes('/');
  pattern = pattern.replace(/^\/+/, '');
  if (!pattern) return null;
  const mm = new Minimatch(pattern, { dot: true, nocomment: true, nonegate: true });
  return { negate, anchored, mm };
}

/**
 * gitignore-like match: an anchored pattern is matched from the root, an unanchored one at any
 * depth; a match on a directory prefix also covers everything below it.
 */
function matches(c: CompiledPattern, path: string): boolean {
  const segs = path.split('/');
  const lastStart = c.anchored ? 0 : segs.length - 1;
  for (let start = 0; start <= lastStart; start++) {
    for (let end = start + 1; end <= segs.length; end++) {
      if (c.mm.match(segs.slice(start, end).join('/'))) return true;
    }
  }
  return false;
}

export interface PathMatcher {
  /** True when the path is excluded by the pattern list. */
  (path: string): boolean;
  readonly patterns: readonly string[];
}

/** Compiles a list of exclude globs into a predicate. Invalid patterns are ignored. */
export function createPathMatcher(patterns: readonly string[] | null | undefined): PathMatcher {
  const compiled: CompiledPattern[] = [];
  for (const p of patterns ?? []) {
    try {
      const c = compilePattern(p);
      if (c) compiled.push(c);
    } catch {
      // Ignore invalid patterns.
    }
  }
  const matcher = ((path: string) => {
    if (compiled.length === 0) return false;
    const p = normalizeRepoPath(path);
    let excluded = false;
    for (const c of compiled) {
      if (c.negate ? excluded : !excluded) {
        if (matches(c, p)) excluded = !c.negate;
      }
    }
    return excluded;
  }) as PathMatcher;
  Object.defineProperty(matcher, 'patterns', { value: Object.freeze([...(patterns ?? [])]) });
  return matcher;
}

/** True when `path` matches any of the (non-negated) globs, honouring negations. */
export function isPathExcluded(
  path: string,
  patterns: readonly string[] | null | undefined,
): boolean {
  return createPathMatcher(patterns)(path);
}

/** Path-like tokens in free text (`src/a/b.ts`, `config.yml`, `.env.local`). */
const PATH_TOKEN_RE = /[\w@.+-]*(?:\/[\w@.+-]+)+|[\w@+-]*\.[A-Za-z][\w-]{0,15}/g;

/**
 * True when free text (e.g. a relationship summary) mentions a path excluded by any of the
 * matchers, so it must not be sent to an AI provider.
 */
export function mentionsExcludedPath(
  text: string | null | undefined,
  matchers: readonly PathMatcher[],
): boolean {
  if (!text) return false;
  const active = matchers.filter((m) => m.patterns.length > 0);
  if (active.length === 0) return false;
  for (const raw of text.match(PATH_TOKEN_RE) ?? []) {
    const token = raw.replace(/[.,;:)]+$/, '');
    if (!token) continue;
    if (active.some((m) => m(token))) return true;
  }
  return false;
}
