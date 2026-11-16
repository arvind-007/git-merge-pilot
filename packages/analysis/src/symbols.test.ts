import { describe, expect, it } from 'vitest';
import { initParsers, parserStatus } from './parsers.ts';
import { extractSymbols, extractSymbolsWithRegex, signatureParams } from './symbols.ts';
import type { ExtractedSymbol } from './types.ts';

const by = (list: ExtractedSymbol[], q: string) => list.find((s) => s.qualifiedName === q);

// Extraction runs at collection time inside describe blocks, so load grammars first.
await initParsers();

describe('parsers', () => {
  it('loads all six grammars', () => {
    const st = parserStatus();
    expect(st.errors).toEqual([]);
    expect(st.languages.sort()).toEqual([
      'go',
      'java',
      'javascript',
      'python',
      'tsx',
      'typescript',
    ]);
  });
});

describe('extractSymbols — TypeScript', () => {
  const src = `import { x } from './x';
export function createUser(name: string, age?: number): User {
  return { name, age };
}
function internalHelper() {}
export const sum = (a: number, b: number): number => a + b;
export const MAX_USERS: number = 10;
const hidden = 1;
export interface User {
  name: string;
  age?: number;
}
export type Id = string | number;
export enum Role { Admin, Member }
export class UserService extends Base implements Svc {
  constructor(private readonly db: Db) { super(); }
  async save(user: User): Promise<void> {}
  private secret(): void {}
  #hard() {}
  static create(): UserService { return new UserService(null!); }
}
class Local {}
export { Local, internalHelper as helper };
export default function main() {}
`;
  const syms = extractSymbols('typescript', src);

  it('finds functions with signatures and exported-ness', () => {
    expect(by(syms, 'createUser')).toMatchObject({
      kind: 'function',
      exported: true,
      signature: 'function createUser(name: string, age?: number): User',
      startLine: 2,
      endLine: 4,
    });
    expect(by(syms, 'internalHelper')?.exported).toBe(true); // via export { internalHelper as helper }
    expect(by(syms, 'sum')).toMatchObject({ kind: 'function', exported: true });
    expect(by(syms, 'sum')?.signature).toContain('(a: number, b: number): number');
    expect(by(syms, 'main')).toMatchObject({ kind: 'function', exported: true });
  });

  it('finds consts, interfaces, types and enums', () => {
    expect(by(syms, 'MAX_USERS')).toMatchObject({
      kind: 'const',
      exported: true,
      signature: 'const MAX_USERS: number',
    });
    expect(by(syms, 'hidden')).toMatchObject({ kind: 'const', exported: false });
    expect(by(syms, 'User')).toMatchObject({ kind: 'interface', exported: true });
    expect(by(syms, 'User')?.signature).toContain('age?: number');
    expect(by(syms, 'Id')).toMatchObject({ kind: 'type', exported: true });
    expect(by(syms, 'Role')).toMatchObject({ kind: 'type', exported: true });
  });

  it('finds classes and methods with visibility', () => {
    expect(by(syms, 'UserService')).toMatchObject({ kind: 'class', exported: true });
    expect(by(syms, 'UserService.save')).toMatchObject({
      kind: 'method',
      exported: true,
      parent: 'UserService',
    });
    expect(by(syms, 'UserService.save')?.signature).toBe('async save(user: User): Promise<void>');
    expect(by(syms, 'UserService.secret')?.exported).toBe(false);
    expect(by(syms, 'UserService.#hard')?.exported).toBe(false);
    expect(by(syms, 'UserService.constructor')?.exported).toBe(true);
    expect(by(syms, 'Local')?.exported).toBe(true);
  });
});

