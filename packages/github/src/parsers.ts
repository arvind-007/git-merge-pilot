/**
 * Tiny, dependency-free parsers for the manifest formats repository discovery
 * reads (TOML subset, requirements.txt, Gemfile, go.mod/go.work, Gradle
 * settings, Maven POM, CODEOWNERS, pnpm-workspace.yaml). They are deliberately
 * lenient: discovery is best-effort and must never throw on odd input.
 */
import type { CodeownersRule } from './types.ts';

export type TomlValue = string | string[] | Record<string, unknown>;
/** Section name ('' for the root table) → key → value. */
export type TomlDocument = Record<string, Record<string, TomlValue>>;

function stripTomlComment(line: string): string {
  let inStr: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === '\\' && inStr === '"') i++;
      else if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function bracketBalance(text: string, open: string, close: string): number {
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\' && inStr === '"') i++;
      else if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === open) depth++;
    else if (ch === close) depth--;
  }
  return depth;
}

function unquote(raw: string): string {
  const s = raw.trim();
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    const inner = s.slice(1, -1);
    return s.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner;
  }
  return s;
}

/** Extracts all quoted strings that are direct elements of a TOML array literal. */
function parseStringArray(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|([[\]{}])/g;
  for (const m of raw.matchAll(re)) {
    if (m[3]) {
      if (m[3] === '[' || m[3] === '{') depth++;
      else depth--;
      continue;
    }
    if (depth === 1) out.push((m[1] ?? m[2] ?? '').replace(/\\"/g, '"'));
  }
  return out;
}

function parseInlineTable(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const inner = raw.trim().replace(/^\{/, '').replace(/\}$/, '');
  for (const m of inner.matchAll(
    /([A-Za-z0-9_.-]+|"[^"]*")\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*'|\[[^\]]*\]|[^,]+)/g,
  )) {
    const key = unquote(m[1] ?? '');
    const value = (m[2] ?? '').trim();
    out[key] = value.startsWith('[') ? parseStringArray(value) : unquote(value);
  }
  return out;
}

/** Splits a (possibly quoted) dotted TOML key: `a."b.c".d` → ['a', 'b.c', 'd']. */
function splitDottedKey(raw: string): string[] {
  const parts: string[] = [];
  for (const m of raw.matchAll(/\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^.]+)\s*(?:\.|$)/g)) {
    const part = m[1];
    if (part !== undefined && part.trim() !== '') parts.push(unquote(part));
  }
  return parts;
}

function parseTomlValue(raw: string): TomlValue {
  const v = raw.trim();
  if (v.startsWith('[')) return parseStringArray(v);
  if (v.startsWith('{')) return parseInlineTable(v);
  return unquote(v);
}

/** Parses the subset of TOML used by pyproject.toml, Cargo.toml and Pipfile. */
export function parseTomlLite(text: string): TomlDocument {
  const doc: TomlDocument = { '': {} };
  let section = '';
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = stripTomlComment(lines[i] ?? '').trim();
    if (!line) continue;
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (header?.[1]) {
      section = splitDottedKey(header[1]).join('.');
      doc[section] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const keyParts = splitDottedKey(line.slice(0, eq));
    if (keyParts.length === 0) continue;
    let value = line.slice(eq + 1).trim();
    // Multi-line arrays / inline tables.
    const open = value.startsWith('[') ? '[' : value.startsWith('{') ? '{' : null;
    if (open) {
      const close = open === '[' ? ']' : '}';
      while (bracketBalance(value, open, close) > 0 && i + 1 < lines.length) {
        i++;
        line = stripTomlComment(lines[i] ?? '');
        value += `\n${line}`;
      }
    }
    // Multi-line basic strings: keep just the first line's content (not needed by discovery).
    const finalKey = keyParts[keyParts.length - 1] as string;
    const prefix = keyParts.slice(0, -1).join('.');
    const target = prefix ? (section ? `${section}.${prefix}` : prefix) : section;
    (doc[target] ??= {})[finalKey] = parseTomlValue(value);
  }
  return doc;
}

/** Normalises a Python distribution name (PEP 503). */
export function normalizePyName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** Extracts the distribution name from a PEP 508 requirement string. */
export function pep508Name(requirement: string): string | null {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(requirement);
  return m?.[1] ? normalizePyName(m[1]) : null;
}

