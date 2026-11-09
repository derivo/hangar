import { resolve } from 'node:path';
import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

// One dependency-free file; Hangar runs it with its own Electron binary (ELECTRON_RUN_AS_NODE).
export default defineConfig({
  build: {
    ssr: resolve(import.meta.dirname, 'src/hangar.ts'),
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: { format: 'es', entryFileNames: 'hangar.mjs', banner: '#!/usr/bin/env node' },
    },
  },
});
