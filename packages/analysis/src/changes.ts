/**
 * analyzeChanges: turns a PR's changed files (patches and optional before/after content)
 * into structured, verifiable facts.
 */
import { extractContracts } from './contracts.ts';
import { diffDependencies, manifestEcosystem, parseDependencies } from './dependencies.ts';
import { hunkFragments, parseUnifiedDiff, type HunkFragment } from './diff.ts';
import {
  classifyConfig,
  detectLanguage,
  isDependencyManifest,
  isDocumentationPath,
  isGeneratedPath,
  isLockFile,
  isMigrationPath,
  isSchemaDefinitionPath,
  isSourceLanguage,
  isTestPath,
  isWorkflowPath,
} from './language.ts';
import { diffTableColumns, extractSchemaOperations, extractTableColumns } from './schema-ops.ts';
import { extractSymbols, extractSymbolsWithRegex } from './symbols.ts';
import type {
  AnalyzeChangesInput,
  ChangeFacts,
  ChangedFileInput,
  ConfigChange,
  Contract,
  ContractChange,
  EnvVarRef,
  ExtractedSymbol,
  FileFact,
  FileStatus,
  MigrationFact,
  PermissionChange,
  RepositoryProfileLike,
  SchemaOperation,
  SymbolChange,
  WorkflowChange,
} from './types.ts';

const STATUS_MAP: Record<string, FileStatus> = {
  added: 'added',
  removed: 'removed',
  deleted: 'removed',
  modified: 'modified',
  renamed: 'renamed',
  copied: 'copied',
  changed: 'changed',
  unchanged: 'unchanged',
};

function normalizeStatus(status: string): FileStatus {
  return STATUS_MAP[status.toLowerCase()] ?? 'modified';
}

/** Languages whose hunk header (git funcname) is useful block context for fragments. */
const HEADER_CONTEXT_LANGS = new Set([
  'proto',
  'graphql',
  'prisma',
  'typescript',
  'tsx',
  'javascript',
  'python',
  'go',
  'java',
  'kotlin',
  'ruby',
  'php',
  'csharp',
  'rust',
  'scala',
  'swift',
]);

interface Side {
  text: string;
  lineMap: number[] | null;
}

/** Joins fragments into one text (hunks separated by a blank line) with a combined line map. */
function joinFragments(frags: HunkFragment[], headers: string[], withHeaders: boolean): Side {
  const parts: string[] = [];
  const map: number[] = [];
  frags.forEach((f, idx) => {
    if (!f.text && f.lineMap.length === 0) return;
    const header = headers[idx] ?? '';
    if (withHeaders && header && !f.text.includes(header.trim())) {
      parts.push(header);
      map.push(Math.max(1, (f.lineMap[0] ?? 1) - 1));
    }
    parts.push(f.text);
    map.push(...f.lineMap);
    parts.push('');
    map.push(f.lineMap[f.lineMap.length - 1] ?? 1);
  });
  return { text: parts.join('\n'), lineMap: map };
}

function mapLine(side: Side, line: number): number {
  return side.lineMap ? (side.lineMap[line - 1] ?? line) : line;
}

// ---------------------------------------------------------------------------
// Symbol diff
// ---------------------------------------------------------------------------

