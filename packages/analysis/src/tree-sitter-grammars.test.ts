// Smoke test: guards the web-tree-sitter <-> tree-sitter-wasms ABI pairing.
// web-tree-sitter is pinned to 0.25.10 because tree-sitter-wasms@0.1.13 grammars fail to
// load on web-tree-sitter >=0.26.
import { createRequire } from 'node:module';
import { Language, Parser } from 'web-tree-sitter';
import { beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

const samples: Record<string, { src: string; expectNode: string }> = {
  typescript: {
    src: 'export function f(a: number): string { return String(a); }',
    expectNode: 'function_declaration',
  },
  tsx: {
    src: 'export const A = () => <div className="x" />;',
    expectNode: 'jsx_self_closing_element',
  },
  javascript: { src: 'function g(x) { return x * 2; }', expectNode: 'function_declaration' },
  python: { src: 'def h(x):\n    return x\n', expectNode: 'function_definition' },
  go: { src: 'package m\n\nfunc K(a int) int { return a }\n', expectNode: 'function_declaration' },
  java: { src: 'class C { int m(int a) { return a; } }', expectNode: 'method_declaration' },
};

describe('tree-sitter WASM grammars', () => {
  beforeAll(async () => {
    await Parser.init();
  });

  for (const [lang, { src, expectNode }] of Object.entries(samples)) {
    it(`loads and parses ${lang}`, async () => {
      const language = await Language.load(
        require.resolve(`tree-sitter-wasms/out/tree-sitter-${lang}.wasm`),
      );
      const parser = new Parser();
      parser.setLanguage(language);
      const tree = parser.parse(src);
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.hasError).toBe(false);
      expect(tree!.rootNode.descendantsOfType(expectNode).length).toBeGreaterThan(0);
      tree!.delete();
      parser.delete();
    });
  }
});
