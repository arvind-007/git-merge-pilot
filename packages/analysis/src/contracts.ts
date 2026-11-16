/**
 * Contract extraction: HTTP routes (provider) and HTTP client calls (consumer), GraphQL
 * schema types/fields, protobuf services/messages/fields, env var reads/definitions,
 * database tables (DDL, ORM models, migrations, SQL usage) and queue/topic/event literals.
 *
 * Extraction is literal and line-oriented: dynamic routes, computed names and framework
 * magic beyond the common patterns are out of scope (see design §16).
 */
import type { ContractKind, ContractRole } from '@gmp/core';
import { detectLanguage } from './language.ts';
import type { Contract } from './types.ts';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

// ---------------------------------------------------------------------------
// Route normalization & matching
// ---------------------------------------------------------------------------

/**
 * Normalizes an HTTP path for matching: strips origin, query and hash; converts every
 * parameter syntax (`:id`, `{id}`, `<int:id>`, `[id]`, `${expr}`, `(?P<id>...)`) to `:param`;
 * collapses slashes and drops the trailing slash. Returns null for non-path input.
 */
export function normalizeRoutePath(raw: string): string | null {
  let p = raw.trim();
  if (!p) return null;
  // Django regex routes
  p = p.replace(/^\^/, '').replace(/\$$/, '');
  p = p.replace(/\(\?P<\w+>[^)]*\)/g, ':param');
  // Leading interpolation of a base URL: `${API_URL}/users`, `{base}/users`
  p = p.replace(/^\$\{[^}]*\}(?=\/)/, '').replace(/^\{[^}]*\}(?=\/)/, '');
  p = p.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  if (/^\$\{[^}]*\}$/.test(p)) return null;
  p = p.replace(/[?#].*$/, '');
  p = p.replace(/\$\{[^}]*\}/g, ':param');
  p = p.replace(/\{[^}]*\}/g, ':param');
  p = p.replace(/<(?:[\w]+:)?\w+>/g, ':param');
  p = p.replace(/\[\[?\.{0,3}[\w-]+\]?\]/g, ':param');
  p = p.replace(/:[A-Za-z_][\w-]*\??/g, ':param');
  p = p.replace(/\*+$/, ':param');
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  if (/\s/.test(p)) return null;
  return p;
}

export function routeIdentifier(method: string, path: string): string {
  const m = method.toUpperCase();
  return `${HTTP_METHODS.has(m) ? m : 'ANY'} ${path}`;
}

function joinPaths(prefix: string, path: string): string {
  if (!prefix) return path;
  if (!path) return prefix;
  return `${prefix.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Splits `METHOD /path` identifiers. */
export function parseRouteIdentifier(id: string): { method: string; path: string } | null {
  const m = /^([A-Z]+) (\/\S*)$/.exec(id);
  return m ? { method: m[1] ?? 'ANY', path: m[2] ?? '/' } : null;
}

/**
 * Compares two contract identifiers of the same kind. Returns `exact` for identical
 * identifiers (HTTP: same path and compatible method), `suffix` when one HTTP path is a
 * suffix of the other with at least two static segments (mount prefixes), else null.
 */
export function matchContractIdentifiers(
  kind: ContractKind,
  a: string,
  b: string,
): 'exact' | 'suffix' | null {
  if (kind !== 'http_route') return a.toLowerCase() === b.toLowerCase() ? 'exact' : null;
  const ra = parseRouteIdentifier(a);
  const rb = parseRouteIdentifier(b);
  if (!ra || !rb) return a === b ? 'exact' : null;
  const methodOk = ra.method === rb.method || ra.method === 'ANY' || rb.method === 'ANY';
  if (!methodOk) return null;
  if (ra.path === rb.path) return 'exact';
  const [shorter, longer] =
    ra.path.length <= rb.path.length ? [ra.path, rb.path] : [rb.path, ra.path];
  const staticSegments = shorter.split('/').filter((s) => s && s !== ':param').length;
  if (
    staticSegments >= 2 &&
    longer.endsWith(shorter) &&
    longer[longer.length - shorter.length - 1] !== undefined
  ) {
    const boundary = longer[longer.length - shorter.length];
    if (boundary === '/') return 'suffix';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Line helpers
// ---------------------------------------------------------------------------

interface Line {
  n: number;
  text: string;
}

function codeLines(source: string, lang: string): Line[] {
  const raw = source.split('\n');
  const out: Line[] = [];
  let inBlock = false;
  const hashComments = [
    'python',
    'ruby',
    'yaml',
    'shell',
    'dotenv',
    'dockerfile',
    'toml',
    'terraform',
    'graphql',
    'r',
    'elixir',
  ].includes(lang);
  const dashComments = lang === 'sql';
  for (let i = 0; i < raw.length; i++) {
    const text = (raw[i] ?? '').replace(/\r$/, '');
    const t = text.trim();
    if (inBlock) {
      if (t.includes('*/')) inBlock = false;
      continue;
    }
    if (lang !== 'python' && t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock = true;
      continue;
    }
    if (t.startsWith('//') || (t.startsWith('*') && !t.startsWith('*/') && lang !== 'graphql'))
      continue;
    if (hashComments && t.startsWith('#')) continue;
    if (dashComments && t.startsWith('--')) continue;
    out.push({ n: i + 1, text });
  }
  return out;
}

class Collector {
  readonly items: Contract[] = [];
  private readonly seen = new Set<string>();
  constructor(private readonly path: string) {}
  add(
    kind: ContractKind,
    identifier: string,
    role: ContractRole,
    line: number,
    extra?: { signature?: string; source?: string },
  ): void {
    if (!identifier) return;
    const key = `${kind}|${identifier}|${role}|${line}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const c: Contract = { kind, identifier, role, path: this.path, line };
    if (extra?.signature) c.signature = extra.signature;
    if (extra?.source) c.source = extra.source;
    this.items.push(c);
  }
  route(method: string, rawPath: string, role: ContractRole, line: number, source: string): void {
    const p = normalizeRoutePath(rawPath);
    if (!p) return;
    if (role === 'consumer' && p === '/') return; // origin-only URLs carry no route
    this.add('http_route', routeIdentifier(method, p), role, line, { source });
  }
}

/** Extracts string literal contents from a line ('...', "...", `...`). */
function stringLiterals(text: string): string[] {
  const out: string[] = [];
  const re = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[2] ?? '');
  return out;
}

