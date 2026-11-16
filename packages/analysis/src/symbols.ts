/**
 * Symbol extraction: tree-sitter for TS/TSX/JS, Python, Go and Java; line-based regex
 * heuristics for every other language (and as a fallback when grammars are not loaded).
 */
import type { SymbolKind } from '@gmp/core';
import type { Node } from 'web-tree-sitter';
import { isTreeSitterLanguage, type TreeSitterLanguage } from './language.ts';
import { parseWithTreeSitter } from './parsers.ts';
import type { ExtractedSymbol } from './types.ts';

const MAX_SIGNATURE = 600;

/** Collapses whitespace and strips a trailing body opener. */
export function normalizeSignature(sig: string): string {
  let s = sig
    .replace(/\/\/[^\n]*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/\s*(?:\{|=>|:)\s*$/, '').trim();
  s = s
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/,\s*\)/g, ')');
  if (s.length > MAX_SIGNATURE) s = `${s.slice(0, MAX_SIGNATURE)}…`;
  return s;
}

/**
 * Extracts top-level declarations (and class/struct members) from `source`.
 * `lang` is a {@link detectLanguage} id. Never throws; returns [] for unsupported input.
 */
export function extractSymbols(lang: string, source: string): ExtractedSymbol[] {
  if (!source) return [];
  if (isTreeSitterLanguage(lang)) {
    const viaTree = extractWithTreeSitter(lang, source);
    if (viaTree) return viaTree;
  }
  return extractSymbolsWithRegex(lang, source);
}

// ---------------------------------------------------------------------------
// tree-sitter
// ---------------------------------------------------------------------------

function extractWithTreeSitter(lang: TreeSitterLanguage, source: string): ExtractedSymbol[] | null {
  const tree = parseWithTreeSitter(lang, source);
  if (!tree) return null;
  try {
    const root = tree.rootNode;
    const out: ExtractedSymbol[] = [];
    switch (lang) {
      case 'typescript':
      case 'tsx':
      case 'javascript':
        extractJs(root, out);
        break;
      case 'python':
        extractPython(root, out);
        break;
      case 'go':
        extractGo(root, out);
        break;
      case 'java':
        extractJava(root, out, null, true);
        break;
    }
    return dedupeSymbols(out);
  } catch (err) {
    if (process.env.GMP_DEBUG_SYMBOLS)
      process.stderr.write(`symbol extraction failed: ${(err as Error).stack}\n`);
    return null;
  } finally {
    tree.delete();
  }
}

function dedupeSymbols(list: ExtractedSymbol[]): ExtractedSymbol[] {
  // Overloads share a qualified name: keep the first declaration but widen the range.
  const seen = new Map<string, ExtractedSymbol>();
  for (const s of list) {
    const key = `${s.kind}:${s.qualifiedName}`;
    const prev = seen.get(key);
    if (!prev) seen.set(key, s);
    else {
      prev.exported ||= s.exported;
      prev.endLine = Math.max(prev.endLine, s.endLine);
      if (prev.signature !== s.signature && !prev.signature.includes(' | ')) {
        prev.signature = normalizeSignature(`${prev.signature} | ${s.signature}`);
      }
    }
  }
  return [...seen.values()];
}

const kids = (n: Node | null | undefined): Node[] =>
  n ? (n.namedChildren.filter((c) => c !== null) as Node[]) : [];

function headerText(node: Node, body: Node | null): string {
  if (!body) return node.text;
  const offset = body.startIndex - node.startIndex;
  return offset > 0 ? node.text.slice(0, offset) : node.text;
}

function sym(
  node: Node,
  name: string,
  kind: SymbolKind,
  signature: string,
  exported: boolean,
  parent?: string,
  rangeNode?: Node,
): ExtractedSymbol {
  const r = rangeNode ?? node;
  const s: ExtractedSymbol = {
    name,
    qualifiedName: parent ? `${parent}.${name}` : name,
    kind,
    signature: normalizeSignature(signature),
    exported,
    startLine: r.startPosition.row + 1,
    endLine: r.endPosition.row + 1,
  };
  if (parent) s.parent = parent;
  return s;
}

// ---- TypeScript / JavaScript ----

