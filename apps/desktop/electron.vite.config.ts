import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          shell: resolve(__dirname, 'src/preload/shell.ts'),
          bay: resolve(__dirname, 'src/preload/bay.ts'),
        },
      },
    },
  },
  renderer: {
    plugins: [react()],
  },
});
