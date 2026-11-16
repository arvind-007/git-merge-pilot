import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@gmp/ai',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