function extractJs(root: Node, out: ExtractedSymbol[]): void {
  const exportedNames = new Set<string>();
  for (const child of kids(root)) {
    if (child.type === 'export_statement') {
      const decl = child.childForFieldName('declaration');
      if (decl) {
        jsDeclaration(decl, out, true, child);
        continue;
      }
      // `export default <expr>` with a named function/class expression, or `export { a, b as c }`
      for (const c of kids(child)) {
        if (c.type === 'export_clause') {
          for (const spec of kids(c)) {
            if (spec.type !== 'export_specifier') continue;
            const local = spec.childForFieldName('name');
            if (local) exportedNames.add(local.text);
          }
        } else if (c.type === 'identifier') {
          exportedNames.add(c.text); // export default foo;
        } else if (
          ['function_expression', 'function', 'class', 'arrow_function'].includes(c.type)
        ) {
          const nameNode = c.childForFieldName('name');
          const name = nameNode?.text ?? 'default';
          if (c.type === 'class') jsClass(c, name, out, true, child);
          else {
            const body = c.childForFieldName('body');
            out.push(sym(c, name, 'function', headerText(c, body), true, undefined, child));
          }
        }
      }
      continue;
    }
    if (child.type === 'ambient_declaration') {
      for (const d of kids(child)) jsDeclaration(d, out, false, child);
      continue;
    }
    if (child.type === 'expression_statement') {
      jsCommonJsExports(child, out, exportedNames);
      continue;
    }
    jsDeclaration(child, out, false, child);
  }
  if (exportedNames.size > 0) {
    for (const s of out) if (!s.parent && exportedNames.has(s.name)) s.exported = true;
    for (const s of out) {
      if (s.parent && exportedNames.has(s.parent)) {
        s.exported = !/^(?:private|protected)\b|#/.test(s.signature) && !s.name.startsWith('#');
      }
    }
  }
}

function jsDeclaration(
  node: Node,
  out: ExtractedSymbol[],
  exported: boolean,
  rangeNode: Node,
): void {
  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration':
    case 'function_signature': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      out.push(
        sym(
          node,
          name,
          'function',
          headerText(node, node.childForFieldName('body')),
          exported,
          undefined,
          rangeNode,
        ),
      );
      return;
    }
    case 'class_declaration':
    case 'abstract_class_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (name) jsClass(node, name, out, exported, rangeNode);
      return;
    }
    case 'interface_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (name) out.push(sym(node, name, 'interface', node.text, exported, undefined, rangeNode));
      return;
    }
    case 'type_alias_declaration':
    case 'enum_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (name) out.push(sym(node, name, 'type', node.text, exported, undefined, rangeNode));
      return;
    }
    case 'lexical_declaration':
    case 'variable_declaration': {
      const keyword = node.text.trimStart().split(/\s/)[0] ?? 'const';
      for (const decl of kids(node)) {
        if (decl.type !== 'variable_declarator') continue;
        const nameNode = decl.childForFieldName('name');
        if (!nameNode || nameNode.type !== 'identifier') continue;
        const name = nameNode.text;
        const value = decl.childForFieldName('value');
        const typeAnn = decl.childForFieldName('type');
        if (
          value &&
          ['arrow_function', 'function_expression', 'function', 'generator_function'].includes(
            value.type,
          )
        ) {
          const body = value.childForFieldName('body');
          const head = headerText(value, body);
          out.push(
            sym(
              decl,
              name,
              'function',
              `${keyword} ${name}${typeAnn ? typeAnn.text : ''} = ${head}`,
              exported,
              undefined,
              rangeNode,
            ),
          );
        } else {
          out.push(
            sym(
              decl,
              name,
              'const',
              `${keyword} ${name}${typeAnn ? typeAnn.text : ''}`,
              exported,
              undefined,
              rangeNode,
            ),
          );
        }
      }
      return;
    }
    default:
      return;
  }
}

