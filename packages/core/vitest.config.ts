import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@gmp/core',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
