import { describe, expect, it } from 'vitest';
import {
  parseCodeowners,
  parseGemfile,
  parseGoMod,
  parseGoWork,
  parseGradleSettings,
  parsePnpmWorkspace,
  parsePom,
  parseRequirementsTxt,
  parseTomlLite,
  pep508Name,
} from './parsers.ts';

describe('parseTomlLite', () => {
  it('parses sections, multi-line arrays, inline tables, dotted keys and comments', () => {
    const doc = parseTomlLite(`
name = "root" # comment
[project]
name = "svc-api"
dependencies = [
  "fastapi>=0.110",  # web
  'SQLAlchemy[asyncio]~=2.0',
  "pydantic",
]
[project.optional-dependencies]
test = ["pytest>=8", "hypothesis"]

[tool.poetry.dependencies]
python = "^3.12"
django = { version = "^5", extras = ["argon2"] }

[workspace]
members = ["crates/*", "tools/cli"]
"quoted.key" = 'x#y'
tool.uv.package = true
`);
    expect(doc['']?.name).toBe('root');
    expect(doc.project?.name).toBe('svc-api');
    expect(doc.project?.dependencies).toEqual([
      'fastapi>=0.110',
      'SQLAlchemy[asyncio]~=2.0',
      'pydantic',
    ]);
    expect(doc['project.optional-dependencies']?.test).toEqual(['pytest>=8', 'hypothesis']);
    expect(doc['tool.poetry.dependencies']?.django).toEqual({ version: '^5', extras: ['argon2'] });
    expect(doc.workspace?.members).toEqual(['crates/*', 'tools/cli']);
    expect(doc.workspace?.['quoted.key']).toBe('x#y');
    expect(doc['workspace.tool.uv']?.package).toBe('true');
  });

  it('never throws on garbage', () => {
    expect(() => parseTomlLite('[[[\n= = =\n"unterminated')).not.toThrow();
  });
});

describe('small manifest parsers', () => {
  it('pep508Name / requirements.txt', () => {
    expect(pep508Name('Django_Rest.Framework>=3 ; python_version>"3"')).toBe(
      'django-rest-framework',
    );
    expect(
      parseRequirementsTxt(
        '# c\nFlask==3.0\n-r base.txt\n-e .\ngit+https://x/y.git\nrequests[security] >= 2 # x\n\n',
      ),
    ).toEqual(['flask', 'requests']);
  });

  it('Gemfile', () => {
    expect(
      parseGemfile(
        "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\n  gem \"rspec-rails\"\n# gem 'nope'",
      ),
    ).toEqual(['rails', 'rspec-rails']);
  });

  it('go.mod and go.work', () => {
    expect(
      parseGoMod(`module example.com/svc

go 1.22

require github.com/gin-gonic/gin v1.10.0

require (
	github.com/stretchr/testify v1.9.0 // indirect
	gorm.io/gorm v1.25.0
)
`),
    ).toEqual({
      module: 'example.com/svc',
      requires: ['github.com/gin-gonic/gin', 'github.com/stretchr/testify', 'gorm.io/gorm'],
    });
    expect(parseGoWork('go 1.22\n\nuse (\n\t./svc/a\n\t./svc/b // b\n)\nuse ./lib\n')).toEqual([
      './svc/a',
      './svc/b',
      './lib',
    ]);
  });

  it('Gradle settings', () => {
    expect(
      parseGradleSettings(`rootProject.name = 'x'
include 'app', ':lib:core'
include(":feature-a")
// include 'commented'
`),
    ).toEqual(['app', 'lib/core', 'feature-a']);
  });

  it('pom.xml artifactId ignores parent/dependencies; reads modules', () => {
    expect(
      parsePom(`<project>
  <parent><artifactId>spring-boot-starter-parent</artifactId></parent>
  <artifactId>billing-root</artifactId>
  <modules><module>billing-api</module><module> billing-core </module></modules>
  <dependencies><dependency><artifactId>junit</artifactId></dependency></dependencies>
</project>`),
    ).toEqual({ artifactId: 'billing-root', modules: ['billing-api', 'billing-core'] });
  });

  it('pnpm-workspace.yaml', () => {
    expect(
      parsePnpmWorkspace(
        "packages:\n  - 'packages/*'\n  - \"apps/**\"\n  - '!**/test/**'\nallowBuilds:\n  - x\n",
      ),
    ).toEqual(['packages/*', 'apps/**', '!**/test/**']);
    expect(parsePnpmWorkspace('packages: ["a/*", "b"]')).toEqual(['a/*', 'b']);
  });

  it('CODEOWNERS', () => {
    expect(
      parseCodeowners(`# owners
*       @acme-org/core
/docs/  @dev-alice docs@example.com # inline
/src/legacy/
[Section]
path\\ with\\ spaces/ @dev-bob
`),
    ).toEqual([
      { pattern: '*', owners: ['@acme-org/core'] },
      { pattern: '/docs/', owners: ['@dev-alice', 'docs@example.com'] },
      { pattern: '/src/legacy/', owners: [] },
      { pattern: 'path with spaces/', owners: ['@dev-bob'] },
    ]);
  });
});
