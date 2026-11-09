import { defineConfig } from 'vitest/config';

// Only for `pnpm test:ssh`; the root config does not pick these files up.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['*.check.ts'],
    testTimeout: 60_000,
  },
});
