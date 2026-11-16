import { describe, expect, it } from 'vitest';
import { analyzeRepositoryTree, selectDiscoveryFiles } from './profile.ts';

const NOW = new Date('2026-11-14T00:00:00Z');

function analyze(
  files: Record<string, string>,
  extraPaths: string[] = [],
  languages: Record<string, number> = {},
) {
  return analyzeRepositoryTree({
    paths: [...Object.keys(files), ...extraPaths],
    files,
    languages,
    defaultBranch: 'main',
    headSha: 'a'.repeat(40),
    now: NOW,
  });
}

describe('analyzeRepositoryTree: JS/TS pnpm monorepo', () => {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: 'root',
      private: true,
      packageManager: 'pnpm@9.0.0',
      devDependencies: { typescript: '^5', turbo: '^2', '@playwright/test': '^1' },
      scripts: { test: 'node --test' },
    }),
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - 'apps/*'\n  - '!packages/legacy'\n",
    'packages/api/package.json': JSON.stringify({
      name: '@acme/api',
      dependencies: { fastify: '^5', 'drizzle-orm': '^1', '@trpc/server': '^11' },
      devDependencies: { vitest: '^3', nock: '^15' },
    }),
    'packages/legacy/package.json': JSON.stringify({
      name: '@acme/legacy',
      dependencies: { express: '^4' },
    }),
    'apps/web/package.json': JSON.stringify({
      name: '@acme/web',
      dependencies: { react: '^18', 'react-dom': '^18', next: '^15' },
      devDependencies: { vite: '^6', '@testing-library/react': '^16', '@storybook/react': '^8' },
    }),
    '.github/workflows/ci.yml':
      'jobs:\n  a:\n    steps:\n      - uses: github/codeql-action/init@v3\n      - uses: gitleaks/gitleaks-action@v2\n      - run: pnpm audit\n',
    '.github/workflows/release.yaml': 'jobs: {}\n',
    '.github/CODEOWNERS': '* @acme/core\n/apps/web/ @acme/frontend\n',
    '.pre-commit-config.yaml': 'repos:\n  - repo: https://github.com/Yelp/detect-secrets\n',
  };
  const extra = [
    'pnpm-lock.yaml',
    'turbo.json',
    'CODEOWNERS',
    'docs/CODEOWNERS',
    '.github/dependabot.yml',
    '.github/pull_request_template.md',
    '.github/PULL_REQUEST_TEMPLATE/feature.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'docs/adr/0001-use-postgres.md',
    'docs/architecture/decisions/0002-x.md',
    'docs/architecture-overview.md',
    'ARCHITECTURE.md',
    'Dockerfile',
    'docker-compose.yml',
    'infra/main.tf',
    'charts/api/Chart.yaml',
    '.semgrep.yml',
    '.gitleaks.toml',
    'apps/web/vite.config.ts',
    'packages/api/vitest.config.ts',
    'apps/web/playwright.config.ts',
    'tsconfig.json',
    'node_modules/left-pad/package.json',
    'packages/api/node_modules/x/package.json',
    'Makefile',
  ];
  const profile = analyze(files, extra, { TypeScript: 9000, JavaScript: 1000, Dockerfile: 10 });

  it('detects languages, frameworks, tools and package managers', () => {
    expect(profile.primaryLanguage).toBe('TypeScript');
    expect(profile.frameworks).toEqual(
      expect.arrayContaining(['fastify', 'drizzle', 'trpc', 'react', 'nextjs', 'express']),
    );
    expect(profile.buildTools).toEqual(
      expect.arrayContaining(['typescript', 'turborepo', 'vite', 'make']),
    );
    expect(profile.packageManagers).toEqual(['pnpm']);
    expect(profile.testFrameworks).toEqual(
      expect.arrayContaining([
        'vitest',
        'playwright',
        'testing-library',
        'storybook',
        'node-test',
        'nock',
      ]),
    );
    expect(profile.infrastructure).toEqual(
      expect.arrayContaining(['docker', 'docker-compose', 'terraform', 'helm']),
    );
  });

  it('detects CI and security tools from paths and workflow content', () => {
    expect(profile.ciSystems).toEqual(['github-actions']);
    expect(profile.ciWorkflows).toEqual([
      '.github/workflows/ci.yml',
      '.github/workflows/release.yaml',
    ]);
    expect(profile.securityTools).toEqual(
      expect.arrayContaining([
        'codeql',
        'gitleaks',
        'dependabot',
        'semgrep',
        'npm-audit',
        'detect-secrets',
      ]),
    );
  });

  it('resolves CODEOWNERS precedence (.github, root, docs) and parses rules', () => {
    expect(profile.codeowners).toBe('.github/CODEOWNERS');
    expect(profile.codeownersFiles).toEqual([
      '.github/CODEOWNERS',
      'CODEOWNERS',
      'docs/CODEOWNERS',
    ]);
    expect(profile.codeownersRules).toEqual([
      { pattern: '*', owners: ['@acme/core'] },
      { pattern: '/apps/web/', owners: ['@acme/frontend'] },
    ]);
  });

  it('finds templates, contributing, security policy, docs and ADRs', () => {
    expect(profile.prTemplate).toBe('.github/pull_request_template.md');
    expect(profile.prTemplates).toEqual([
      '.github/pull_request_template.md',
      '.github/PULL_REQUEST_TEMPLATE/feature.md',
    ]);
    expect(profile.contributing).toBe('CONTRIBUTING.md');
    expect(profile.securityPolicy).toBe('SECURITY.md');
    expect(profile.docsDirs).toEqual(['docs']);
    expect(profile.adrDirs).toEqual(['docs/adr', 'docs/architecture/decisions']);
    expect(profile.architectureDocs).toEqual(
      expect.arrayContaining(['ARCHITECTURE.md', 'docs/architecture-overview.md', 'docs/adr/']),
    );
  });

  it('resolves workspace packages (with negation) and ignores node_modules', () => {
    expect(profile.monorepoTools).toEqual(['pnpm-workspace', 'turborepo']);
    expect(profile.isMonorepo).toBe(true);
    expect(profile.packages).toEqual([
      { name: '@acme/web', path: 'apps/web', ecosystem: 'npm' },
      { name: '@acme/api', path: 'packages/api', ecosystem: 'npm' },
    ]);
    expect(profile.manifests).not.toContain('node_modules/left-pad/package.json');
    expect(profile.headSha).toBe('a'.repeat(40));
    expect(profile.discoveredAt).toBe(NOW.toISOString());
  });
});

