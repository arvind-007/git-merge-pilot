/** Dependency manifest parsing and diffing (npm, PyPI, Go, Maven, Gradle, RubyGems, Cargo, Composer). */
import { basename } from './language.ts';
import type { DependencyChange, DependencyEcosystem } from './types.ts';

export interface DependencyEntry {
  version: string;
  dev: boolean;
  line: number;
}

export type DependencyMap = Map<string, DependencyEntry>;

const NPM_SECTIONS: Record<string, boolean> = {
  dependencies: false,
  devDependencies: true,
  peerDependencies: false,
  optionalDependencies: false,
  require: false,
  'require-dev': true,
};

const NPM_METADATA_KEYS = new Set([
  'version',
  'name',
  'main',
  'module',
  'types',
  'typings',
  'node',
  'npm',
  'pnpm',
  'yarn',
  'packageManager',
  'license',
  'php',
  'description',
  'homepage',
  'type',
]);

const VERSION_LIKE =
  /^(?:[\^~<>=*]|\d|v\d|workspace:|npm:|git|github:|https?:|file:|link:|portal:|catalog:|latest$|next$|beta$|x$)/;

export function manifestEcosystem(path: string): DependencyEcosystem | null {
  const base = basename(path);
  if (base === 'package.json') return 'npm';
  if (base === 'composer.json') return 'composer';
  if (
    /^requirements.*\.txt$/.test(base) ||
    base === 'pyproject.toml' ||
    base === 'Pipfile' ||
    base === 'setup.py' ||
    base === 'setup.cfg'
  )
    return 'pypi';
  if (base === 'go.mod') return 'go';
  if (base === 'pom.xml') return 'maven';
  if (/^build\.gradle(?:\.kts)?$/.test(base)) return 'gradle';
  if (base === 'Gemfile') return 'rubygems';
  if (base === 'Cargo.toml') return 'cargo';
  return null;
}

/**
 * Parses dependencies from manifest text. `lineMap[i]` maps text line i to the file line.
 * Works on full files and on diff fragments (section context is inferred when present).
 */
