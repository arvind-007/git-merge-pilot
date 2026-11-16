import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@gmp/notify',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