/** Text of the first call's argument list at/after `from`, up to the matching `)`. */
function callSpan(text: string, from: number): string {
  const open = text.indexOf('(', from);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

/** `'/users/' + id` → `/users/:param` (a literal ending in `/` followed by concatenation). */
function withConcatParam(url: string, text: string, end: number): string {
  return url.endsWith('/') && /^\s*\+/.test(text.slice(end)) ? `${url}:param` : url;
}

function lookahead(lines: Line[], i: number, count: number): string {
  return lines
    .slice(i, i + count)
    .map((l) => l.text)
    .join('\n');
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const CLIENT_RECEIVER =
  /^(?:axios|http|https|httpClient|\$http|client|apiClient|request|superagent|got|ky|ofetch|\$fetch|agent|needle|wretch|fetcher|restClient|webClient|httpService|requests|httpx|session|aiohttp|\w+Client|\w+Api|\w+API)$/;
const SERVER_RECEIVER =
  /^(?:app|router|server|fastify|routes?|r|e|g|mux|hono|koa|express|srv|application|admin|\w+Router|\w+Routes|bp|blueprint|v\d+|group|grp|api\w*Group|\w+Group|instance)$/i;
const SERVER_HINT =
  /\b(?:express|fastify|koa|hono|@koa\/router|elysia|restify|polka|@nestjs|from ['"]h3['"])\b|Router\(\)|createServer\b/;

function extractJsHttp(lines: Line[], c: Collector, path: string, fullText: string): void {
  const serverFile = SERVER_HINT.test(fullText);
  const callRe =
    /(?:^|[^\w$])((?:[\w$]+\.)*[\w$]+)\.(get|post|put|patch|delete|del|head|options|all|route)\s*(?:<[^>]*>)?\(\s*(['"`])((?:\/|https?:\/\/|\$\{)[^'"`]*)\3/gi;
  const fetchRe =
    /(?:^|[^\w$.])(fetch|axios|ky|got|ofetch|\$fetch|useFetch|useSWR|superagent|request)\s*(?:<[^>]*>)?\(\s*(['"`])((?:\/|https?:\/\/|\$\{)[^'"`]*)\2/g;
  let nestPrefix = '';
  for (let i = 0; i < lines.length; i++) {
    const { n, text } = lines[i] as Line;
    let m: RegExpExecArray | null;
    callRe.lastIndex = 0;
    while ((m = callRe.exec(text))) {
      const receiverChain = m[1] ?? '';
      const receiver = receiverChain.split('.').pop() ?? '';
      let method = (m[2] ?? '').toUpperCase();
      if (method === 'DEL') method = 'DELETE';
      if (method === 'ALL' || method === 'ROUTE') method = 'ANY';
      const url = m[4] ?? '';
      let role: ContractRole | null = null;
      if (CLIENT_RECEIVER.test(receiver) && !/^(?:app|router)$/i.test(receiver)) role = 'consumer';
      else if (SERVER_RECEIVER.test(receiver))
        role = /^(?:api|instance)$/i.test(receiver) && !serverFile ? 'consumer' : 'provider';
      else if (serverFile && url.startsWith('/')) role = 'provider';
      if (!role) continue;
      if (role === 'provider' && !url.startsWith('/')) continue;
      c.route(
        method,
        withConcatParam(url, text, m.index + m[0].length),
        role,
        n,
        role === 'provider' ? 'js-router' : 'js-client',
      );
    }
    fetchRe.lastIndex = 0;
    while ((m = fetchRe.exec(text))) {
      const ahead = lookahead(lines, i, 8);
      const mm = /method\s*:\s*['"`](\w+)['"`]/i.exec(
        callSpan(ahead, Math.max(0, ahead.indexOf(m[0]))),
      );
      c.route(
        mm?.[1] ?? 'GET',
        withConcatParam(m[3] ?? '', text, m.index + m[0].length),
        'consumer',
        n,
        'fetch',
      );
    }
    // Fastify route({ method, url })
    if (/\.route\(\s*\{/.test(text)) {
      const ahead = lookahead(lines, i, 8);
      const um = /\b(?:url|path)\s*:\s*['"`](\/[^'"`]*)['"`]/.exec(ahead);
      const mm = /\bmethod\s*:\s*(\[[^\]]*\]|['"`]\w+['"`])/.exec(ahead);
      if (um?.[1]) {
        const methods = mm?.[1]
          ? [...mm[1].matchAll(/['"`](\w+)['"`]/g)].map((x) => x[1] ?? 'ANY')
          : ['ANY'];
        for (const meth of methods) c.route(meth, um[1], 'provider', n, 'fastify');
      }
    }
    // NestJS
    const ctrl = /@Controller\(\s*(?:\{[^}]*\bpath\s*:\s*)?(?:['"`]([^'"`]*)['"`])?/.exec(text);
    if (ctrl) nestPrefix = ctrl[1] ?? '';
    const nest =
      /@(Get|Post|Put|Patch|Delete|Head|Options|All)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/.exec(text);
    if (nest)
      c.route(
        nest[1] === 'All' ? 'ANY' : (nest[1] ?? 'ANY'),
        joinPaths(`/${nestPrefix}`, nest[2] ?? ''),
        'provider',
        n,
        'nestjs',
      );
  }
  // Next.js app router / pages API routes
  const appRoute = /(?:^|\/)app\/(.*?)\/?route\.(?:[cm]?[jt]sx?)$/.exec(path);
  if (appRoute) {
    const segs = (appRoute[1] ?? '')
      .split('/')
      .filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@'));
    const routePath = `/${segs.join('/')}`;
    for (const { n, text } of lines) {
      const m =
        /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.exec(
          text,
        );
      if (m?.[1]) c.route(m[1], routePath, 'provider', n, 'nextjs');
    }
  }
  const pagesApi = /(?:^|\/)pages\/(api\/.*)\.(?:[cm]?[jt]sx?)$/.exec(path);
  if (pagesApi?.[1]) {
    const route = `/${pagesApi[1].replace(/\/index$/, '')}`;
    const line = lines.find((l) => /export\s+default/.test(l.text))?.n ?? 1;
    c.route('ANY', route, 'provider', line, 'nextjs');
  }
}

function extractPythonHttp(lines: Line[], c: Collector, path: string): void {
  const prefixes = new Map<string, string>();
  for (const { text } of lines) {
    const m = /^\s*(\w+)\s*=\s*(?:\w+\.)?(APIRouter|Blueprint)\((.*)$/.exec(text);
    if (m?.[1]) {
      const pm = /\b(?:prefix|url_prefix)\s*=\s*['"]([^'"]*)['"]/.exec(m[3] ?? '');
      prefixes.set(m[1], pm?.[1] ?? '');
    }
  }
  const isUrlsPy = /(?:^|\/)urls\.py$/.test(path);
  for (let i = 0; i < lines.length; i++) {
    const { n, text } = lines[i] as Line;
    const deco =
      /^\s*@\s*([\w.]+)\.(get|post|put|patch|delete|head|options|route|api_route|websocket)\(\s*[rbuf]?(['"])([^'"]*)\3(.*)$/i.exec(
        text,
      );
    if (deco) {
      const recv = (deco[1] ?? '').split('.').pop() ?? '';
      const prefix = prefixes.get(recv) ?? '';
      const kind = (deco[2] ?? '').toLowerCase();
      const routePath = joinPaths(prefix, deco[4] ?? '');
      if (kind === 'route' || kind === 'api_route') {
        const rest = `${deco[5] ?? ''}\n${lookahead(lines, i + 1, 2)}`;
        const methods = /methods\s*=\s*[[(]([^\])]*)[\])]/.exec(rest);
        const list = methods?.[1]
          ? [...methods[1].matchAll(/['"](\w+)['"]/g)].map((x) => x[1] ?? 'GET')
          : ['GET'];
        for (const meth of list) c.route(meth, routePath, 'provider', n, 'flask');
      } else if (kind === 'websocket') {
        c.route('GET', routePath, 'provider', n, 'fastapi');
      } else {
        c.route(kind, routePath, 'provider', n, 'python-web');
      }
      continue;
    }
    if (isUrlsPy) {
      const dj = /\b(?:path|re_path|url)\(\s*r?(['"])([^'"]*)\1/.exec(text);
      if (dj && !/\binclude\(/.test(text)) c.route('ANY', dj[2] ?? '', 'provider', n, 'django');
    }
    const client =
      /\b(requests|httpx|session|client|aiohttp|http|self\.client|self\.session)\.(get|post|put|patch|delete|head|options)\(\s*f?(['"])((?:\/|https?:\/\/|\{)[^'"]*)\3/.exec(
        text,
      );
    if (client) c.route(client[2] ?? 'GET', client[4] ?? '', 'consumer', n, 'python-client');
  }
}

function extractGoHttp(lines: Line[], c: Collector): void {
  const groups = new Map<string, string>();
  for (const { n, text } of lines) {
    const g = /(\w+)\s*:?=\s*(\w+)\.Group\(\s*"([^"]*)"/.exec(text);
    if (g?.[1]) {
      groups.set(g[1], joinPaths(groups.get(g[2] ?? '') ?? '', g[3] ?? ''));
      continue;
    }
    const m =
      /\b(\w+)\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any|Get|Post|Put|Patch|Delete|Head|Options|Handle|HandleFunc|Route|Method|Static)\(\s*"([^"]*)"/.exec(
        text,
      );
    if (m?.[1]) {
      const recv = m[1];
      const fn = m[2] ?? '';
      const arg = m[3] ?? '';
      const isClient = (recv === 'http' && /^(?:Get|Post|Head)$/.test(fn)) || /client$/i.test(recv);
      if (isClient) {
        if (/^https?:\/\/|^\//.test(arg)) c.route(fn, arg, 'consumer', n, 'go-client');
        continue;
      }
      if (fn === 'Static' || fn === 'Method') continue;
      let method = fn.toUpperCase();
      let routePath = arg;
      if (fn === 'Handle' || fn === 'HandleFunc') {
        const split = /^([A-Z]+)\s+(\/.*)$/.exec(arg); // Go 1.22 "GET /x"
        if (split) {
          method = split[1] ?? 'ANY';
          routePath = split[2] ?? '/';
        } else {
          const mm = /\.Methods\(\s*"(\w+)"/.exec(text);
          method = mm?.[1] ?? 'ANY';
        }
      }
      if (method === 'ROUTE' || method === 'ANY') method = 'ANY';
      if (!routePath.startsWith('/')) continue;
      c.route(method, joinPaths(groups.get(recv) ?? '', routePath), 'provider', n, 'go-router');
      continue;
    }
    const req =
      /http\.NewRequest(?:WithContext)?\(\s*(?:\w+\s*,\s*)?(?:http\.Method(\w+)|"(\w+)")\s*,\s*"([^"]+)"/.exec(
        text,
      );
    if (req) c.route(req[1] ?? req[2] ?? 'GET', req[3] ?? '', 'consumer', n, 'go-client');
  }
}

function annotationArgsPaths(args: string): string[] {
  const named = /\b(?:value|path)\s*=\s*(\{[^}]*\}|"[^"]*")/.exec(args);
  const src = named?.[1] ?? args;
  const paths = [...src.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? '');
  return paths.length ? paths : [''];
}

function extractJvmHttp(lines: Line[], c: Collector, fullText: string): void {
  const role: ContractRole = /@FeignClient\b/.test(fullText) ? 'consumer' : 'provider';
  let classPrefix = '';
  let pending: string[] = [];
  let seenClass = false;
  for (let i = 0; i < lines.length; i++) {
    const { n, text } = lines[i] as Line;
    // Collect annotations (possibly several on one line, possibly multi-line args).
    let rest = text.trim();
    while (rest.startsWith('@')) {
      const m = /^@([\w.]+)\s*/.exec(rest);
      if (!m) break;
      let ann = m[0];
      rest = rest.slice(m[0].length);
      if (rest.startsWith('(')) {
        let depth = 0;
        let j = 0;
        let buf = rest;
        let k = i;
        for (;;) {
          for (; j < buf.length; j++) {
            if (buf[j] === '(') depth++;
            else if (buf[j] === ')') {
              depth--;
              if (depth === 0) break;
            }
          }
          if (depth === 0 || k + 1 >= lines.length || k > i + 10) break;
          k++;
          buf += ` ${(lines[k] as Line).text.trim()}`;
        }
        ann += buf.slice(0, j + 1);
        rest = buf.slice(j + 1).trim();
        i = k;
      }
      pending.push(ann.trim());
    }
    if (!rest) continue;
    const isClass = /\b(?:class|interface|record|object)\s+\w+/.test(rest);
    if (isClass && !seenClass) {
      seenClass = true;
      for (const a of pending) {
        const m = /^@(?:RequestMapping|Path)\s*(?:\((.*)\))?$/s.exec(a);
        if (m) classPrefix = annotationArgsPaths(m[1] ?? '')[0] ?? '';
      }
      pending = [];
      continue;
    }
    if (pending.length > 0) {
      let jaxMethod: string | null = null;
      let jaxPath = '';
      for (const a of pending) {
        const sm = /^@(Get|Post|Put|Patch|Delete)Mapping\s*(?:\((.*)\))?$/s.exec(a);
        if (sm) {
          for (const p of annotationArgsPaths(sm[2] ?? ''))
            c.route(sm[1] ?? 'ANY', joinPaths(classPrefix, p), role, n, 'spring');
          continue;
        }
        const rm = /^@RequestMapping\s*(?:\((.*)\))?$/s.exec(a);
        if (rm) {
          const args = rm[1] ?? '';
          const methods = [...args.matchAll(/RequestMethod\.(\w+)/g)].map((x) => x[1] ?? 'ANY');
          for (const p of annotationArgsPaths(args))
            for (const meth of methods.length ? methods : ['ANY'])
              c.route(meth, joinPaths(classPrefix, p), role, n, 'spring');
          continue;
        }
        const jm = /^@(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.exec(a);
        if (jm) jaxMethod = jm[1] ?? null;
        const jp = /^@Path\s*\((.*)\)$/s.exec(a);
        if (jp) jaxPath = annotationArgsPaths(jp[1] ?? '')[0] ?? '';
      }
      if (jaxMethod) c.route(jaxMethod, joinPaths(classPrefix, jaxPath), 'provider', n, 'jax-rs');
      pending = [];
    }
    const rt =
      /\b\w*[rR]estTemplate\.(getForObject|getForEntity|postForObject|postForEntity|postForLocation|put|delete|patchForObject|exchange)\(\s*"([^"]+)"/.exec(
        rest,
      );
    if (rt) {
      const fn = rt[1] ?? '';
      const meth = fn.startsWith('get')
        ? 'GET'
        : fn.startsWith('post')
          ? 'POST'
          : fn.startsWith('patch')
            ? 'PATCH'
            : fn === 'put'
              ? 'PUT'
              : fn === 'delete'
                ? 'DELETE'
                : 'ANY';
      c.route(meth, rt[2] ?? '', 'consumer', n, 'resttemplate');
    }
    const wc = /\.(get|post|put|patch|delete)\(\)\s*\.uri\(\s*"([^"]+)"/.exec(rest);
    if (wc) c.route(wc[1] ?? 'GET', wc[2] ?? '', 'consumer', n, 'webclient');
    const uri = /URI\.create\(\s*"((?:https?:\/\/)[^"]+)"/.exec(rest);
    if (uri && !wc) c.route('ANY', uri[1] ?? '', 'consumer', n, 'java-http');
  }
}

function extractRubyPhpHttp(lines: Line[], c: Collector, path: string, lang: string): void {
  const routesRb = /(?:^|\/)config\/routes(?:\/[^/]+)?\.rb$/.test(path);
  for (const { n, text } of lines) {
    if (lang === 'ruby') {
      if (routesRb) {
        const r = /^\s*(get|post|put|patch|delete|match)\s+['"]([^'"]+)['"]/.exec(text);
        if (r)
          c.route(r[1] === 'match' ? 'ANY' : (r[1] ?? 'ANY'), r[2] ?? '', 'provider', n, 'rails');
        const res = /^\s*resources?\s+:(\w+)/.exec(text);
        if (res?.[1]) c.route('ANY', `/${res[1]}`, 'provider', n, 'rails');
      }
      const cl =
        /\b(?:Net::HTTP|HTTParty|Faraday|RestClient|HTTP)\.(get|post|put|patch|delete)\(\s*['"]((?:https?:\/\/|\/)[^'"]*)['"]/.exec(
          text,
        );
      if (cl) c.route(cl[1] ?? 'GET', cl[2] ?? '', 'consumer', n, 'ruby-client');
    } else if (lang === 'php') {
      const r = /Route::(get|post|put|patch|delete|any|options)\(\s*['"]([^'"]*)['"]/.exec(text);
      if (r)
        c.route(r[1] === 'any' ? 'ANY' : (r[1] ?? 'ANY'), r[2] ?? '', 'provider', n, 'laravel');
      const h = /Http::(get|post|put|patch|delete)\(\s*['"]((?:https?:\/\/|\/)[^'"]*)['"]/.exec(
        text,
      );
      if (h) c.route(h[1] ?? 'GET', h[2] ?? '', 'consumer', n, 'laravel-http');
      const g = /->request\(\s*['"](\w+)['"]\s*,\s*['"]((?:https?:\/\/|\/)[^'"]*)['"]/.exec(text);
      if (g) c.route(g[1] ?? 'GET', g[2] ?? '', 'consumer', n, 'guzzle');
    }
  }
}

// ---------------------------------------------------------------------------
// GraphQL & proto
// ---------------------------------------------------------------------------

function extractGraphqlText(text: string, lineOffset: number, c: Collector): void {
  const lines = text.split('\n');
  let current: { name: string; kind: string } | null = null;
  let pendingField: { name: string; line: number; buf: string } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? '').replace(/#.*$/, '');
    const n = i + 1 + lineOffset;
    if (pendingField) {
      pendingField.buf += ` ${raw.trim()}`;
      const done = /\)\s*:\s*([^\s@{}]+)/.exec(pendingField.buf);
      if (done && current) {
        c.add('graphql', `${current.name}.${pendingField.name}`, 'provider', pendingField.line, {
          signature: normalizeGqlField(pendingField.buf),
          source: 'graphql',
        });
        pendingField = null;
      }
      if (raw.includes('}') && !raw.includes('{')) current = null;
      continue;
    }
    const decl =
      /^\s*(?:extend\s+)?(type|input|interface|enum|union|scalar)\s+(\w+)([^{]*)(\{)?/.exec(raw);
    if (decl?.[2]) {
      const kind = decl[1] ?? 'type';
      c.add('graphql', decl[2], 'provider', n, {
        signature: `${kind}${(decl[3] ?? '').replace(/\s+/g, ' ').trimEnd()}`,
        source: 'graphql',
      });
      current = decl[4] ? { name: decl[2], kind } : null;
      // single-line block e.g. `enum A { X Y }`
      if (current && raw.includes('}')) current = null;
      continue;
    }
    if (!current) {
      if (/^\s*\{/.test(raw)) continue;
      continue;
    }
    if (/^\s*\}/.test(raw)) {
      current = null;
      continue;
    }
    if (current.kind === 'enum') {
      const v = /^\s*([A-Za-z_]\w*)\b/.exec(raw);
      if (v?.[1])
        c.add('graphql', `${current.name}.${v[1]}`, 'provider', n, {
          signature: 'enum value',
          source: 'graphql',
        });
      continue;
    }
    const field = /^\s*(\w+)\s*(\(.*)?(?::\s*([^\s@]+))?/.exec(raw);
    if (field?.[1]) {
      const args = field[2] ?? '';
      if (args && !/\)\s*:/.test(args)) {
        pendingField = { name: field[1], line: n, buf: raw.trim() };
        continue;
      }
      if (!field[3] && !args) continue;
      c.add('graphql', `${current.name}.${field[1]}`, 'provider', n, {
        signature: normalizeGqlField(raw),
        source: 'graphql',
      });
    }
    if (raw.includes('}')) current = null;
  }
}

function normalizeGqlField(text: string): string {
  return text
    .replace(/^\s*\w+/, '')
    .replace(/@\w+(?:\([^)]*\))?/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),:!\][])\s*/g, '$1')
    .replace(/[},]+$/, '')
    .trim();
}

function extractGraphqlInCode(source: string, c: Collector): void {
  const re = /\b(?:gql|graphql)\s*(?:\(\s*)?`([^`]*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const before = source.slice(0, m.index + m[0].indexOf('`') + 1);
    const lineOffset = before.split('\n').length - 1;
    if (/\b(?:type|input|interface|enum|union|scalar)\s+\w+/.test(m[1] ?? ''))
      extractGraphqlText(m[1] ?? '', lineOffset, c);
  }
}

function extractProto(lines: Line[], c: Collector): void {
  let pkg = '';
  const stack: Array<{ kind: 'message' | 'enum' | 'service' | 'oneof' | 'other'; name: string }> =
    [];
  const qual = (name: string) => {
    const names = stack
      .filter((s) => s.kind === 'message' || s.kind === 'enum' || s.kind === 'service')
      .map((s) => s.name);
    return [pkg, ...names, name].filter(Boolean).join('.');
  };
  for (const { n, text } of lines) {
    const t = text.replace(/\/\/.*$/, '');
    const p = /^\s*package\s+([\w.]+)\s*;/.exec(t);
    if (p?.[1]) {
      pkg = p[1];
      continue;
    }
    const block = /^\s*(message|enum|service|oneof|extend)\s+([\w.]+)\s*\{/.exec(t);
    if (block?.[2]) {
      const kind = block[1] as 'message' | 'enum' | 'service' | 'oneof' | 'extend';
      if (kind === 'message' || kind === 'enum' || kind === 'service') {
        c.add('proto', qual(block[2]), 'provider', n, { signature: kind, source: 'proto' });
      }
      stack.push({ kind: kind === 'extend' ? 'other' : kind, name: block[2] });
      if (/\}\s*$/.test(t.slice(t.indexOf('{') + 1))) stack.pop();
      continue;
    }
    const top = [...stack].reverse().find((s) => s.kind !== 'oneof');
    const inOneof = stack[stack.length - 1]?.kind === 'oneof';
    if (top?.kind === 'service') {
      const rpc =
        /^\s*rpc\s+(\w+)\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(stream\s+)?([\w.]+)\s*\)/.exec(
          t,
        );
      if (rpc?.[1])
        c.add('proto', qual(rpc[1]), 'provider', n, {
          signature: `(${rpc[2] ?? ''}${rpc[3]}) returns (${rpc[4] ?? ''}${rpc[5]})`,
          source: 'proto',
        });
    } else if (top?.kind === 'message') {
      const f =
        /^\s*(repeated\s+|optional\s+|required\s+)?(map\s*<[^>]+>|[\w.]+)\s+(\w+)\s*=\s*(\d+)/.exec(
          t,
        );
      if (f?.[3] && !['reserved', 'option', 'extensions'].includes(f[2] ?? '')) {
        const label = (f[1] ?? '').trim();
        c.add('proto', qual(f[3]), 'provider', n, {
          signature: `${label ? `${label} ` : ''}${(f[2] ?? '').replace(/\s+/g, '')} = ${f[4]}${inOneof ? ' (oneof)' : ''}`,
          source: 'proto',
        });
      }
    } else if (top?.kind === 'enum') {
      const v = /^\s*(\w+)\s*=\s*(-?\d+)/.exec(t);
      if (v?.[1] && v[1] !== 'option')
        c.add('proto', qual(v[1]), 'provider', n, { signature: `= ${v[2]}`, source: 'proto' });
    }
    const closes = (t.match(/\}/g) ?? []).length - (t.match(/\{/g) ?? []).length;
    for (let k = 0; k < closes; k++) stack.pop();
  }
}

// ---------------------------------------------------------------------------
// Env vars
// ---------------------------------------------------------------------------

const ENV_READERS: Array<{ re: RegExp; langs: string[] | null }> = [
  {
    re: /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    langs: ['typescript', 'tsx', 'javascript', 'vue', 'svelte'],
  },
  {
    re: /\bprocess\.env\[\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\]/g,
    langs: ['typescript', 'tsx', 'javascript', 'vue', 'svelte'],
  },
  {
    re: /\bimport\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    langs: ['typescript', 'tsx', 'javascript', 'vue', 'svelte'],
  },
  {
    re: /\b(?:Deno\.env\.get|Bun\.env\.get)\(\s*['"`]([A-Za-z_][A-Za-z0-9_]*)/g,
    langs: ['typescript', 'tsx', 'javascript'],
  },
  { re: /\bBun\.env\.([A-Za-z_][A-Za-z0-9_]*)/g, langs: ['typescript', 'tsx', 'javascript'] },
  { re: /\bos\.environ\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g, langs: ['python'] },
  {
    re: /\bos\.environ\.(?:get|setdefault|pop)\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
    langs: ['python'],
  },
  {
    re: /\b(?:os\.)?getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
    langs: ['python', 'php', 'c', 'cpp'],
  },
  {
    re: /\benv(?:\.(?:str|bool|int|float|list|json|url|db_url|path))?\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
    langs: ['python', 'php'],
  },
  { re: /\bos\.(?:Getenv|LookupEnv)\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g, langs: ['go'] },
  {
    re: /\bSystem\.getenv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
    langs: ['java', 'kotlin', 'scala', 'groovy'],
  },
  { re: /\$\{([A-Z][A-Z0-9_]*)(?::[^}]*)?\}/g, langs: ['properties'] },
  { re: /\bENV\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g, langs: ['ruby', 'erb'] },
  { re: /\bENV\.fetch\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g, langs: ['ruby', 'erb'] },
  { re: /\$_(?:ENV|SERVER)\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g, langs: ['php'] },
  { re: /\benv::var(?:_os)?\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g, langs: ['rust'] },
  { re: /\benv!\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g, langs: ['rust'] },
  {
    re: /\bEnvironment\.GetEnvironmentVariable\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
    langs: ['csharp'],
  },
];

function extractEnvVars(lines: Line[], c: Collector, lang: string, path: string): void {
  if (lang === 'dotenv') {
    for (const { n, text } of lines) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(text);
      if (m?.[1]) c.add('env_var', m[1], 'provider', n, { source: 'dotenv' });
    }
    return;
  }
  if (lang === 'dockerfile') {
    for (const { n, text } of lines) {
      const m = /^\s*(ENV|ARG)\s+(.*)$/i.exec(text);
      if (!m) continue;
      const body = m[2] ?? '';
      const names = body.includes('=')
        ? [...body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=/g)].map((x) => x[1] ?? '')
        : [body.split(/\s+/)[0] ?? ''];
      for (const name of names)
        if (name) c.add('env_var', name, 'provider', n, { source: 'dockerfile' });
    }
    return;
  }
  if (lang === 'yaml') {
    let blockIndent = -1;
    for (const { n, text } of lines) {
      const indent = /^\s*/.exec(text)?.[0].length ?? 0;
      if (blockIndent >= 0 && text.trim() && indent <= blockIndent) blockIndent = -1;
      if (/^\s*(?:environment|env):\s*$/.test(text)) {
        blockIndent = indent;
        continue;
      }
      const k8s = /^\s*-\s*name:\s*['"]?([A-Z][A-Z0-9_]*)['"]?\s*$/.exec(text);
      if (k8s?.[1]) {
        c.add('env_var', k8s[1], 'provider', n, { source: 'yaml' });
        continue;
      }
      if (blockIndent >= 0) {
        const list = /^\s*-\s*['"]?([A-Z][A-Z0-9_]*)(?:=|['"]?\s*$)/.exec(text);
        const map = /^\s*['"]?([A-Z][A-Z0-9_]*)['"]?\s*:/.exec(text);
        const name = list?.[1] ?? map?.[1];
        if (name)
          c.add('env_var', name, 'provider', n, {
            source: /\.github\/workflows\//.test(path) ? 'workflow' : 'yaml',
          });
      }
    }
    return;
  }
  for (const { n, text } of lines) {
    for (const { re, langs } of ENV_READERS) {
      if (langs && !langs.includes(lang)) continue;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)))
        if (m[1]) c.add('env_var', m[1], 'consumer', n, { source: 'code' });
    }
    if (['typescript', 'tsx', 'javascript'].includes(lang)) {
      const d = /\{([^}]+)\}\s*=\s*process\.env\b/.exec(text);
      if (d?.[1]) {
        for (const part of d[1].split(',')) {
          const name = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(part)?.[1];
          if (name) c.add('env_var', name, 'consumer', n, { source: 'code' });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Database tables
// ---------------------------------------------------------------------------

const SQL_NOT_TABLES = new Set([
  'select',
  'lateral',
  'unnest',
  'dual',
  'generate_series',
  'json_each',
  'jsonb_each',
  'json_array_elements',
  'jsonb_array_elements',
  'only',
  'values',
  'set',
  'the',
  'a',
  'an',
  'information_schema',
  'pg_catalog',
  'where',
  'table',
  'if',
  'exists',
]);

/** Normalizes a table reference: strips quotes/brackets and schema, lower-cases. */
export function normalizeTableName(raw: string): string | null {
  const parts = raw
    .replace(/[`"[\]]/g, '')
    .split('.')
    .filter(Boolean);
  const name = (parts[parts.length - 1] ?? '').trim().toLowerCase();
  if (!/^[a-z_][a-z0-9_$]*$/.test(name)) return null;
  if (SQL_NOT_TABLES.has(name)) return null;
  return name;
}

const TABLE_REF = String.raw`((?:[\w$]+|"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\])(?:\.(?:[\w$]+|"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]))?)`;
const DDL_PROVIDER = new RegExp(
  String.raw`\b(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:GLOBAL\s+|LOCAL\s+)?(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?|ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?|DROP\s+(?:TABLE|VIEW)\s+(?:IF\s+EXISTS\s+)?|RENAME\s+TABLE\s+|TRUNCATE\s+(?:TABLE\s+)?)${TABLE_REF}`,
  'gi',
);
const DML_CONSUMER = new RegExp(String.raw`\b(?:FROM|JOIN|INTO|UPDATE)\s+${TABLE_REF}`, 'gi');
const DML_HINT = /\b(?:select|insert\s+into|update\s+[\w"`[\].]+\s+set|delete\s+from)\b/i;

function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function pluralize(name: string): string {
  if (/(?:s|x|z|ch|sh)$/.test(name)) return `${name}es`;
  if (/[^aeiou]y$/.test(name)) return `${name.slice(0, -1)}ies`;
  return `${name}s`;
}

function addTable(
  c: Collector,
  raw: string,
  role: ContractRole,
  line: number,
  source: string,
): void {
  const t = normalizeTableName(raw);
  if (t) c.add('db_table', t, role, line, { source });
}

function extractTables(lines: Line[], c: Collector, lang: string): void {
  if (lang === 'sql') {
    for (const { n, text } of lines) {
      DDL_PROVIDER.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = DDL_PROVIDER.exec(text))) addTable(c, m[1] ?? '', 'provider', n, 'sql');
      if (/\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|VIEW)/i.test(text)) continue;
      DML_CONSUMER.lastIndex = 0;
      while ((m = DML_CONSUMER.exec(text))) addTable(c, m[1] ?? '', 'consumer', n, 'sql');
    }
    return;
  }
  if (lang === 'prisma') {
    let model: { name: string; line: number; mapped?: string } | null = null;
    for (const { n, text } of lines) {
      const mm = /^\s*model\s+(\w+)\s*\{/.exec(text);
      if (mm?.[1]) {
        model = { name: mm[1], line: n };
        continue;
      }
      if (model) {
        const map = /@@map\(\s*(?:name\s*:\s*)?"([^"]+)"/.exec(text);
        if (map?.[1]) model.mapped = map[1];
        if (/^\s*\}/.test(text)) {
          addTable(c, model.mapped ?? model.name, 'provider', model.line, 'prisma');
          model = null;
        }
      }
    }
    return;
  }
  let djangoClass: { name: string; line: number } | null = null;
  let entityPending: number | null = null;
  for (const { n, text } of lines) {
    let m: RegExpExecArray | null;
    // DDL / DML inside string literals (raw SQL in code, TypeORM migrations, knex.raw ...)
    const literals = stringLiterals(text);
    const sqlish = literals.filter(
      (s) => /\b(?:create|alter|drop|truncate)\s+table\b/i.test(s) || DML_HINT.test(s),
    );
    // Unquoted lines inside multi-line SQL template strings (uppercase keywords only).
    if (
      /^\s*(?:CREATE TABLE|ALTER TABLE|DROP TABLE|SELECT\b|FROM\s|(?:LEFT |RIGHT |INNER |OUTER |FULL )?JOIN\s|INSERT INTO|UPDATE\s+\S+\s+SET|DELETE FROM)/.test(
        text,
      ) &&
      !/['"`]/.test(text)
    ) {
      sqlish.push(text);
    }
    for (const s of sqlish) {
      DDL_PROVIDER.lastIndex = 0;
      while ((m = DDL_PROVIDER.exec(s))) addTable(c, m[1] ?? '', 'provider', n, 'sql');
      if (/\b(?:create|alter|drop)\s+table/i.test(s)) continue;
      DML_CONSUMER.lastIndex = 0;
      while ((m = DML_CONSUMER.exec(s))) addTable(c, m[1] ?? '', 'consumer', n, 'sql');
    }
    const providers: Array<[RegExp, string]> = [
      [
        /\b(?:pgTable|mysqlTable|sqliteTable|pgView|pgMaterializedView)\(\s*['"`](\w+)['"`]/g,
        'drizzle',
      ],
      [/\bsequelize\.define\(\s*['"`](\w+)['"`]/g, 'sequelize'],
      [/\btableName\s*:\s*['"`](\w+)['"`]/g, 'sequelize'],
      [/\.createTable\(\s*['"`](\w+)['"`]/g, 'migration'],
      [/@Entity\(\s*(?:\{\s*name\s*:\s*)?['"`](\w+)['"`]/g, 'typeorm'],
      [/@Table\(\s*(?:name\s*=\s*)?"(\w+)"/g, 'jpa'],
      [/\bop\.create_table\(\s*['"](\w+)['"]/g, 'alembic'],
      [/\b__tablename__\s*=\s*['"](\w+)['"]/g, 'sqlalchemy'],
      [/\bdb_table\s*=\s*['"](\w+)['"]/g, 'django'],
      [/\bcreate_table\s*\(?\s*:?['"]?(\w+)/g, 'rails'],
      [/\bself\.table_name\s*=\s*['"](\w+)['"]/g, 'rails'],
      [/\bmigrations\.CreateModel\(\s*name\s*=\s*['"](\w+)['"]/g, 'django'],
      [/\bSchema::create\(\s*['"](\w+)['"]/g, 'laravel'],
    ];
    for (const [re, source] of providers) {
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        if (source === 'django' && re.source.includes('CreateModel'))
          addTable(c, (m[1] ?? '').toLowerCase(), 'provider', n, source);
        else addTable(c, m[1] ?? '', 'provider', n, source);
      }
    }
    const consumers: Array<[RegExp, string]> = [
      [/\b(?:knex|db|trx)\(\s*['"`](\w+)['"`]\s*\)/g, 'knex'],
      [/\.(?:from|into|table)\(\s*['"`](\w+)['"`]\s*\)/g, 'query-builder'],
      [/\bDB::table\(\s*['"](\w+)['"]/g, 'laravel'],
    ];
    for (const [re, source] of consumers) {
      re.lastIndex = 0;
      while ((m = re.exec(text))) addTable(c, m[1] ?? '', 'consumer', n, source);
    }
    // Python Django models: class X(models.Model)
    if (lang === 'python') {
      const dc = /^class\s+(\w+)\s*\(\s*(?:[\w.]*\.)?Model\s*\)/.exec(text);
      if (dc?.[1]) {
        if (djangoClass)
          addTable(c, djangoClass.name.toLowerCase(), 'provider', djangoClass.line, 'django');
        djangoClass = { name: dc[1], line: n };
      } else if (djangoClass && /\bdb_table\s*=/.test(text)) {
        djangoClass = null; // explicit db_table already recorded
      } else if (djangoClass && /^\S/.test(text) && !/^class\s/.test(text)) {
        addTable(c, djangoClass.name.toLowerCase(), 'provider', djangoClass.line, 'django');
        djangoClass = null;
      }
    }
    // Rails models: class User < ApplicationRecord
    if (lang === 'ruby') {
      const rm = /^\s*class\s+(\w+)\s*<\s*(?:ApplicationRecord|ActiveRecord::Base)\b/.exec(text);
      if (rm?.[1]) addTable(c, pluralize(snake(rm[1])), 'provider', n, 'rails');
    }
    // TypeORM/JPA @Entity() without explicit name → class name in snake case
    if (/@Entity\(\s*\)|@Entity\s*$/.test(text)) entityPending = n;
    else if (entityPending !== null) {
      const cls = /\bclass\s+(\w+)/.exec(text);
      if (cls?.[1]) {
        addTable(c, snake(cls[1]), 'provider', n, 'entity');
        entityPending = null;
      } else if (!/^\s*@/.test(text) && text.trim()) entityPending = null;
    }
  }
  if (djangoClass)
    addTable(c, djangoClass.name.toLowerCase(), 'provider', djangoClass.line, 'django');
}

// ---------------------------------------------------------------------------
// Queues, topics & events
// ---------------------------------------------------------------------------

const QUEUE_RULES: Array<{
  re: RegExp;
  role: ContractRole;
  kind: ContractKind;
  source: string;
  multi?: boolean;
}> = [
  {
    re: /@KafkaListener\(\s*(?:[^)]*?\btopics\s*=\s*)?\{?\s*((?:"[^"]+"\s*,?\s*)+)/g,
    role: 'consumer',
    kind: 'queue_topic',
    source: 'kafka',
    multi: true,
  },
  {
    re: /\bkafkaTemplate\.send\(\s*"([^"]+)"/g,
    role: 'provider',
    kind: 'queue_topic',
    source: 'kafka',
  },
  {
    re: /@RabbitListener\(\s*(?:[^)]*?\bqueues\s*=\s*)?\{?\s*((?:"[^"]+"\s*,?\s*)+)/g,
    role: 'consumer',
    kind: 'queue_topic',
    source: 'rabbitmq',
    multi: true,
  },
  {
    re: /\brabbitTemplate\.convertAndSend\(\s*"([^"]+)"/g,
    role: 'provider',
    kind: 'queue_topic',
    source: 'rabbitmq',
  },
  {
    re: /@SqsListener\(\s*(?:value\s*=\s*)?\{?\s*"([^"]+)"/g,
    role: 'consumer',
    kind: 'queue_topic',
    source: 'sqs',
  },
  {
    re: /@JmsListener\(\s*destination\s*=\s*"([^"]+)"/g,
    role: 'consumer',
    kind: 'queue_topic',
    source: 'jms',
  },
  {
    re: /\bjmsTemplate\.convertAndSend\(\s*"([^"]+)"/g,
    role: 'provider',
    kind: 'queue_topic',
    source: 'jms',
  },
  {
    re: /\.sendToQueue\(\s*['"`]([^'"`]+)['"`]/g,
    role: 'provider',
    kind: 'queue_topic',
    source: 'amqp',
  },
  {
    re: /\bchannel\.publish\(\s*['"`]([^'"`]+)['"`]/g,
    role: 'provider',
    kind: 'queue_topic',
    source: 'amqp',
  },
  {
    re: /\bchannel\.consume\(\s*['"`]([^'"`]+)['"`]/g,
    role: 'consumer',
    kind: 'queue_topic',
    source: 'amqp',
  },
  {
    re: /\bnew\s+Queue\(\s*['"`]([^'"`]+)['"`]/g,
    role: 'provider',
    kind: 'queue_topic',
    source: 'bullmq',
  },
  {
    re: /\bnew\s+Worker\(\s*['"`]([^'"`]+)['"`]/g,
    role: 'consumer',
    kind: 'queue_topic',
    source: 'bullmq',
  },
  {
    re: /@Processor\(\s*['"`]([^'"`]+)['"`]/g,
    role: 'consumer',
    kind: 'queue_topic',
    source: 'bullmq',
  },
  {
    re: /@InjectQueue\(\s*['"`]([^'"`]+)['"`]/g,
    role: 'provider',
    kind: 'queue_topic',
    source: 'bullmq',
  },
  {
    re: /\b(?:boss|pgBoss|pgboss|queue|jobs)\.(?:send|sendAfter|sendThrottled|sendDebounced|publish|insert|schedule)\(\s*['"`]([^'"`]+)['"`]/g,
    role: 'provider',
    kind: 'queue_topic',
    source: 'pg-boss',
  },
  {
    re: /\b(?:boss|pgBoss|pgboss|queue|jobs)\.(?:work|subscribe|fetch)\(\s*['"`]([^'"`]+)['"`]/g,
    role: 'consumer',
    kind: 'queue_topic',
    source: 'pg-boss',
  },
  {
    re: /\bsend_task\(\s*['"]([^'"]+)['"]/g,
    role: 'provider',
    kind: 'queue_topic',
    source: 'celery',
  },
  {
    re: /@(?:\w+\.)?(?:task|shared_task)\(\s*[^)]*?\bname\s*=\s*['"]([^'"]+)['"]/g,
    role: 'consumer',
    kind: 'queue_topic',
    source: 'celery',
  },
  {
    re: /\bKafkaConsumer\(\s*['"]([^'"]+)['"]/g,
    role: 'consumer',
    kind: 'queue_topic',
    source: 'kafka',
  },
  {
    re: /\bproducer\.(?:send|produce)\(\s*['"`]([^'"`]+)['"`]/g,
    role: 'provider',
    kind: 'queue_topic',
    source: 'kafka',
  },
  {
    re: /\bConsumePartition\(\s*"([^"]+)"/g,
    role: 'consumer',
    kind: 'queue_topic',
    source: 'kafka',
  },
  {
    re: /\.topic\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    role: 'provider',
    kind: 'queue_topic',
    source: 'pubsub',
  },
  {
    re: /\.subscription\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    role: 'consumer',
    kind: 'queue_topic',
    source: 'pubsub',
  },
  {
    re: /\b(?:nc|nats|js|jetstream|redis|pub|publisher|pubClient|redisClient)\.publish\(\s*['"`]([\w.:>*-]+)['"`]/g,
    role: 'provider',
    kind: 'queue_topic',
    source: 'pubsub',
  },
  {
    re: /\b(?:nc|nats|js|jetstream|redis|sub|subscriber|subClient|redisClient)\.(?:subscribe|psubscribe)\(\s*['"`]([\w.:>*-]+)['"`]/g,
    role: 'consumer',
    kind: 'queue_topic',
    source: 'pubsub',
  },
  {
    re: /@(?:EventPattern|MessagePattern)\(\s*['"`]([^'"`]+)['"`]/g,
    role: 'consumer',
    kind: 'event',
    source: 'nestjs',
  },
  {
    re: /\b(?:this\.)?(?:client|\w+Client)\.emit\(\s*['"`]([^'"`]+)['"`]/g,
    role: 'provider',
    kind: 'event',
    source: 'nestjs',
  },
  {
    re: /\b(?:eventBus|bus|events|emitter|eventEmitter|dispatcher|publisher)\.(?:emit|publish|dispatch)\(\s*['"`]([\w.:-]+)['"`]/g,
    role: 'provider',
    kind: 'event',
    source: 'events',
  },
  {
    re: /\b(?:eventBus|bus|events|emitter|eventEmitter|dispatcher|subscriber)\.(?:on|once|subscribe|addListener)\(\s*['"`]([\w.:-]+)['"`]/g,
    role: 'consumer',
    kind: 'event',
    source: 'events',
  },
  { re: /@OnEvent\(\s*['"`]([^'"`]+)['"`]/g, role: 'consumer', kind: 'event', source: 'nestjs' },
];

function extractQueues(lines: Line[], c: Collector): void {
  for (let i = 0; i < lines.length; i++) {
    const { n, text } = lines[i] as Line;
    for (const rule of QUEUE_RULES) {
      rule.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.re.exec(text))) {
        const names = rule.multi
          ? [...(m[1] ?? '').matchAll(/"([^"]+)"/g)].map((x) => x[1] ?? '')
          : [m[1] ?? ''];
        for (const name of names)
          if (name && !name.includes('${'))
            c.add(rule.kind, name, rule.role, n, { source: rule.source });
      }
    }
    // kafkajs: producer.send({ topic: 'x' }) / consumer.subscribe({ topic(s): ... }) / Go `Topic: "x"`
    const topic =
      /\btopics?\s*:\s*(\[[^\]]*\]|['"`][\w.:-]+['"`])/.exec(text) ??
      /\bTopic:\s*("[\w.:-]+")/.exec(text);
    if (topic?.[1]) {
      const context = lines
        .slice(Math.max(0, i - 3), i + 1)
        .map((l) => l.text)
        .join('\n');
      const isConsumer = /subscribe|consumer|Reader|GroupID|run\(/i.test(context);
      const isProducer = /\.send\(|produce|producer|Writer|Message\{/i.test(context);
      if (!isConsumer && !isProducer) continue;
      for (const x of topic[1].matchAll(/['"`]([\w.:-]+)['"`]/g)) {
        if (x[1])
          c.add('queue_topic', x[1], isConsumer ? 'consumer' : 'provider', n, { source: 'kafka' });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const CODE_LANGS = new Set([
  'typescript',
  'tsx',
  'javascript',
  'python',
  'go',
  'java',
  'kotlin',
  'scala',
  'groovy',
  'ruby',
  'php',
  'csharp',
  'rust',
  'vue',
  'svelte',
  'erb',
  'c',
  'cpp',
]);

/**
 * Extracts contracts provided or consumed by the file at `path`. Pure; never throws.
 */
export function extractContracts(path: string, source: string): Contract[] {
  if (!source) return [];
  const lang = detectLanguage(path);
  const c = new Collector(path);
  try {
    const lines = codeLines(source, lang);
    if (lang === 'graphql') extractGraphqlText(source, 0, c);
    else if (lang === 'proto') extractProto(lines, c);
    else if (lang === 'dotenv' || lang === 'dockerfile' || lang === 'yaml' || lang === 'properties')
      extractEnvVars(lines, c, lang, path);
    else if (lang === 'sql' || lang === 'prisma') extractTables(lines, c, lang);
    else if (CODE_LANGS.has(lang)) {
      if (['typescript', 'tsx', 'javascript', 'vue', 'svelte'].includes(lang)) {
        extractJsHttp(lines, c, path, source);
        if (/\b(?:gql|graphql)\s*(?:\(\s*)?`/.test(source)) extractGraphqlInCode(source, c);
      } else if (lang === 'python') extractPythonHttp(lines, c, path);
      else if (lang === 'go') extractGoHttp(lines, c);
      else if (['java', 'kotlin', 'scala', 'groovy'].includes(lang))
        extractJvmHttp(lines, c, source);
      else if (lang === 'ruby' || lang === 'php') extractRubyPhpHttp(lines, c, path, lang);
      extractEnvVars(lines, c, lang, path);
      extractTables(lines, c, lang);
      extractQueues(lines, c);
    }
  } catch {
    // Extraction is best-effort; partial results are still useful.
  }
  return c.items;
}
