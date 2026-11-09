import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    css: true,
    // Random order exposes tests that depend on each other; the seed is printed on failure.
    sequence: { shuffle: true },
    // One temporary folder per run, removed at the end (scripts/test-tmp.ts).
    globalSetup: ['./scripts/test-tmp.ts'],
    coverage: {
      provider: 'v8',
      // Coverage gate (spec §8): packages, the main part of every bay, server and desktop main process.
      include: [
        'packages/*/src/**/*.ts',
        'bays/*/src/main/**/*.ts',
        'apps/server/src/**/*.ts',
        'apps/relay/src/**/*.ts',
        'apps/desktop/src/main/**/*.ts',
        'apps/desktop/src/preload/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        '**/types.ts',
        '**/test-*.ts',
        'apps/server/src/main.ts',
        'apps/relay/src/main.ts',
        // Entry point of the CLI; hangar.test.ts runs it as a child process.
        'packages/cli/src/hangar.ts',
        // Wiring of the Electron app; covered by the E2E tests.
        'apps/desktop/src/main/index.ts',
      ],
      thresholds: { lines: 90, branches: 90 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'packages/*/src/**/*.test.ts',
            'bays/*/src/main/**/*.test.ts',
            'apps/desktop/src/main/**/*.test.ts',
            'apps/server/src/**/*.test.ts',
            'apps/relay/src/**/*.test.ts',
            'scripts/**/*.test.ts',
          ],
          testTimeout: 20_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: [
            'apps/desktop/src/renderer/**/*.test.tsx',
            'apps/desktop/src/preload/**/*.test.ts',
            'bays/*/src/ui/**/*.test.{ts,tsx}',
          ],
          setupFiles: ['./vitest.setup-ui.ts'],
        },
      },
    ],
  },
});