export function parseDependencies(path: string, text: string, lineMap?: number[]): DependencyMap {
  const eco = manifestEcosystem(path);
  const out: DependencyMap = new Map();
  if (!eco || !text) return out;
  const lines = text.split('\n');
  const ln = (i: number) => lineMap?.[i] ?? i + 1;
  const base = basename(path);

  if (eco === 'npm' || eco === 'composer') {
    // `section` is the enclosing object key at depth 1 (null = unknown, e.g. diff fragment).
    let section: string | null = null;
    let sawSection = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] ?? '';
      const sec = /^\s*"([\w-]+)"\s*:\s*\{\s*(\}?)/.exec(l);
      if (sec?.[1]) {
        sawSection = true;
        section = sec[2] ? null : sec[1];
        continue;
      }
      if (/^\s*\}/.test(l)) {
        section = null;
        continue;
      }
      const m = /^\s*"([^"]+)"\s*:\s*"([^"]*)"/.exec(l);
      if (!m?.[1]) continue;
      const name = m[1];
      const version = m[2] ?? '';
      if (section !== null) {
        if (section in NPM_SECTIONS)
          out.set(name, { version, dev: NPM_SECTIONS[section] ?? false, line: ln(i) });
        continue;
      }
      // Unknown context (fragment): accept version-looking values for non-metadata keys.
      if (!sawSection && VERSION_LIKE.test(version) && !NPM_METADATA_KEYS.has(name))
        out.set(name, { version, dev: false, line: ln(i) });
    }
    return out;
  }
  if (eco === 'pypi') {
    let inDeps = base.startsWith('requirements');
    let dev = /dev|test/.test(base);
    for (let i = 0; i < lines.length; i++) {
      const l = (lines[i] ?? '').replace(/#.*$/, '');
      if (base === 'pyproject.toml' || base === 'Pipfile') {
        const sec = /^\s*\[([^\]]+)\]/.exec(l);
        if (sec?.[1]) {
          inDeps = /dependencies|dev-packages|packages|group\.\w+/.test(sec[1]);
          dev = /dev|test/.test(sec[1]);
          continue;
        }
        const pep =
          /^\s*["']([A-Za-z0-9_.\-[\],]+)\s*([<>=!~^][^"';]*)?(?:;[^"']*)?["']\s*,?\s*$/.exec(l);
        if (pep?.[1]) {
          out.set(pep[1].replace(/\[.*\]$/, '').toLowerCase(), {
            version: (pep[2] ?? '').trim(),
            dev,
            line: ln(i),
          });
          continue;
        }
        const poetry =
          /^\s*([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]*)"|\{[^}]*version\s*=\s*"([^"]*)")/.exec(l);
        if (poetry?.[1] && inDeps && poetry[1] !== 'python')
          out.set(poetry[1].toLowerCase(), {
            version: poetry[2] ?? poetry[3] ?? '',
            dev,
            line: ln(i),
          });
        continue;
      }
      if (!inDeps && base !== 'setup.py' && base !== 'setup.cfg') continue;
      const req =
        /^\s*['"]?([A-Za-z0-9][A-Za-z0-9_.-]*)(\[[^\]]*\])?\s*((?:[<>=!~]=?|===)\s*[^;'"\s,]+(?:\s*,\s*[<>=!~]=?\s*[^;'"\s,]+)*)?/.exec(
          l,
        );
      if (req?.[1] && !l.trim().startsWith('-'))
        out.set(req[1].toLowerCase(), {
          version: (req[3] ?? '').replace(/\s+/g, ''),
          dev,
          line: ln(i),
        });
    }
    return out;
  }
  if (eco === 'go') {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] ?? '';
      const m = /^\s*(?:require\s+)?([a-zA-Z0-9][\w.\-/]*\.[\w.\-/]+)\s+(v[\w.\-+]+)/.exec(l);
      if (m?.[1] && !/^\s*(?:module|go|toolchain|replace|exclude)\b/.test(l))
        out.set(m[1], { version: m[2] ?? '', dev: false, line: ln(i) });
    }
    return out;
  }
  if (eco === 'maven') {
    let artifact: string | null = null;
    let group = '';
    let scopeTest = false;
    let pendingVersion: { v: string; line: number } | null = null;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] ?? '';
      if (/<dependency>/.test(l)) {
        artifact = null;
        group = '';
        scopeTest = false;
        pendingVersion = null;
      }
      const g = /<groupId>([^<]+)<\/groupId>/.exec(l);
      if (g?.[1]) group = g[1].trim();
      const a = /<artifactId>([^<]+)<\/artifactId>/.exec(l);
      if (a?.[1]) artifact = a[1].trim();
      const v = /<version>([^<]+)<\/version>/.exec(l);
      if (v?.[1]) pendingVersion = { v: v[1].trim(), line: ln(i) };
      if (/<scope>test<\/scope>/.test(l)) scopeTest = true;
      if (/<\/dependency>/.test(l) || (artifact && pendingVersion && i === lines.length - 1)) {
        if (artifact)
          out.set(group ? `${group}:${artifact}` : artifact, {
            version: pendingVersion?.v ?? '',
            dev: scopeTest,
            line: pendingVersion?.line ?? ln(i),
          });
        artifact = null;
        pendingVersion = null;
      } else if (artifact && pendingVersion && !/<dependency>/.test(text)) {
        // Fragment without <dependency> wrappers: pair nearest artifact + version.
        out.set(group ? `${group}:${artifact}` : artifact, {
          version: pendingVersion.v,
          dev: scopeTest,
          line: pendingVersion.line,
        });
        pendingVersion = null;
      }
    }
    return out;
  }
  if (eco === 'gradle') {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] ?? '';
      const m = /\b(\w+)\s*\(?\s*['"]([\w.-]+):([\w.-]+):([^'"@]+)['"]/.exec(l);
      if (m?.[2])
        out.set(`${m[2]}:${m[3]}`, {
          version: m[4] ?? '',
          dev: /^test/i.test(m[1] ?? ''),
          line: ln(i),
        });
    }
    return out;
  }
  if (eco === 'rubygems') {
    let groupDev = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] ?? '';
      if (/^\s*group\s+.*:(?:development|test)/.test(l)) groupDev = true;
      else if (/^\s*end\b/.test(l)) groupDev = false;
      const m = /^\s*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/.exec(l);
      if (m?.[1]) out.set(m[1], { version: m[2] ?? '', dev: groupDev, line: ln(i) });
    }
    return out;
  }
  if (eco === 'cargo') {
    let inDeps = false;
    let dev = false;
    let sawSection = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] ?? '';
      const sec = /^\s*\[([^\]]+)\]/.exec(l);
      if (sec?.[1]) {
        sawSection = true;
        inDeps = /dependencies/.test(sec[1]);
        dev = /dev-dependencies/.test(sec[1]);
        continue;
      }
      if (sawSection && !inDeps) continue;
      const m = /^\s*([\w-]+)\s*=\s*(?:"([^"]*)"|\{[^}]*version\s*=\s*"([^"]*)")/.exec(l);
      if (
        m?.[1] &&
        !['name', 'version', 'edition', 'authors', 'license', 'description'].includes(m[1])
      )
        out.set(m[1], { version: m[2] ?? m[3] ?? '', dev, line: ln(i) });
    }
  }
  return out;
}

/** Leading numeric components of a version spec (`^1.2.3` → [1,2,3]). */
export function versionParts(spec: string): number[] | null {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(spec);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** Semver-ish major comparison (0.x minor bumps count as major). */
export function isMajorChange(from: string, to: string): boolean {
  const a = versionParts(from);
  const b = versionParts(to);
  if (!a || !b) return false;
  if (a[0] !== b[0]) return true;
  if (a[0] === 0 && a[1] !== b[1]) return true;
  return false;
}

function compareVersions(from: string, to: string): number {
  const a = versionParts(from);
  const b = versionParts(to);
  if (!a || !b) return 0;
  for (let i = 0; i < 3; i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function diffDependencies(
  manifest: string,
  before: DependencyMap,
  after: DependencyMap,
): DependencyChange[] {
  const eco = manifestEcosystem(manifest) ?? 'other';
  const out: DependencyChange[] = [];
  for (const [name, b] of before) {
    const a = after.get(name);
    if (!a) {
      out.push({
        manifest,
        ecosystem: eco,
        name,
        change: 'removed',
        from: b.version,
        dev: b.dev,
        major: false,
        line: b.line,
      });
      continue;
    }
    if (a.version === b.version) continue;
    const cmp = compareVersions(b.version, a.version);
    out.push({
      manifest,
      ecosystem: eco,
      name,
      change: cmp > 0 ? 'upgraded' : cmp < 0 ? 'downgraded' : 'changed',
      from: b.version,
      to: a.version,
      dev: a.dev,
      major: isMajorChange(b.version, a.version),
      line: a.line,
    });
  }
  for (const [name, a] of after) {
    if (before.has(name)) continue;
    out.push({
      manifest,
      ecosystem: eco,
      name,
      change: 'added',
      to: a.version,
      dev: a.dev,
      major: false,
      line: a.line,
    });
  }
  return out;
}
