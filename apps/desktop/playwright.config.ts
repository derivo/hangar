import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // One temporary folder per run (profiles, repos), removed at the end.
  globalSetup: '../../scripts/test-tmp.ts',
  // One Electron app per test, sharing nothing, but shells and git are CPU heavy.
  workers: 1,
  // The CI runners are slow enough that a different terminal wait fails once per run; a test that
  // passes on retry is reported as flaky, not as failed. Locally every failure counts.
  retries: process.env.CI ? 2 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
