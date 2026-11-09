import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `os.tmpdir()` reads TMPDIR on macOS and Linux, TEMP and TMP on Windows.
const KEYS = ['TMPDIR', 'TEMP', 'TMP', 'HANGAR_TEST_TMP'] as const;

/**
 * Global setup of Vitest and Playwright: every `mkdtemp(tmpdir())` of a test run lands in one
 * folder that is removed at the end. Tests no longer clean up one by one; before this the
 * system's temp folder grew by gigabytes (E2E profiles) per run. Workers, Electron and shells
 * inherit the environment.
 */
export default function setup(): () => void {
  if (process.env.HANGAR_TEST_TMP) return () => {};
  const before = KEYS.map((key) => [key, process.env[key]] as const);
  // Real path: Windows runners give a short 8.3 name (RUNNER~1), macOS a /var link to
  // /private/var; code that resolves paths would otherwise not match the test's own.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'hangar-test-run-')));
  for (const key of KEYS) process.env[key] = dir;
  return () => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    // A second run in the same process (watch mode) starts with a folder of its own.
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