describe('analyzeRepositoryTree: other ecosystems', () => {
  it('Python (poetry + fastapi + pytest) with requirements and uv workspace', () => {
    const p = analyze(
      {
        'pyproject.toml': `[tool.poetry]\nname = "svc"\n[tool.poetry.dependencies]\npython = "^3.12"\nfastapi = "^0.110"\nsqlalchemy = "^2"\n[tool.poetry.group.dev.dependencies]\npytest = "^8"\n[build-system]\nrequires = ["poetry-core"]\n[tool.uv.workspace]\nmembers = ["libs/*"]\n[tool.bandit]\nskips = []\n`,
        'libs/core/pyproject.toml':
          '[project]\nname = "acme-core"\ndependencies = ["celery>=5", "Django>=5"]\n',
        'requirements-dev.txt': 'hypothesis\n',
      },
      ['poetry.lock', 'conftest.py', 'tox.ini'],
    );
    expect(p.frameworks).toEqual(
      expect.arrayContaining(['fastapi', 'sqlalchemy', 'celery', 'django']),
    );
    expect(p.testFrameworks).toEqual(expect.arrayContaining(['pytest', 'hypothesis', 'tox']));
    expect(p.packageManagers).toEqual(expect.arrayContaining(['poetry', 'pip']));
    expect(p.buildTools).toContain('poetry');
    expect(p.securityTools).toContain('bandit');
    expect(p.monorepoTools).toEqual(['uv-workspace']);
    expect(p.packages).toEqual([{ name: 'acme-core', path: 'libs/core', ecosystem: 'python' }]);
  });

  it('Go workspace (go.work) with gin/testify and _test.go files', () => {
    const p = analyze(
      {
        'go.work': 'go 1.22\nuse (\n  ./svc/orders\n  ./svc/billing\n)\n',
        'svc/orders/go.mod':
          'module example.com/orders\nrequire (\n  github.com/gin-gonic/gin v1.10.0\n  github.com/stretchr/testify v1.9.0\n)\n',
        'svc/billing/go.mod':
          'module example.com/billing\nrequire google.golang.org/grpc v1.60.0\n',
      },
      ['svc/orders/main_test.go', 'svc/orders/go.sum'],
    );
    expect(p.frameworks).toEqual(['gin', 'grpc']);
    expect(p.testFrameworks).toEqual(['go-test', 'testify']);
    expect(p.monorepoTools).toEqual(['go-work']);
    expect(p.packages).toEqual([
      { name: 'example.com/billing', path: 'svc/billing', ecosystem: 'go' },
      { name: 'example.com/orders', path: 'svc/orders', ecosystem: 'go' },
    ]);
  });

  it('Java Maven multi-module (Spring Boot + JUnit 5) and Gradle multi-project', () => {
    const maven = analyze(
      {
        'pom.xml':
          '<project><artifactId>root</artifactId><modules><module>api</module></modules><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency><dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId></dependency></dependencies></project>',
        'api/pom.xml':
          '<project><parent><artifactId>root</artifactId></parent><artifactId>orders-api</artifactId></project>',
      },
      ['mvnw', 'api/src/test/java/OrdersTest.java', 'Jenkinsfile'],
    );
    expect(maven.frameworks).toEqual(expect.arrayContaining(['spring-boot', 'spring']));
    expect(maven.testFrameworks).toEqual(expect.arrayContaining(['junit5', 'junit']));
    expect(maven.buildTools).toContain('maven');
    expect(maven.packageManagers).toContain('maven');
    expect(maven.ciSystems).toEqual(['jenkins']);
    expect(maven.packages).toEqual([{ name: 'orders-api', path: 'api', ecosystem: 'maven' }]);
    expect(maven.monorepoTools).toEqual(['maven-modules']);

    const gradle = analyze(
      {
        'settings.gradle.kts': 'include(":app", ":lib:core")\n',
        'app/build.gradle.kts':
          'plugins { id("io.ktor.plugin") }\ndependencies { testImplementation("io.kotest:kotest-runner-junit5:5.8.0") }\n',
      },
      ['gradlew', 'lib/core/build.gradle.kts'],
    );
    expect(gradle.frameworks).toContain('ktor');
    expect(gradle.testFrameworks).toContain('kotest');
    expect(gradle.buildTools).toContain('gradle');
    expect(gradle.packages.map((p) => p.path)).toEqual(['app', 'lib/core']);
  });

  it('Rust workspace, Ruby, PHP and .NET', () => {
    const rust = analyze(
      {
        'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/old"]\n',
        'crates/server/Cargo.toml':
          '[package]\nname = "server"\n[dependencies]\naxum = "0.7"\ntokio = { version = "1", features = ["full"] }\n[dependencies.sqlx]\nversion = "0.8"\n',
        'crates/old/Cargo.toml': '[package]\nname = "old"\n',
      },
      ['Cargo.lock'],
    );
    expect(rust.frameworks).toEqual(['axum', 'sqlx', 'tokio']);
    expect(rust.packageManagers).toEqual(['cargo']);
    expect(rust.monorepoTools).toEqual(['cargo-workspace']);
    expect(rust.packages).toEqual([{ name: 'server', path: 'crates/server', ecosystem: 'cargo' }]);

    const ruby = analyze({ Gemfile: "gem 'rails'\ngem 'rspec-rails'\ngem 'brakeman'\n" }, [
      'Gemfile.lock',
      '.rspec',
    ]);
    expect(ruby.frameworks).toEqual(['rails']);
    expect(ruby.testFrameworks).toEqual(['rspec']);
    expect(ruby.packageManagers).toEqual(['bundler']);
    expect(ruby.securityTools).toEqual(['brakeman']);

    const php = analyze(
      {
        'composer.json': JSON.stringify({
          require: { 'laravel/framework': '^11' },
          'require-dev': { 'pestphp/pest': '^2' },
        }),
      },
      ['composer.lock', 'phpunit.xml'],
    );
    expect(php.frameworks).toEqual(['laravel']);
    expect(php.testFrameworks).toEqual(['pest', 'phpunit']);
    expect(php.packageManagers).toEqual(['composer']);

    const dotnet = analyze(
      {
        'src/Api/Api.csproj':
          '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore" /></ItemGroup></Project>',
        'tests/Api.Tests/Api.Tests.csproj':
          '<Project><ItemGroup><PackageReference Include="xunit" /></ItemGroup></Project>',
      },
      ['Api.sln', 'azure-pipelines.yml'],
    );
    expect(dotnet.frameworks).toEqual(['aspnet-core', 'ef-core']);
    expect(dotnet.testFrameworks).toEqual(['xunit']);
    expect(dotnet.buildTools).toContain('dotnet');
    expect(dotnet.ciSystems).toEqual(['azure-pipelines']);
  });

  it('heuristic multi-service repo without a workspace declaration', () => {
    const p = analyze(
      {
        'services/api/go.mod': 'module example.com/api\n',
        'services/web/package.json': JSON.stringify({ name: 'web', dependencies: { vue: '^3' } }),
        'examples/demo/package.json': JSON.stringify({ name: 'demo' }),
        'services/web/sub/package.json': JSON.stringify({ name: 'nested' }),
      },
      ['.gitlab-ci.yml'],
    );
    expect(p.monorepoTools).toEqual(['heuristic']);
    expect(p.isMonorepo).toBe(true);
    expect(p.packages).toEqual([
      { name: 'example.com/api', path: 'services/api', ecosystem: 'go' },
      { name: 'web', path: 'services/web', ecosystem: 'npm' },
    ]);
    expect(p.ciSystems).toEqual(['gitlab-ci']);
    expect(p.packageManagers).toEqual([]);
  });

  it('single package repo is not a monorepo; npm is implied without a lockfile', () => {
    const p = analyze(
      { 'package.json': JSON.stringify({ name: 'solo', dependencies: { koa: '^2' } }) },
      ['README.md'],
    );
    expect(p.isMonorepo).toBe(false);
    expect(p.packages).toEqual([]);
    expect(p.packageManagers).toEqual(['npm']);
    expect(p.frameworks).toEqual(['koa']);
    expect(p.codeowners).toBeNull();
    expect(p.prTemplate).toBeNull();
    expect(p.primaryLanguage).toBeNull();
  });

  it('tolerates malformed manifests and reports tree truncation', () => {
    const p = analyzeRepositoryTree({
      paths: ['package.json', 'pyproject.toml', 'composer.json'],
      files: { 'package.json': '{not json', 'pyproject.toml': '[[[', 'composer.json': 'null' },
      defaultBranch: 'main',
      headSha: 'b'.repeat(40),
      treeTruncated: true,
      limitations: ['x'],
    });
    expect(p.frameworks).toEqual([]);
    expect(p.treeTruncated).toBe(true);
    expect(p.limitations).toEqual([
      'x',
      'Repository tree was truncated by GitHub; some files were not inspected',
    ]);
  });
});

describe('selectDiscoveryFiles', () => {
  it('prioritises root workspace files, CODEOWNERS, root manifests, workflows, then nested manifests', () => {
    const paths = [
      'packages/z/package.json',
      'a/b/c/d/e/f/g/package.json',
      '.github/workflows/ci.yml',
      'package.json',
      'pnpm-workspace.yaml',
      'CODEOWNERS',
      '.github/CODEOWNERS',
      'node_modules/x/package.json',
      'README.md',
      'services/api/requirements.txt',
    ];
    expect(selectDiscoveryFiles(paths)).toEqual([
      'pnpm-workspace.yaml',
      '.github/CODEOWNERS',
      'package.json',
      '.github/workflows/ci.yml',
      'packages/z/package.json',
      'services/api/requirements.txt',
    ]);
    expect(selectDiscoveryFiles(paths, 2)).toEqual(['pnpm-workspace.yaml', '.github/CODEOWNERS']);
  });
});