function sliceLines(text: string, start: number, end: number): string {
  return text
    .split('\n')
    .slice(start - 1, end)
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function signatureWithoutName(s: ExtractedSymbol): string {
  return s.signature.split(s.name).join('\u0000');
}

function diffSymbols(
  path: string,
  lang: string,
  before: Side | null,
  after: Side | null,
  basis: 'content' | 'patch',
  changedNewLines: Set<number>,
  changedOldLines: Set<number>,
  enclosing: Set<string>,
): SymbolChange[] {
  const extract = (side: Side | null) => {
    if (!side) return [] as ExtractedSymbol[];
    const list =
      basis === 'content'
        ? extractSymbols(lang, side.text)
        : extractSymbolsWithRegex(lang, side.text);
    return list.map((s) => ({
      ...s,
      startLine: mapLine(side, s.startLine),
      endLine: mapLine(side, s.endLine),
    }));
  };
  const olds = extract(before);
  const news = extract(after);
  const oldBy = new Map(olds.map((s) => [`${s.kind}:${s.qualifiedName}`, s]));
  const newBy = new Map(news.map((s) => [`${s.kind}:${s.qualifiedName}`, s]));
  const out: SymbolChange[] = [];
  const removed: ExtractedSymbol[] = [];
  const added: ExtractedSymbol[] = [];

  for (const [key, o] of oldBy) {
    const n = newBy.get(key);
    if (!n) {
      removed.push(o);
      continue;
    }
    const signatureChanged = o.signature !== n.signature;
    let bodyChanged = false;
    if (!signatureChanged) {
      if (basis === 'content' && before && after) {
        bodyChanged =
          sliceLines(before.text, o.startLine, o.endLine) !==
          sliceLines(after.text, n.startLine, n.endLine);
      } else {
        for (let l = n.startLine; l <= n.endLine && !bodyChanged; l++)
          if (changedNewLines.has(l)) bodyChanged = true;
        for (let l = o.startLine; l <= o.endLine && !bodyChanged; l++)
          if (changedOldLines.has(l)) bodyChanged = true;
        // Containers (classes) only count when their own header changed.
        if (o.kind === 'class' || o.kind === 'interface')
          bodyChanged = bodyChanged && o.kind === 'interface';
      }
    }
    if (signatureChanged || bodyChanged) {
      out.push({
        path,
        name: n.name,
        qualifiedName: n.qualifiedName,
        kind: n.kind,
        ...(n.parent ? { parent: n.parent } : {}),
        change: 'modified',
        exported: n.exported || o.exported,
        oldSignature: o.signature,
        newSignature: n.signature,
        line: n.startLine,
        oldLine: o.startLine,
        signatureChanged,
        basis,
      });
    }
  }
  for (const [key, n] of newBy) if (!oldBy.has(key)) added.push(n);

  // Rename detection within the file: same kind, same parent, same signature modulo name.
  const usedAdded = new Set<ExtractedSymbol>();
  for (const r of removed) {
    const match = added.find(
      (a) =>
        !usedAdded.has(a) &&
        a.kind === r.kind &&
        a.parent === r.parent &&
        signatureWithoutName(a) === signatureWithoutName(r) &&
        r.kind !== 'const',
    );
    if (match) {
      usedAdded.add(match);
      out.push({
        path,
        name: match.name,
        qualifiedName: match.qualifiedName,
        kind: match.kind,
        ...(match.parent ? { parent: match.parent } : {}),
        change: 'renamed',
        exported: r.exported || match.exported,
        oldName: r.qualifiedName,
        oldSignature: r.signature,
        newSignature: match.signature,
        line: match.startLine,
        oldLine: r.startLine,
        signatureChanged: true,
        basis,
      });
      continue;
    }
    out.push({
      path,
      name: r.name,
      qualifiedName: r.qualifiedName,
      kind: r.kind,
      ...(r.parent ? { parent: r.parent } : {}),
      change: 'removed',
      exported: r.exported,
      oldSignature: r.signature,
      oldLine: r.startLine,
      signatureChanged: false,
      basis,
    });
  }
  for (const a of added) {
    if (usedAdded.has(a)) continue;
    out.push({
      path,
      name: a.name,
      qualifiedName: a.qualifiedName,
      kind: a.kind,
      ...(a.parent ? { parent: a.parent } : {}),
      change: 'added',
      exported: a.exported,
      newSignature: a.signature,
      line: a.startLine,
      signatureChanged: false,
      basis,
    });
  }
  // Patch mode: functions named in hunk headers whose body changed but whose declaration is out of view.
  if (basis === 'patch') {
    const known = new Set(out.map((s) => s.qualifiedName));
    for (const header of enclosing) {
      const syms = extractSymbolsWithRegex(lang, header);
      const s = syms[0];
      if (!s || known.has(s.qualifiedName) || newBy.has(`${s.kind}:${s.qualifiedName}`)) continue;
      known.add(s.qualifiedName);
      out.push({
        path,
        name: s.name,
        qualifiedName: s.qualifiedName,
        kind: s.kind,
        change: 'modified',
        exported: s.exported,
        oldSignature: s.signature,
        newSignature: s.signature,
        signatureChanged: false,
        basis,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Contract diff
// ---------------------------------------------------------------------------

function diffContracts(
  path: string,
  before: Side | null,
  after: Side | null,
  beforePath: string,
): ContractChange[] {
  const map = (side: Side | null, p: string): Contract[] =>
    side
      ? extractContracts(p, side.text).map((c) => ({ ...c, path, line: mapLine(side, c.line) }))
      : [];
  const olds = map(before, beforePath);
  const news = map(after, path);
  const key = (c: Contract) => `${c.kind}|${c.identifier}|${c.role}`;
  const group = (list: Contract[]) => {
    const m = new Map<string, Contract[]>();
    for (const c of list) m.set(key(c), [...(m.get(key(c)) ?? []), c]);
    return m;
  };
  const og = group(olds);
  const ng = group(news);
  const out: ContractChange[] = [];
  for (const [k, os] of og) {
    const o = os[0] as Contract;
    const ns = ng.get(k);
    if (!ns) {
      out.push({
        kind: o.kind,
        identifier: o.identifier,
        role: o.role,
        path,
        change: 'removed',
        oldLine: o.line,
        ...(o.signature ? { oldSignature: o.signature } : {}),
        ...(o.source ? { source: o.source } : {}),
      });
      continue;
    }
    const n = ns[0] as Contract;
    if ((o.signature ?? '') !== (n.signature ?? '')) {
      out.push({
        kind: n.kind,
        identifier: n.identifier,
        role: n.role,
        path,
        change: 'modified',
        line: n.line,
        oldLine: o.line,
        oldSignature: o.signature ?? '',
        newSignature: n.signature ?? '',
        ...(n.source ? { source: n.source } : {}),
      });
    }
  }
  for (const [k, ns] of ng) {
    if (og.has(k)) continue;
    const n = ns[0] as Contract;
    out.push({
      kind: n.kind,
      identifier: n.identifier,
      role: n.role,
      path,
      change: 'added',
      line: n.line,
      ...(n.signature ? { newSignature: n.signature } : {}),
      ...(n.source ? { source: n.source } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Permission / auth changes
// ---------------------------------------------------------------------------

const AUTH_RE =
  /\b(?:authenticate\w*|isAuthenticated|requireAuth\w*|ensureAuth\w*|ensureLoggedIn|authMiddleware|verifyToken|verifyJwt|checkAuth\w*|passport\.authenticate|jwtAuth\w*|jwt_required|login_required|permission_required|requires_auth|PreAuthorize|Secured|RolesAllowed|UseGuards|AuthGuard|IsAuthenticated|permission_classes|authentication_classes|authorize\w*|requireRole|requirePermission|hasRole|hasAuthority|hasPermission|before_action\s+:authenticate\w*|before_action\s+:require_\w+|Depends\(\s*get_current_user\w*\)|@auth\.\w+|auth\(\)|middleware\(\s*['"]auth)/;
const AUTH_WEAKEN_RE =
  /\b(?:permitAll\(\)|AllowAny|@PermitAll|@Public\(\)|skip_before_action\s+:(?:authenticate|verify|require)\w*|csrf_exempt|@csrf_exempt|\.csrf\(\)\s*\.disable\(\)|csrf\s*\(\s*\)\s*\.disable|authentication_classes\s*=\s*\[\s*\]|permission_classes\s*=\s*\[\s*\]|withoutMiddleware\(\s*['"]auth|auth\s*:\s*false)/;

function permissionChangesFor(
  path: string,
  file: FileFact,
  lines: {
    added: { line: number; content: string }[];
    removed: { line: number; content: string }[];
  },
): PermissionChange[] {
  const out: PermissionChange[] = [];
  const isWorkflow = file.isWorkflow;
  const isCodeowners = /(?:^|\/)CODEOWNERS$/.test(path);
  const isIac = file.isConfig || /\.(?:tf|hcl)$/.test(path) || /\.ya?ml$/.test(path);
  const sourceLike = isSourceLanguage(file.language) && !file.isTest;
  for (const [change, list] of [
    ['added', lines.added],
    ['removed', lines.removed],
  ] as const) {
    for (const l of list) {
      const t = l.content.trim();
      if (!t || t.startsWith('//') || (t.startsWith('#') && !isWorkflow)) continue;
      if (isCodeowners) {
        out.push({ path, line: l.line, kind: 'codeowners', change, detail: t.slice(0, 160) });
        continue;
      }
      if (
        isWorkflow &&
        (/^permissions\s*:/.test(t) ||
          /^(?:contents|actions|packages|pull-requests|issues|id-token|deployments|security-events|statuses|checks|pages|attestations)\s*:\s*(?:write|read|none)/.test(
            t,
          ) ||
          /write-all|read-all/.test(t))
      ) {
        out.push({
          path,
          line: l.line,
          kind: 'workflow_permissions',
          change,
          detail: t.slice(0, 160),
        });
        continue;
      }
      if (
        isIac &&
        /\b(?:aws_iam_\w+|google_\w*iam\w*|azurerm_role_\w+|kind:\s*(?:Cluster)?Role(?:Binding)?|serviceAccountName|"Effect"\s*:|Effect:\s*(?:Allow|Deny)|roles\/\w+)/.test(
          t,
        )
      ) {
        out.push({ path, line: l.line, kind: 'iam', change, detail: t.slice(0, 160) });
        continue;
      }
      if (sourceLike && AUTH_WEAKEN_RE.test(t)) {
        // Adding an auth bypass is reported as an access-control change.
        out.push({ path, line: l.line, kind: 'access_control', change, detail: t.slice(0, 160) });
        continue;
      }
      if (sourceLike && AUTH_RE.test(t))
        out.push({ path, line: l.line, kind: 'auth_middleware', change, detail: t.slice(0, 160) });
    }
  }
  // Pure moves (same text removed and added) are not changes.
  const addedText = new Map<string, number>();
  for (const p of out)
    if (p.change === 'added')
      addedText.set(`${p.kind}|${p.detail}`, (addedText.get(`${p.kind}|${p.detail}`) ?? 0) + 1);
  const result: PermissionChange[] = [];
  const consumed = new Map<string, number>();
  for (const p of out) {
    if (p.change !== 'removed') continue;
    const k = `${p.kind}|${p.detail}`;
    const avail = (addedText.get(k) ?? 0) - (consumed.get(k) ?? 0);
    if (avail > 0) consumed.set(k, (consumed.get(k) ?? 0) + 1);
    else result.push(p);
  }
  const consumedAdd = new Map(consumed);
  for (const p of out) {
    if (p.change !== 'added') continue;
    const k = `${p.kind}|${p.detail}`;
    const c = consumedAdd.get(k) ?? 0;
    if (c > 0) consumedAdd.set(k, c - 1);
    else result.push(p);
  }
  return result.sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

function packageFor(path: string, profile: RepositoryProfileLike | null | undefined): string {
  const pkgs = profile?.packages ?? [];
  let best: { name: string; len: number } | null = null;
  for (const p of pkgs) {
    const prefix = p.path.replace(/^\.\/?/, '').replace(/\/+$/, '');
    if (!prefix) continue;
    if ((path === prefix || path.startsWith(`${prefix}/`)) && (!best || prefix.length > best.len))
      best = { name: p.name, len: prefix.length };
  }
  if (best) return best.name;
  const mono =
    /^((?:packages|apps|services|libs|modules|crates|plugins|components|cmd|internal)\/[^/]+)\//.exec(
      path,
    );
  if (mono?.[1]) return mono[1];
  const i = path.indexOf('/');
  return i === -1 ? '(root)' : path.slice(0, i);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function fileFact(input: ChangedFileInput): FileFact {
  const status = normalizeStatus(input.status);
  const hunks = parseUnifiedDiff(input.patch ?? null);
  const language = detectLanguage(input.path);
  const additions = input.additions ?? hunks.reduce((n, h) => n + h.added.length, 0);
  const deletions = input.deletions ?? hunks.reduce((n, h) => n + h.removed.length, 0);
  const fact: FileFact = {
    path: input.path,
    status,
    language,
    additions,
    deletions,
    hunks,
    isTest: isTestPath(input.path),
    isConfig: classifyConfig(input.path) !== null,
    isMigration: isMigrationPath(input.path),
    isWorkflow: isWorkflowPath(input.path),
    isDependencyManifest: isDependencyManifest(input.path),
    isDocumentation: isDocumentationPath(input.path),
    isGenerated: isGeneratedPath(input.path),
    contentUnavailable: !input.patch && input.before == null && input.after == null,
  };
  if (input.previousPath && input.previousPath !== input.path)
    fact.previousPath = input.previousPath;
  return fact;
}

/**
 * Analyzes a PR's changed files. When `before`/`after` contents are supplied the analysis is
 * exact (full-file symbol/contract diffs); otherwise it works from patch hunks (context +
 * changed lines). Pure and deterministic; never throws on malformed input.
 */
export function analyzeChanges(input: AnalyzeChangesInput): ChangeFacts {
  const facts: ChangeFacts = {
    repo: input.repo,
    files: [],
    touchedSymbols: [],
    contractsChanged: [],
    migrations: [],
    schemaOperations: [],
    envVarsAdded: [],
    envVarsRemoved: [],
    dependencyChanges: [],
    testsAdded: [],
    testsModified: [],
    testsRemoved: [],
    sourceFilesChanged: [],
    workflowChanges: [],
    configChanges: [],
    permissionChanges: [],
    packagesTouched: [],
    stats: { files: 0, additions: 0, deletions: 0 },
    limitations: [],
  };
  const packages = new Set<string>();
  const missingContent: string[] = [];

  // Deterministic order regardless of input order.
  const files = [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  for (const file of files) {
    const fact = fileFact(file);
    facts.files.push(fact);
    facts.stats.files++;
    facts.stats.additions += fact.additions;
    facts.stats.deletions += fact.deletions;
    packages.add(packageFor(fact.path, input.profile));
    if (fact.previousPath) packages.add(packageFor(fact.previousPath, input.profile));
    if (fact.contentUnavailable && fact.status !== 'removed' && !isLockFile(fact.path))
      missingContent.push(fact.path);

    // ---- tests / source ----
    if (fact.isTest) {
      if (fact.status === 'added') facts.testsAdded.push(fact.path);
      else if (fact.status === 'removed') facts.testsRemoved.push(fact.path);
      else facts.testsModified.push(fact.path);
    } else if (
      isSourceLanguage(fact.language) &&
      !fact.isGenerated &&
      !fact.isDocumentation &&
      fact.status !== 'removed' &&
      !fact.isMigration
    ) {
      facts.sourceFilesChanged.push(fact.path);
    }

    // ---- sides ----
    const hasContent = file.before != null || file.after != null;
    const basis: 'content' | 'patch' = hasContent ? 'content' : 'patch';
    let before: Side | null = null;
    let after: Side | null = null;
    const headers = fact.hunks.map((h) => h.header);
    const frags = hunkFragments(fact.hunks);
    if (hasContent) {
      before =
        fact.status === 'added'
          ? null
          : file.before != null
            ? { text: file.before, lineMap: null }
            : null;
      after =
        fact.status === 'removed'
          ? null
          : file.after != null
            ? { text: file.after, lineMap: null }
            : null;
      // Only one side known: fall back to fragments for the other side.
      if (!before && fact.status !== 'added' && fact.hunks.length > 0)
        before = joinFragments(frags.old, headers, HEADER_CONTEXT_LANGS.has(fact.language));
      if (!after && fact.status !== 'removed' && fact.hunks.length > 0)
        after = joinFragments(frags.new, headers, HEADER_CONTEXT_LANGS.has(fact.language));
    } else if (fact.hunks.length > 0) {
      const withHeaders = HEADER_CONTEXT_LANGS.has(fact.language);
      before = fact.status === 'added' ? null : joinFragments(frags.old, headers, withHeaders);
      after = fact.status === 'removed' ? null : joinFragments(frags.new, headers, withHeaders);
    }
    const added = fact.hunks.flatMap((h) => h.added);
    const removed = fact.hunks.flatMap((h) => h.removed);
    const changedNew = new Set(added.map((l) => l.line));
    const changedOld = new Set(removed.map((l) => l.line));
    const enclosing = new Set(fact.hunks.map((h) => h.header).filter(Boolean));
    // Content-mode whole-file adds/removes without patch: treat every line as changed.
    const addedLines =
      added.length > 0 || !after || before
        ? added
        : after.text.split('\n').map((content, i) => ({ line: i + 1, content }));
    const removedLines =
      removed.length > 0 || !before || after
        ? removed
        : before.text.split('\n').map((content, i) => ({ line: i + 1, content }));

    // ---- symbols ----
    if (!fact.isTest && !fact.isGenerated && isSourceLanguage(fact.language) && (before || after)) {
      facts.touchedSymbols.push(
        ...diffSymbols(
          fact.path,
          fact.language,
          before,
          after,
          basis,
          changedNew,
          changedOld,
          basis === 'patch' ? enclosing : new Set(),
        ),
      );
    }

    // ---- contracts ----
    if (!fact.isTest && !fact.isGenerated && (before || after)) {
      const contractChanges = diffContracts(
        fact.path,
        before,
        after,
        fact.previousPath ?? fact.path,
      );
      for (const cc of contractChanges) {
        if (cc.kind === 'env_var') {
          const ref: EnvVarRef = {
            name: cc.identifier,
            path: fact.path,
            line: cc.line ?? cc.oldLine ?? 1,
            role: cc.role,
            ...(cc.line === undefined && cc.oldLine !== undefined ? { side: 'base' as const } : {}),
          };
          if (cc.change === 'added') facts.envVarsAdded.push(ref);
          else if (cc.change === 'removed') facts.envVarsRemoved.push(ref);
        }
      }
      facts.contractsChanged.push(...contractChanges);
    }

    // ---- migrations & schema ----
    if (fact.isMigration) {
      let ops: SchemaOperation[];
      if (fact.status === 'removed') ops = [];
      else if (addedLines.length > 0) {
        ops = extractSchemaOperations(
          fact.path,
          addedLines.map((l) => l.content).join('\n'),
          addedLines.map((l) => l.line),
        );
      } else ops = [];
      const mig: MigrationFact = { path: fact.path, status: fact.status, operations: ops };
      facts.migrations.push(mig);
      facts.schemaOperations.push(...ops);
    } else if (isSchemaDefinitionPath(fact.path) && (before || after)) {
      const b = before
        ? extractTableColumns(
            fact.previousPath ?? fact.path,
            before.text,
            before.lineMap ?? undefined,
          )
        : new Map();
      const a = after
        ? extractTableColumns(fact.path, after.text, after.lineMap ?? undefined)
        : new Map();
      // In patch mode tables not visible on one side are unknown, not dropped.
      if (basis === 'patch') {
        for (const t of [...b.keys()]) if (!a.has(t)) b.delete(t);
        for (const t of [...a.keys()]) if (!b.has(t) && fact.status !== 'added') a.delete(t);
      }
      const source =
        fact.language === 'prisma' ? 'prisma' : fact.language === 'python' ? 'django' : 'drizzle';
      facts.schemaOperations.push(...diffTableColumns(fact.path, b, a, source));
    }

    // ---- dependencies ----
    if (fact.isDependencyManifest && manifestEcosystem(fact.path) && (before || after)) {
      const b = before
        ? parseDependencies(fact.path, before.text, before.lineMap ?? undefined)
        : new Map();
      const a = after
        ? parseDependencies(fact.path, after.text, after.lineMap ?? undefined)
        : new Map();
      facts.dependencyChanges.push(...diffDependencies(fact.path, b, a));
    }

    // ---- workflows & config ----
    if (fact.isWorkflow) {
      const notes = new Set<string>();
      for (const l of addedLines) {
        const t = l.content;
        if (/pull_request_target/.test(t)) notes.add('pull_request_target trigger');
        if (/workflow_run/.test(t)) notes.add('workflow_run trigger');
        if (/permissions\s*:/.test(t) || /write-all/.test(t)) notes.add('permissions changed');
        if (/\$\{\{\s*secrets\./.test(t)) notes.add('uses secrets');
        if (/runs-on:\s*.*self-hosted/.test(t)) notes.add('self-hosted runner');
        if (/\bdeploy|release|publish\b/i.test(t)) notes.add('deployment/release step');
      }
      const wc: WorkflowChange = { path: fact.path, status: fact.status, notes: [...notes].sort() };
      facts.workflowChanges.push(wc);
    }
    const cfg = classifyConfig(fact.path);
    if (cfg && !fact.isWorkflow) {
      const cc: ConfigChange = {
        path: fact.path,
        status: fact.status,
        kind: cfg.kind,
        infrastructure: cfg.infrastructure,
      };
      facts.configChanges.push(cc);
    }

    // ---- permissions ----
    facts.permissionChanges.push(
      ...permissionChangesFor(fact.path, fact, { added: addedLines, removed: removedLines }),
    );
  }

  // Env vars moved between files are not additions/removals.
  const addedNames = new Set(facts.envVarsAdded.map((e) => `${e.name}|${e.role}`));
  const removedNames = new Set(facts.envVarsRemoved.map((e) => `${e.name}|${e.role}`));
  facts.envVarsAdded = facts.envVarsAdded.filter((e) => !removedNames.has(`${e.name}|${e.role}`));
  facts.envVarsRemoved = facts.envVarsRemoved.filter((e) => !addedNames.has(`${e.name}|${e.role}`));

  facts.packagesTouched = [...packages].sort();
  if (missingContent.length > 0) {
    const sample = missingContent.slice(0, 5).join(', ');
    facts.limitations.push(
      `No diff available for ${missingContent.length} file(s) (binary or too large): ${sample}${missingContent.length > 5 ? ', …' : ''}`,
    );
  }
  const unknownLang = facts.files.filter(
    (f) => f.language === 'unknown' && !f.isGenerated && f.status !== 'removed',
  ).length;
  if (unknownLang > 0)
    facts.limitations.push(
      `${unknownLang} file(s) in unrecognized formats were only analysed by path.`,
    );
  if (
    facts.files.some((f) => !f.contentUnavailable && f.hunks.length > 0) &&
    files.every((f) => f.before == null && f.after == null)
  ) {
    facts.limitations.push(
      'Analysis based on diff hunks only (full file contents not provided); symbol and contract changes outside the visible diff context may be missed.',
    );
  }
  return facts;
}
