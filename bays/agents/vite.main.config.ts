import { resolve } from 'node:path';
import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

// Bay main part: one ESM file loaded by Hangar's main process. node-pty is native and
// is provided by the host's node_modules at runtime (ADR 0004).
export default defineConfig({
  build: {
    ssr: resolve(import.meta.dirname, 'src/main/index.ts'),
    outDir: resolve(import.meta.dirname, 'dist/main'),
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: {
      external: [
        'node-pty',
        'electron',
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
      ],
      output: { format: 'es', entryFileNames: 'index.js' },
    },
  },
  ssr: { noExternal: true, external: ['node-pty'] },
});
