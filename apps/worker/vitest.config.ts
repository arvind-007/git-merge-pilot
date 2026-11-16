import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@gmp/worker',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
