import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@gmp/analysis',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