describe('extractSymbols — TSX & JavaScript', () => {
  it('parses TSX components', () => {
    const syms = extractSymbols(
      'tsx',
      `export const Button = ({ label }: Props) => <button>{label}</button>;\nfunction Inner() { return <div/>; }\n`,
    );
    expect(by(syms, 'Button')).toMatchObject({ kind: 'function', exported: true });
    expect(by(syms, 'Inner')).toMatchObject({ kind: 'function', exported: false });
  });

  it('handles CommonJS exports', () => {
    const syms = extractSymbols(
      'javascript',
      `function a(x) { return x; }\nfunction b() {}\nconst c = () => 1;\nmodule.exports = { a, c };\nexports.d = function (y) { return y; };\n`,
    );
    expect(by(syms, 'a')?.exported).toBe(true);
    expect(by(syms, 'b')?.exported).toBe(false);
    expect(by(syms, 'c')?.exported).toBe(true);
    expect(by(syms, 'd')).toMatchObject({ kind: 'function', exported: true });
  });
});

describe('extractSymbols — Python', () => {
  const src = `import os

MAX_RETRIES: int = 3
_private_const = 1

def fetch(url: str, timeout: int = 5) -> bytes:
    return b""

def _helper():
    pass

@dataclass
class Order:
    def __init__(self, id: int):
        self.id = id

    def total(self) -> float:
        return 0.0

    def _internal(self):
        pass

class _Hidden:
    def run(self):
        pass
`;
  const syms = extractSymbols('python', src);
  it('extracts functions, classes, methods and constants', () => {
    expect(by(syms, 'fetch')).toMatchObject({
      kind: 'function',
      exported: true,
      signature: 'def fetch(url: str, timeout: int = 5) -> bytes',
    });
    expect(by(syms, '_helper')?.exported).toBe(false);
    expect(by(syms, 'MAX_RETRIES')).toMatchObject({ kind: 'const', exported: true });
    expect(by(syms, 'Order')).toMatchObject({ kind: 'class', exported: true, startLine: 12 });
    expect(by(syms, 'Order.total')).toMatchObject({ kind: 'method', exported: true });
    expect(by(syms, 'Order.__init__')?.exported).toBe(true);
    expect(by(syms, 'Order._internal')?.exported).toBe(false);
    expect(by(syms, '_Hidden.run')?.exported).toBe(false);
  });

  it('honours __all__', () => {
    const s = extractSymbols(
      'python',
      `__all__ = ["a"]\n\ndef a():\n    pass\n\ndef b():\n    pass\n`,
    );
    expect(by(s, 'a')?.exported).toBe(true);
    expect(by(s, 'b')?.exported).toBe(false);
  });
});

describe('extractSymbols — Go', () => {
  const src = `package users

const MaxUsers = 10
var defaultName string

type Store interface {
	Get(id string) (*User, error)
}

type User struct {
	ID   string
	name string
}

func NewUser(id string) *User { return &User{ID: id} }

func helper() {}

func (u *User) Rename(name string) error { u.name = name; return nil }

func (u User) secret() {}
`;
  const syms = extractSymbols('go', src);
  it('extracts funcs, methods, types and consts', () => {
    expect(by(syms, 'NewUser')).toMatchObject({
      kind: 'function',
      exported: true,
      signature: 'func NewUser(id string) *User',
    });
    expect(by(syms, 'helper')?.exported).toBe(false);
    expect(by(syms, 'User.Rename')).toMatchObject({
      kind: 'method',
      exported: true,
      parent: 'User',
    });
    expect(by(syms, 'User.secret')?.exported).toBe(false);
    expect(by(syms, 'Store')).toMatchObject({ kind: 'interface', exported: true });
    expect(by(syms, 'User')).toMatchObject({ kind: 'class', exported: true });
    expect(by(syms, 'MaxUsers')).toMatchObject({ kind: 'const', exported: true });
    expect(by(syms, 'defaultName')).toMatchObject({ kind: 'const', exported: false });
  });
});