function jsClass(
  node: Node,
  name: string,
  out: ExtractedSymbol[],
  exported: boolean,
  rangeNode: Node,
): void {
  const body = node.childForFieldName('body');
  out.push(sym(node, name, 'class', headerText(node, body), exported, undefined, rangeNode));
  for (const m of kids(body)) {
    if (!['method_definition', 'method_signature', 'abstract_method_signature'].includes(m.type))
      continue;
    const nameNode = m.childForFieldName('name');
    if (!nameNode) continue;
    const mName = nameNode.text;
    const isPrivate =
      nameNode.type === 'private_property_identifier' ||
      mName.startsWith('#') ||
      kids(m).some((c) => c.type === 'accessibility_modifier' && /private|protected/.test(c.text));
    const signature = headerText(m, m.childForFieldName('body'));
    out.push(sym(m, mName, 'method', signature, exported && !isPrivate, name));
  }
}

function jsCommonJsExports(stmt: Node, out: ExtractedSymbol[], exportedNames: Set<string>): void {
  const expr = kids(stmt)[0];
  if (!expr || expr.type !== 'assignment_expression') return;
  const left = expr.childForFieldName('left');
  const right = expr.childForFieldName('right');
  if (!left || !right) return;
  const lt = left.text;
  if (lt === 'module.exports') {
    if (right.type === 'object') {
      for (const p of kids(right)) {
        if (p.type === 'shorthand_property_identifier') exportedNames.add(p.text);
        else if (p.type === 'pair') {
          const key = p.childForFieldName('key')?.text;
          const val = p.childForFieldName('value');
          if (val?.type === 'identifier') exportedNames.add(val.text);
          else if (key && val && /function|arrow_function/.test(val.type)) {
            out.push(
              sym(
                p,
                key,
                'function',
                `${key}: ${headerText(val, val.childForFieldName('body'))}`,
                true,
              ),
            );
          }
        } else if (p.type === 'method_definition') {
          const key = p.childForFieldName('name')?.text;
          if (key)
            out.push(sym(p, key, 'function', headerText(p, p.childForFieldName('body')), true));
        }
      }
    } else if (right.type === 'identifier') {
      exportedNames.add(right.text);
    }
    return;
  }
  const m = /^(?:module\.)?exports\.([\w$]+)$/.exec(lt);
  if (m?.[1]) {
    const name = m[1];
    if (right.type === 'identifier') exportedNames.add(right.text);
    if (/function|arrow_function/.test(right.type)) {
      out.push(
        sym(
          stmt,
          name,
          'function',
          `exports.${name} = ${headerText(right, right.childForFieldName('body'))}`,
          true,
        ),
      );
    } else if (right.type !== 'identifier') {
      out.push(sym(stmt, name, 'const', `exports.${name}`, true));
    }
  }
}

// ---- Python ----

