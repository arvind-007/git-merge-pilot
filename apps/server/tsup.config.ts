import { defineConfig } from 'tsup';

export default defineConfig({
  // dist/index.js is the runnable server (src/main.ts); the Dockerfile runs it directly.
  entry: { index: 'src/main.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Bundle workspace packages (consumed as TS source); keep npm deps external.
  noExternal: [/^@gmp\//],
  // Keep transitive npm deps of @gmp/* external too (the Docker image installs them hoisted).
  skipNodeModulesBundle: true,
  // Dependencies of the inlined workspace packages (e.g. dotenv via @gmp/core) may be CJS and
  // get bundled; give them a real `require` inside the ESM output.
  banner: {
    js: "import { createRequire as __gmpCreateRequire } from 'node:module'; const require = __gmpCreateRequire(import.meta.url);",
  },
});
