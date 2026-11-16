import { defineConfig } from 'tsup';

export default defineConfig({
  // dist/index.js is the process entrypoint (Dockerfile runs `node apps/worker/dist/index.js`).
  entry: { index: 'src/main.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Bundle workspace packages (consumed as TS source); keep every npm dependency external,
  // including transitive deps of @gmp/* (the Docker image installs them hoisted). Bundling
  // CommonJS deps into ESM breaks on their dynamic require() of Node builtins.
  noExternal: [/^@gmp\//],
  skipNodeModulesBundle: true,
});
