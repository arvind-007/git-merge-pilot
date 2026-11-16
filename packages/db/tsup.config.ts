import { defineConfig } from 'tsup';

/**
 * Bundles the migrate CLI for the Docker image (`docker run IMAGE migrate`), which ships no tsx.
 * Workspace packages are inlined; npm dependencies stay external and resolve from the image's
 * hoisted node_modules. Migrations are read from packages/db/drizzle (next to dist/).
 */
export default defineConfig({
  entry: { 'migrate-cli': 'src/migrate-cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/^@gmp\//],
  skipNodeModulesBundle: true,
});
