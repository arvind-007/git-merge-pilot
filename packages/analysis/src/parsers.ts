/**
 * tree-sitter (WASM) grammar loading. Grammars are loaded once per process by
 * {@link initParsers}; until then (or when loading fails) symbol extraction falls back to
 * regex heuristics. The package entry point awaits {@link initParsers} at import time so
 * the synchronous APIs are tree-sitter backed for consumers.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Language as TsLanguage, Parser as TsParser } from 'web-tree-sitter';
import { TREE_SITTER_LANGUAGES, type TreeSitterLanguage } from './language.ts';

export interface ParserStatus {
  initialized: boolean;
  /** Languages whose grammar loaded successfully. */
  languages: TreeSitterLanguage[];
  /** Load errors (per language or global); empty when everything loaded. */
  errors: string[];
}

interface LoadedState {
  parser: TsParser | null;
  languages: Map<TreeSitterLanguage, TsLanguage>;
  errors: string[];
}

let state: LoadedState | null = null;
let pending: Promise<ParserStatus> | null = null;

function resolveWasm(lang: string): string | null {
  const file = `tree-sitter-${lang}.wasm`;
  const explicit = process.env.GMP_TREE_SITTER_WASM_DIR;
  if (explicit) {
    const p = join(explicit, file);
    if (existsSync(p)) return p;
  }
  const bases = [import.meta.url, join(process.cwd(), 'package.json')];
  for (const base of bases) {
    try {
      const req = createRequire(base);
      return req.resolve(`tree-sitter-wasms/out/${file}`);
    } catch {
      // try next base
    }
  }
  return null;
}

async function load(): Promise<ParserStatus> {
  const errors: string[] = [];
  const languages = new Map<TreeSitterLanguage, TsLanguage>();
  let parser: TsParser | null = null;
  try {
    const mod = await import('web-tree-sitter');
    await mod.Parser.init();
    parser = new mod.Parser();
    for (const lang of TREE_SITTER_LANGUAGES) {
      const path = resolveWasm(lang);
      if (!path) {
        errors.push(`${lang}: grammar file not found`);
        continue;
      }
      try {
        languages.set(lang, await mod.Language.load(path));
      } catch (err) {
        errors.push(`${lang}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    errors.push(`web-tree-sitter unavailable: ${(err as Error).message}`);
  }
  state = { parser, languages, errors };
  return parserStatus();
}

/** Loads tree-sitter grammars once. Never throws; failures are reported in the status. */
export function initParsers(): Promise<ParserStatus> {
  if (state) return Promise.resolve(parserStatus());
  pending ??= load();
  return pending;
}

export function parserStatus(): ParserStatus {
  return {
    initialized: state !== null,
    languages: state ? [...state.languages.keys()] : [],
    errors: state ? [...state.errors] : [],
  };
}

/**
 * Parses `source` with the grammar for `lang`. Returns null when grammars are not loaded or
 * the language is unsupported. The caller must call `tree.delete()`.
 */
export function parseWithTreeSitter(lang: TreeSitterLanguage, source: string) {
  if (!state?.parser) return null;
  const language = state.languages.get(lang);
  if (!language) return null;
  state.parser.setLanguage(language);
  try {
    return state.parser.parse(source);
  } catch {
    return null;
  }
}
