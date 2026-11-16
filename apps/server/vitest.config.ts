import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@gmp/server',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
