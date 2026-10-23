import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * The Prisma client generated with `runtime = "cloudflare"` loads its query
 * compiler via `import('./x.wasm?module')` (a workerd/wrangler convention that
 * yields a WebAssembly.Module). Emulate that in Node for the tests.
 */
function wasmModulePlugin(): Plugin {
  const prefix = '\0wasm-module:';

  return {
    name: 'umami-cloudflare-wasm-module',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!source.endsWith('.wasm?module') || !importer) return null;
      return prefix + path.resolve(path.dirname(importer), source.replace(/\?module$/, ''));
    },
    load(id) {
      if (!id.startsWith(prefix)) return null;
      const file = id.slice(prefix.length);
      return `import fs from 'node:fs'; export default new WebAssembly.Module(fs.readFileSync(${JSON.stringify(file)}));`;
    },
  };
}

// Tests for the Cloudflare (D1/KV/Workers) conversion. Run with `pnpm cf:test`.
export default defineConfig({
  plugins: [wasmModulePlugin()],
  resolve: {
    alias: [
      {
        find: '@/lib/redis',
        replacement: fileURLToPath(new URL('./src/lib/cloudflare/redis.ts', import.meta.url)),
      },
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/cloudflare/**/*.test.ts', 'src/lib/cloudflare/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
