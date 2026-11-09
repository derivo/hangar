import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import setup from './test-tmp';

const KEYS = ['TMPDIR', 'TEMP', 'TMP', 'HANGAR_TEST_TMP'];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('test-tmp', () => {
  it('gives a test run its own temporary folder and removes it with everything in it', () => {
    delete process.env.HANGAR_TEST_TMP;
    const teardown = setup();
    const dir = process.env.TMPDIR!;
    expect(dir).toMatch(/hangar-test-run-/);
    expect(tmpdir()).toBe(dir);
    expect(realpathSync.native(dir)).toBe(dir);
    writeFileSync(join(dir, 'left-over'), '');
    // A second setup in the same run (one per Vitest project) keeps the first folder.
    setup()();
    expect(process.env.TMPDIR).toBe(dir);
    expect(existsSync(dir)).toBe(true);
    teardown();
    expect(existsSync(dir)).toBe(false);
    // The environment is as before, so a second run (watch mode) gets a new folder.
    expect(process.env.HANGAR_TEST_TMP).toBeUndefined();
    expect(process.env.TMPDIR).toBe(saved.TMPDIR);
  });
});
