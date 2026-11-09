import { defineConfig } from 'vitest/config';

// Only for `pnpm test:container`; the root config does not pick these files up.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['*.check.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