/** Package names from a requirements*.txt file. */
export function parseRequirementsTxt(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/(^|\s)#.*$/, '').trim();
    if (!line || line.startsWith('-') || line.includes('://')) continue;
    const name = pep508Name(line);
    if (name) out.push(name);
  }
  return out;
}

/** Gem names from a Gemfile. */
export function parseGemfile(text: string): string[] {
  return [...text.matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)].map((m) => (m[1] ?? '').toLowerCase());
}

export interface GoMod {
  module: string | null;
  requires: string[];
}

/** Module path and required module paths from go.mod. */
export function parseGoMod(text: string): GoMod {
  const module = /^\s*module\s+(\S+)/m.exec(text)?.[1]?.replace(/^"|"$/g, '') ?? null;
  const requires: string[] = [];
  let inBlock = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (/^require\s*\($/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      continue;
    }
    const m = inBlock ? /^(\S+)\s+v\S+/.exec(line) : /^require\s+(\S+)\s+v\S+/.exec(line);
    if (m?.[1]) requires.push(m[1]);
  }
  return { module, requires };
}

/** Directories listed by `use` directives in go.work. */
export function parseGoWork(text: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (/^use\s*\($/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      continue;
    }
    const m = inBlock ? /^(\S+)$/.exec(line) : /^use\s+(\S+)$/.exec(line);
    if (m?.[1]) out.push(m[1].replace(/^"|"$/g, ''));
  }
  return out;
}

/** Project directories included by settings.gradle(.kts). */
export function parseGradleSettings(text: string): string[] {
  const out: string[] = [];
  const cleaned = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const stmt of cleaned.matchAll(/\binclude\s*\(?([^\n)]*)\)?/g)) {
    for (const q of (stmt[1] ?? '').matchAll(/['"]([^'"]+)['"]/g)) {
      const name = (q[1] ?? '').replace(/^:/, '').replace(/:/g, '/');
      if (name) out.push(name);
    }
  }
  return out;
}

export interface PomInfo {
  artifactId: string | null;
  modules: string[];
}

/** Own artifactId (not the parent's or a dependency's) and <modules> of a pom.xml. */
export function parsePom(text: string): PomInfo {
  const cleaned = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<parent>[\s\S]*?<\/parent>/g, '')
    .replace(/<dependencies>[\s\S]*?<\/dependencies>/g, '')
    .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '')
    .replace(/<build>[\s\S]*?<\/build>/g, '')
    .replace(/<profiles>[\s\S]*?<\/profiles>/g, '');
  const artifactId = /<artifactId>\s*([^<]+?)\s*<\/artifactId>/.exec(cleaned)?.[1] ?? null;
  const modulesBlock = /<modules>([\s\S]*?)<\/modules>/.exec(cleaned)?.[1] ?? '';
  const modules = [...modulesBlock.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map(
    (m) => m[1] ?? '',
  );
  return { artifactId, modules: modules.filter(Boolean) };
}

/** `packages:` globs from pnpm-workspace.yaml. */
export function parsePnpmWorkspace(text: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s#.*$/, '');
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      const inline = /\[(.*)\]/.exec(line)?.[1];
      if (inline) {
        out.push(
          ...inline
            .split(',')
            .map((s) => unquote(s))
            .filter(Boolean),
        );
        inPackages = false;
      }
      continue;
    }
    if (!inPackages) continue;
    if (/^\S/.test(line)) {
      inPackages = false;
      continue;
    }
    const item = /^\s*-\s*(.+?)\s*$/.exec(line)?.[1];
    if (item) out.push(unquote(item));
  }
  return out;
}

/**
 * Parses CODEOWNERS into rules (pattern + owners), skipping comments and
 * blank lines. Lines without owners are kept (they un-assign ownership).
 */
export function parseCodeowners(text: string, maxRules = 1000): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    // Escaped spaces in patterns ("\ ") are allowed by GitHub.
    const parts = line.split(/(?<!\\)\s+/);
    const pattern = parts[0];
    if (!pattern || pattern.startsWith('[') || pattern.startsWith('^[')) continue; // GitLab section headers
    const owners = parts.slice(1).filter((o) => o.startsWith('@') || o.includes('@'));
    rules.push({ pattern: pattern.replace(/\\ /g, ' '), owners });
    if (rules.length >= maxRules) break;
  }
  return rules;
}
