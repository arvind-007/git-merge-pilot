import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@gmp/github',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
