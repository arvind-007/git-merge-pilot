import { defineConfig } from 'vitest/config';

// Vitest >=4 replaced vitest.workspace.ts with `test.projects`.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
  },
});
