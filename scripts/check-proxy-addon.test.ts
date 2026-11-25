import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { createPackage } from '@electron/asar';
import { describe, expect, it } from 'vitest';

const script = resolve('scripts/check-proxy-addon.mjs');

/** Runs the check in a folder with a packaged addon and a fake `mitmdump` running `body`. */
async function check(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-check-addon-'));
  const app = join(dir, 'app', 'bays', 'proxy', 'dist', 'addon');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'hangar_proxy.py'), '# addon\n');
  mkdirSync(join(dir, 'apps', 'desktop', 'release', 'mac'), { recursive: true });
  await createPackage(join(dir, 'app'), join(dir, 'apps', 'desktop', 'release', 'mac', 'app.asar'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'mitmdump'), `#!/usr/bin/env node\n${body}\n`);
  chmodSync(join(bin, 'mitmdump'), 0o755);
  return spawnSync(process.execPath, [script], {
    cwd: dir,
    encoding: 'utf8',
    // A check that never ends comes back with status null instead of blocking the worker.
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      CHECK_PROXY_ADDON_TIMEOUT_MS: '1000',
    },
  });
}

// The fake mitmdump is a shebang script, which spawn cannot start on Windows.
describe.skipIf(process.platform === 'win32')('check-proxy-addon', () => {
  it('waits for the rest of a hello split across chunks', async () => {
    const result = await check(
      `process.stdout.write('{"type":"hello","version":"12.');
      setTimeout(() => process.stdout.write('3.1"}\\n'), 200);
      process.stdin.resume().on('end', () => process.exit(0));`,
    );
    expect(result.stderr).not.toContain('SyntaxError');
    expect(result.stdout).toContain('mitmproxy 12.3.1');
    expect(result.status).toBe(0);
  });

  it('fails when mitmdump only ends after the timeout, even with code 0', async () => {
    const result = await check(
      `process.stdout.write('{"type":"hello","version":"12.3.1"}\\n');
      process.on('SIGTERM', () => process.exit(0));
      setInterval(() => {}, 1000);`,
    );
    expect(result.status).toBe(1);
  });

  it('fails when mitmdump ignores SIGTERM', async () => {
    const result = await check(
      `process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);`,
    );
    expect(result.stderr).toContain('no hello or no exit within');
    expect(result.status).toBe(1);
  });

  it('does not count a log line that mentions "hello"', async () => {
    const result = await check(
      `process.stdout.write('{"type":"warning","message":"hello"}\\n');
      process.stdin.resume().on('end', () => process.exit(0));
      setTimeout(() => process.exit(0), 200);`,
    );
    expect(result.status).toBe(1);
  });
});