describe('extractSymbols — Java', () => {
  const src = `package com.example;

import java.util.List;

@Service
public class UserService {
    public static final int LIMIT = 5;
    private final Repo repo;

    public UserService(Repo repo) { this.repo = repo; }

    @Transactional
    public List<User> findAll(int page, int size) { return null; }

    protected void audit() {}

    private void secret() {}

    public static class Inner {
        public void go() {}
    }
}

interface Repo {
    User find(String id);
}
`;
  const syms = extractSymbols('java', src);
  it('extracts classes, methods, constructors and constants', () => {
    expect(by(syms, 'UserService')).toMatchObject({ kind: 'class', exported: true });
    expect(by(syms, 'UserService.findAll')).toMatchObject({ kind: 'method', exported: true });
    expect(by(syms, 'UserService.findAll')?.signature).toBe(
      'public List<User> findAll(int page, int size)',
    );
    expect(by(syms, 'UserService.UserService')).toMatchObject({ kind: 'method', exported: true });
    expect(by(syms, 'UserService.audit')?.exported).toBe(true);
    expect(by(syms, 'UserService.secret')?.exported).toBe(false);
    expect(by(syms, 'UserService.LIMIT')).toMatchObject({ kind: 'const', exported: true });
    expect(by(syms, 'UserService.Inner.go')).toMatchObject({ kind: 'method', exported: true });
    expect(by(syms, 'Repo')).toMatchObject({ kind: 'interface', exported: false });
    expect(by(syms, 'Repo.find')?.kind).toBe('method');
  });
});

describe('regex fallback', () => {
  it('extracts Ruby classes and methods', () => {
    const syms = extractSymbols(
      'ruby',
      `class Account\n  def balance\n    0\n  end\n\n  def self.build(x)\n  end\nend\n`,
    );
    expect(by(syms, 'Account')?.kind).toBe('class');
    expect(by(syms, 'Account.balance')?.kind).toBe('method');
    expect(by(syms, 'Account.build')?.kind).toBe('method');
  });

  it('extracts Rust items with pub visibility', () => {
    const syms = extractSymbols(
      'rust',
      `pub fn open(path: &str) -> File {\n}\nfn private() {}\npub struct Config {\n  a: u8,\n}\npub trait Store {}\n`,
    );
    expect(by(syms, 'open')).toMatchObject({ kind: 'function', exported: true });
    expect(by(syms, 'private')?.exported).toBe(false);
    expect(by(syms, 'Config')?.kind).toBe('class');
    expect(by(syms, 'Store')?.kind).toBe('interface');
  });

  it('extracts Kotlin and PHP', () => {
    const k = extractSymbols(
      'kotlin',
      `class Repo {\n    fun load(id: String): User? {\n        return null\n    }\n    private fun hidden() {}\n}\n`,
    );
    expect(by(k, 'Repo.load')).toMatchObject({ kind: 'method', exported: true });
    expect(by(k, 'Repo.hidden')?.exported).toBe(false);
    const p = extractSymbols(
      'php',
      `<?php\nclass Cart {\n    public function add($item) {\n    }\n    private function calc() {\n    }\n}\n`,
    );
    expect(by(p, 'Cart.add')?.exported).toBe(true);
    expect(by(p, 'Cart.calc')?.exported).toBe(false);
  });

  it('works for TS when used directly', () => {
    const syms = extractSymbolsWithRegex(
      'typescript',
      `export function a(x: number) {\n}\nexport class B {\n  run(): void {\n  }\n  private stop() {\n  }\n}\n`,
    );
    expect(by(syms, 'a')?.exported).toBe(true);
    expect(by(syms, 'B.run')?.exported).toBe(true);
    expect(by(syms, 'B.stop')?.exported).toBe(false);
  });

  it('returns nothing for unknown languages and does not throw on garbage', () => {
    expect(extractSymbols('unknown', 'whatever')).toEqual([]);
    expect(() => extractSymbols('typescript', '}}}{{{ export function (((')).not.toThrow();
  });
});

describe('signatureParams', () => {
  it('splits parameters respecting nesting', () => {
    expect(
      signatureParams('function f(a: Map<string, number>, b = () => 1, c?: { x: 1, y: 2 })'),
    ).toEqual(['a: Map<string, number>', 'b = () => 1', 'c?: { x: 1, y: 2 }']);
    expect(signatureParams('def f(self)')).toEqual(['self']);
    expect(signatureParams('function g()')).toEqual([]);
    expect(signatureParams('const X: number')).toBeNull();
  });
});
