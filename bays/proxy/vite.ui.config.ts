import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Bay UI: loaded from disk by Hangar, so all asset paths must be relative.
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/ui'),
  base: './',
  plugins: [react()],
  build: { outDir: resolve(import.meta.dirname, 'dist/ui'), emptyOutDir: true },
});
