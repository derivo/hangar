import { resolve } from 'node:path';
import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

// One file with ws and @hangar/relay bundled in.
export default defineConfig({
  build: {
    ssr: resolve(import.meta.dirname, 'src/main.ts'),
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: { format: 'es', entryFileNames: 'hangar-relay.mjs', banner: '#!/usr/bin/env node' },
    },
  },
  ssr: { noExternal: true },
});