function extractPython(root: Node, out: ExtractedSymbol[]): void {
  let allNames: Set<string> | null = null;
  for (const child of kids(root)) {
    const def =
      child.type === 'decorated_definition' ? child.childForFieldName('definition') : child;
    if (!def) continue;
    if (def.type === 'function_definition') {
      const name = def.childForFieldName('name')?.text;
      if (name)
        out.push(
          sym(def, name, 'function', pyHeader(def), !name.startsWith('_'), undefined, child),
        );
    } else if (def.type === 'class_definition') {
      pyClass(def, child, out, null);
    } else if (def.type === 'expression_statement') {
      const assign = kids(def)[0];
      if (assign?.type !== 'assignment') continue;
      const left = assign.childForFieldName('left');
      if (!left || left.type !== 'identifier') continue;
      const name = left.text;
      if (name === '__all__') {
        const right = assign.childForFieldName('right');
        allNames = new Set(
          kids(right)
            .filter((n) => n.type === 'string')
            .map((n) => n.text.replace(/^[rbuf]*['"]{1,3}|['"]{1,3}$/gi, '')),
        );
        continue;
      }
      if (/^[A-Z][A-Z0-9_]*$/.test(name)) {
        const typeNode = assign.childForFieldName('type');
        out.push(sym(def, name, 'const', `${name}${typeNode ? `: ${typeNode.text}` : ''}`, true));
      }
    }
  }
  if (allNames) {
    const names = allNames;
    for (const s of out) if (!s.parent) s.exported = names.has(s.name);
    for (const s of out)
      if (s.parent) s.exported = s.exported && names.has(s.parent.split('.')[0] ?? '');
  }
}

function pyHeader(def: Node): string {
  return headerText(def, def.childForFieldName('body')).replace(/:\s*$/, '');
}

function pyClass(def: Node, rangeNode: Node, out: ExtractedSymbol[], parent: string | null): void {
  const name = def.childForFieldName('name')?.text;
  if (!name) return;
  const qualified = parent ? `${parent}.${name}` : name;
  const exported =
    !name.startsWith('_') && (parent === null || !parent.split('.').some((p) => p.startsWith('_')));
  const s = sym(def, name, 'class', pyHeader(def), exported, parent ?? undefined, rangeNode);
  out.push(s);
  for (const member of kids(def.childForFieldName('body'))) {
    const inner =
      member.type === 'decorated_definition' ? member.childForFieldName('definition') : member;
    if (!inner) continue;
    if (inner.type === 'function_definition') {
      const mName = inner.childForFieldName('name')?.text;
      if (!mName) continue;
      const isPublic = !mName.startsWith('_') || /^__\w+__$/.test(mName);
      out.push(
        sym(inner, mName, 'method', pyHeader(inner), exported && isPublic, qualified, member),
      );
    } else if (inner.type === 'class_definition') {
      pyClass(inner, member, out, qualified);
    }
  }
}

// ---- Go ----

const goExported = (name: string) => /^[A-Z]/.test(name);

function extractGo(root: Node, out: ExtractedSymbol[]): void {
  for (const child of kids(root)) {
    switch (child.type) {
      case 'function_declaration': {
        const name = child.childForFieldName('name')?.text;
        if (name)
          out.push(
            sym(
              child,
              name,
              'function',
              headerText(child, child.childForFieldName('body')),
              goExported(name),
            ),
          );
        break;
      }
      case 'method_declaration': {
        const name = child.childForFieldName('name')?.text;
        const receiver = child.childForFieldName('receiver');
        if (!name) break;
        const recvType = goReceiverType(receiver);
        out.push(
          sym(
            child,
            name,
            'method',
            headerText(child, child.childForFieldName('body')),
            goExported(name) && goExported(recvType || 'X'),
            recvType || undefined,
          ),
        );
        break;
      }
      case 'type_declaration': {
        for (const spec of kids(child)) {
          if (spec.type !== 'type_spec' && spec.type !== 'type_alias') continue;
          const name = spec.childForFieldName('name')?.text;
          const typeNode = spec.childForFieldName('type');
          if (!name) continue;
          const kind: SymbolKind =
            typeNode?.type === 'interface_type'
              ? 'interface'
              : typeNode?.type === 'struct_type'
                ? 'class'
                : 'type';
          out.push(sym(spec, name, kind, `type ${spec.text}`, goExported(name)));
        }
        break;
      }
      case 'const_declaration':
      case 'var_declaration': {
        const keyword = child.type === 'const_declaration' ? 'const' : 'var';
        const specs = child
          .descendantsOfType(child.type === 'const_declaration' ? 'const_spec' : 'var_spec')
          .filter((n): n is Node => n !== null);
        for (const spec of specs) {
          const typeNode = spec.childForFieldName('type');
          for (const n of spec.childrenForFieldName('name')) {
            if (!n) continue;
            out.push(
              sym(
                spec,
                n.text,
                'const',
                `${keyword} ${n.text}${typeNode ? ` ${typeNode.text}` : ''}`,
                goExported(n.text),
              ),
            );
          }
        }
        break;
      }
      default:
        break;
    }
  }
}

function goReceiverType(receiver: Node | null): string {
  if (!receiver) return '';
  const text = receiver.text.replace(/^\(|\)$/g, '').trim();
  // "(s *Server)" | "(Server)" | "(s *Box[T])"
  const parts = text.split(/\s+/);
  const typePart = parts[parts.length - 1] ?? '';
  return typePart.replace(/^\*/, '').replace(/\[.*$/, '');
}

// ---- Java ----

function javaModifiers(node: Node): string {
  const mods = kids(node).find((c) => c.type === 'modifiers');
  return mods ? mods.text : '';
}

function stripAnnotations(text: string): string {
  return text.replace(/@[\w.]+(?:\s*\((?:[^()]|\([^()]*\))*\))?/g, ' ');
}

function extractJava(
  node: Node,
  out: ExtractedSymbol[],
  parent: string | null,
  parentPublic: boolean,
  inInterface = false,
): void {
  for (const child of kids(node)) {
    switch (child.type) {
      case 'class_declaration':
      case 'interface_declaration':
      case 'enum_declaration':
      case 'record_declaration':
      case 'annotation_type_declaration': {
        const name = child.childForFieldName('name')?.text;
        if (!name) break;
        const mods = javaModifiers(child);
        const isPublic = (/\bpublic\b/.test(mods) || inInterface) && parentPublic;
        const kind: SymbolKind =
          child.type === 'interface_declaration' || child.type === 'annotation_type_declaration'
            ? 'interface'
            : child.type === 'enum_declaration'
              ? 'type'
              : 'class';
        const body = child.childForFieldName('body');
        out.push(
          sym(
            child,
            name,
            kind,
            stripAnnotations(headerText(child, body)),
            isPublic,
            parent ?? undefined,
          ),
        );
        const qualified = parent ? `${parent}.${name}` : name;
        const isIface = child.type === 'interface_declaration';
        extractJava(body ?? child, out, qualified, isPublic, isIface);
        // enum bodies keep members under enum_body_declarations
        for (const b of kids(body))
          if (b.type === 'enum_body_declarations') extractJava(b, out, qualified, isPublic);
        break;
      }
      case 'method_declaration':
      case 'constructor_declaration':
      case 'compact_constructor_declaration': {
        if (!parent) break;
        const name = child.childForFieldName('name')?.text ?? parent.split('.').pop() ?? '';
        const mods = javaModifiers(child);
        const visible = inInterface
          ? !/\bprivate\b/.test(mods)
          : /\b(?:public|protected)\b/.test(mods);
        out.push(
          sym(
            child,
            name,
            'method',
            stripAnnotations(headerText(child, child.childForFieldName('body'))),
            visible && parentPublic,
            parent,
          ),
        );
        break;
      }
      case 'field_declaration':
      case 'constant_declaration': {
        if (!parent) break;
        const mods = javaModifiers(child);
        const isConst =
          child.type === 'constant_declaration' ||
          (/\bstatic\b/.test(mods) && /\bfinal\b/.test(mods));
        if (!isConst) break;
        const visible = inInterface || /\bpublic\b/.test(mods);
        const typeNode = child.childForFieldName('type');
        for (const d of child.childrenForFieldName('declarator')) {
          const n = d?.childForFieldName('name')?.text;
          if (n)
            out.push(
              sym(
                child,
                n,
                'const',
                `${typeNode?.text ?? ''} ${n}`,
                visible && parentPublic,
                parent,
              ),
            );
        }
        break;
      }
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Regex fallback
// ---------------------------------------------------------------------------

interface RegexRule {
  re: RegExp;
  kind: SymbolKind | 'container';
  /** Index of the capture group holding the name. */
  name: number;
  exported: (m: RegExpExecArray, line: string, indent: number) => boolean;
  /** Only match at indent 0 (top level). */
  topLevel?: boolean;
  /** Only match when inside a container. */
  memberOnly?: boolean;
  containerKind?: SymbolKind;
}

const JS_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'function',
  'return',
  'constructor',
  'super',
  'else',
  'do',
  'try',
  'with',
  'new',
  'typeof',
  'await',
  'yield',
]);

const rulesByFamily: Record<string, RegexRule[]> = {
  js: [
    {
      re: /^\s*(export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)\s*(?:<[^>]*>)?\s*\(/,
      kind: 'function',
      name: 2,
      exported: (m) => !!m[1],
    },
    {
      re: /^\s*(export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+([\w$]+)/,
      kind: 'container',
      containerKind: 'class',
      name: 2,
      exported: (m) => !!m[1],
    },
    {
      re: /^\s*(export\s+)?(?:declare\s+)?interface\s+([\w$]+)/,
      kind: 'interface',
      name: 2,
      exported: (m) => !!m[1],
    },
    {
      re: /^\s*(export\s+)?(?:declare\s+)?type\s+([\w$]+)\s*(?:<[^>]*>)?\s*=/,
      kind: 'type',
      name: 2,
      exported: (m) => !!m[1],
    },
    {
      re: /^\s*(export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([\w$]+)/,
      kind: 'type',
      name: 2,
      exported: (m) => !!m[1],
    },
    {
      re: /^(export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>/,
      kind: 'function',
      name: 2,
      exported: (m) => !!m[1],
      topLevel: true,
    },
    {
      re: /^(export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s+)?function\b/,
      kind: 'function',
      name: 2,
      exported: (m) => !!m[1],
      topLevel: true,
    },
    {
      re: /^(export\s+)?const\s+([\w$]+)\b/,
      kind: 'const',
      name: 2,
      exported: (m) => !!m[1],
      topLevel: true,
    },
    {
      re: /^\s+((?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*)\*?([\w$#]+)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{;]+)?\{(?:.*\})?\s*$/,
      kind: 'method',
      name: 2,
      exported: (m) => !/private|protected/.test(m[1] ?? '') && !(m[2] ?? '').startsWith('#'),
      memberOnly: true,
    },
  ],
  python: [
    {
      re: /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/,
      kind: 'function',
      name: 2,
      exported: (m) => !(m[2] ?? '').startsWith('_') || /^__\w+__$/.test(m[2] ?? ''),
    },
    {
      re: /^(\s*)class\s+(\w+)/,
      kind: 'container',
      containerKind: 'class',
      name: 2,
      exported: (m) => !(m[2] ?? '').startsWith('_'),
    },
    {
      re: /^()([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=(?!=)/,
      kind: 'const',
      name: 2,
      exported: () => true,
      topLevel: true,
    },
  ],
  go: [
    {
      re: /^func\s+\(\s*\w*\s*\*?\s*(\w+)(?:\[[^\]]*\])?\s*\)\s*(\w+)\s*(?:\[[^\]]*\])?\s*\(/,
      kind: 'method',
      name: 2,
      exported: (m) => /^[A-Z]/.test(m[2] ?? '') && /^[A-Z]/.test(m[1] ?? ''),
    },
    {
      re: /^func\s+(\w+)\s*(?:\[[^\]]*\])?\s*\(/,
      kind: 'function',
      name: 1,
      exported: (m) => /^[A-Z]/.test(m[1] ?? ''),
    },
    {
      re: /^type\s+(\w+)(?:\[[^\]]*\])?\s+interface\b/,
      kind: 'interface',
      name: 1,
      exported: (m) => /^[A-Z]/.test(m[1] ?? ''),
    },
    {
      re: /^type\s+(\w+)(?:\[[^\]]*\])?\s+struct\b/,
      kind: 'class',
      name: 1,
      exported: (m) => /^[A-Z]/.test(m[1] ?? ''),
    },
    { re: /^type\s+(\w+)\s+/, kind: 'type', name: 1, exported: (m) => /^[A-Z]/.test(m[1] ?? '') },
    {
      re: /^(?:const|var)\s+(\w+)\b/,
      kind: 'const',
      name: 1,
      exported: (m) => /^[A-Z]/.test(m[1] ?? ''),
    },
  ],
  jvm: [
    {
      re: /^\s*((?:(?:public|private|protected|internal|abstract|final|static|sealed|open|data|partial|inner|enum|annotation|value|case)\s+)*)(class|interface|enum|record|object|trait|struct)\s+(\w+)/,
      kind: 'container',
      containerKind: 'class',
      name: 3,
      exported: (m) => !/\b(?:private|internal)\b/.test(m[1] ?? ''),
    },
    {
      re: /^\s*((?:(?:public|private|protected|internal|static|final|abstract|synchronized|native|override|virtual|async|default|open|suspend|inline|operator|infix|tailrec)\s+)*)fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)\s*\(/,
      kind: 'function',
      name: 2,
      exported: (m) => !/\b(?:private|internal)\b/.test(m[1] ?? ''),
    },
    {
      re: /^\s*((?:(?:public|private|protected|internal|static|final|abstract|synchronized|native|override|virtual|async|default|sealed|extern|unsafe|new)\s+)+)(?:<[^>]*>\s*)?[\w<>[\],.?]+(?:\s*<[^>]*>)?\s+(\w+)\s*\(/,
      kind: 'method',
      name: 2,
      exported: (m) => /\b(?:public|protected)\b/.test(m[1] ?? ''),
    },
    {
      re: /^\s*((?:(?:private|protected|override|final|implicit|lazy)\s+)*)def\s+(\w+)/,
      kind: 'function',
      name: 2,
      exported: (m) => !/\bprivate\b/.test(m[1] ?? ''),
    },
  ],
  ruby: [
    { re: /^(\s*)def\s+(self\.)?(\w+[?!=]?)/, kind: 'function', name: 3, exported: () => true },
    {
      re: /^(\s*)(class|module)\s+([\w:]+)/,
      kind: 'container',
      containerKind: 'class',
      name: 3,
      exported: () => true,
    },
  ],
  php: [
    {
      re: /^\s*((?:(?:public|private|protected|static|abstract|final)\s+)*)function\s+&?(\w+)\s*\(/,
      kind: 'function',
      name: 2,
      exported: (m) => !/\b(?:private|protected)\b/.test(m[1] ?? ''),
    },
    {
      re: /^\s*((?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+(\w+)/,
      kind: 'container',
      containerKind: 'class',
      name: 3,
      exported: () => true,
    },
  ],
  rust: [
    {
      re: /^\s*(pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+(\w+)/,
      kind: 'function',
      name: 2,
      exported: (m) => !!m[1],
    },
    {
      re: /^\s*(pub(?:\([^)]*\))?\s+)?(struct|enum|union)\s+(\w+)/,
      kind: 'class',
      name: 3,
      exported: (m) => !!m[1],
    },
    {
      re: /^\s*(pub(?:\([^)]*\))?\s+)?trait\s+(\w+)/,
      kind: 'interface',
      name: 2,
      exported: (m) => !!m[1],
    },
    {
      re: /^\s*(pub(?:\([^)]*\))?\s+)?type\s+(\w+)/,
      kind: 'type',
      name: 2,
      exported: (m) => !!m[1],
    },
    {
      re: /^(pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(?:mut\s+)?([A-Z_][A-Z0-9_]*)\s*:/,
      kind: 'const',
      name: 2,
      exported: (m) => !!m[1],
      topLevel: true,
    },
  ],
  swift: [
    {
      re: /^\s*((?:(?:public|open|private|fileprivate|internal|static|class|final|override|mutating|@\w+)\s+)*)func\s+(\w+)/,
      kind: 'function',
      name: 2,
      exported: (m) => /\b(?:public|open)\b/.test(m[1] ?? ''),
    },
    {
      re: /^\s*((?:(?:public|open|private|fileprivate|internal|final)\s+)*)(class|struct|enum|extension|actor)\s+(\w+)/,
      kind: 'container',
      containerKind: 'class',
      name: 3,
      exported: (m) => /\b(?:public|open)\b/.test(m[1] ?? ''),
    },
    {
      re: /^\s*((?:(?:public|open|private|fileprivate|internal)\s+)*)protocol\s+(\w+)/,
      kind: 'interface',
      name: 2,
      exported: (m) => /\b(?:public|open)\b/.test(m[1] ?? ''),
    },
  ],
  c: [
    {
      re: /^(static\s+)?(?:inline\s+)?(?:const\s+)?(?:unsigned\s+|signed\s+|struct\s+|enum\s+)?[A-Za-z_][\w:<>]*[\s*&]+([A-Za-z_]\w*)\s*\([^;]*$/,
      kind: 'function',
      name: 2,
      exported: (m) => !m[1],
      topLevel: true,
    },
    {
      re: /^(?:typedef\s+)?(struct|class|enum|union)\s+(\w+)\s*(?:[:{]|$)/,
      kind: 'class',
      name: 2,
      exported: () => true,
      topLevel: true,
    },
  ],
};

const FAMILY: Record<string, string> = {
  typescript: 'js',
  tsx: 'js',
  javascript: 'js',
  vue: 'js',
  svelte: 'js',
  python: 'python',
  go: 'go',
  java: 'jvm',
  kotlin: 'jvm',
  scala: 'jvm',
  csharp: 'jvm',
  groovy: 'jvm',
  dart: 'jvm',
  ruby: 'ruby',
  php: 'php',
  rust: 'rust',
  swift: 'swift',
  c: 'c',
  cpp: 'c',
  objc: 'c',
};

const INDENT_FAMILIES = new Set(['python', 'ruby']);

function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0].replace(/\t/g, '    ').length : 0;
}

/** Estimates where a block starting at `start` (0-based) ends (0-based, inclusive). */
function estimateEnd(lines: string[], start: number, family: string): number {
  if (INDENT_FAMILIES.has(family)) {
    const base = indentOf(lines[start] ?? '');
    let end = start;
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i] ?? '';
      if (l.trim() === '') continue;
      if (indentOf(l) <= base) {
        if (family === 'ruby' && /^\s*end\b/.test(l)) end = i;
        break;
      }
      end = i;
    }
    return end;
  }
  // Brace languages: balance braces starting from the first `{` at or after `start`.
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length && i < start + 5000; i++) {
    const l = (lines[i] ?? '').replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$/, '');
    for (const ch of l) {
      if (ch === '{') {
        depth++;
        opened = true;
      } else if (ch === '}') depth--;
    }
    if (opened && depth <= 0) return i;
    if (!opened && /;\s*$/.test(l)) return i; // declaration without body
    if (!opened && i > start + 3) return start;
  }
  return opened ? lines.length - 1 : start;
}

/** Line-based regex extraction (fallback and for languages without a grammar). */
export function extractSymbolsWithRegex(lang: string, source: string): ExtractedSymbol[] {
  const family = FAMILY[lang];
  if (!family) return [];
  const rules = rulesByFamily[family] ?? [];
  const lines = source.split('\n');
  const out: ExtractedSymbol[] = [];
  const containers: Array<{
    name: string;
    start: number;
    end: number;
    indent: number;
    exported: boolean;
  }> = [];
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('/*') && !trimmed.includes('*/')) {
      inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;
    const indent = indentOf(line);
    while (containers.length > 0 && (containers[containers.length - 1]?.end ?? -1) < i)
      containers.pop();
    const container = containers[containers.length - 1];
    const insideContainer = !!container && i > container.start && indent > container.indent;

    for (const rule of rules) {
      if (rule.topLevel && indent > 0) continue;
      if (rule.memberOnly && !insideContainer) continue;
      const m = rule.re.exec(line);
      if (!m) continue;
      const name = m[rule.name];
      if (!name || JS_KEYWORDS.has(name)) continue;
      const end = estimateEnd(lines, i, family);
      let exported = rule.exported(m, line, indent);
      if (rule.kind === 'container') {
        const parentName = insideContainer ? container?.name : undefined;
        if (insideContainer && container) exported = exported && container.exported;
        const s: ExtractedSymbol = {
          name,
          qualifiedName: parentName ? `${parentName}.${name}` : name,
          kind: rule.containerKind ?? 'class',
          signature: normalizeSignature(line),
          exported,
          startLine: i + 1,
          endLine: end + 1,
        };
        if (parentName) s.parent = parentName;
        out.push(s);
        containers.push({ name: s.qualifiedName, start: i, end, indent, exported });
        break;
      }
      let kind: SymbolKind = rule.kind;
      let parent: string | undefined;
      if (insideContainer && container && (kind === 'function' || kind === 'method')) {
        kind = 'method';
        parent = container.name;
        exported = exported && container.exported;
      } else if (kind === 'method' && !insideContainer) {
        if (family === 'go') parent = m[1];
        else kind = 'function';
      }
      if (family === 'go' && rule.kind === 'method') parent = m[1];
      const s: ExtractedSymbol = {
        name,
        qualifiedName: parent ? `${parent}.${name}` : name,
        kind,
        signature: normalizeSignature(line),
        exported,
        startLine: i + 1,
        endLine: end + 1,
      };
      if (parent) s.parent = parent;
      out.push(s);
      break;
    }
  }
  return dedupeSymbols(out);
}

/** Parses a parameter list out of a signature: returns raw parameter strings. */
export function signatureParams(signature: string): string[] | null {
  const open = signature.indexOf('(');
  if (open === -1) return null;
  let depth = 0;
  let current = '';
  const params: string[] = [];
  for (let i = open; i < signature.length; i++) {
    const ch = signature[i] ?? '';
    if ('([{<'.includes(ch)) {
      depth++;
      if (depth === 1) continue;
    } else if (')]}>'.includes(ch)) {
      if (ch === '>' && signature[i - 1] === '=') {
        current += ch;
        continue;
      }
      depth--;
      if (depth === 0) {
        if (current.trim()) params.push(current.trim());
        return params;
      }
    } else if (ch === ',' && depth === 1) {
      params.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  return null;
}
