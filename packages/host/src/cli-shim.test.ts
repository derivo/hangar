import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeCliShim } from './cli-shim';

const tmp = () => mkdtempSync(join(tmpdir(), 'hangar-shim-'));

describe('writeCliShim', () => {
  it.skipIf(process.platform === 'win32')(
    'writes an executable sh launcher that runs the CLI',
    () => {
      const dir = join(tmp(), 'bin');
      const cli = join(tmp(), 'cli.mjs');
      writeFileSync(
        cli,
        'console.log(process.env.ELECTRON_RUN_AS_NODE, process.argv.slice(2).join(","))',
      );
      writeCliShim(dir, process.execPath, cli, 'darwin');

      expect(statSync(join(dir, 'hangar')).mode & 0o111).toBeTruthy();
      const out = execFileSync(join(dir, 'hangar'), ['status', 'a b'], { encoding: 'utf8' });
      expect(out.trim()).toBe('1 status,a b');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'treats install paths literally, even with shell syntax in them',
    () => {
      const base = join(tmp(), "it's $(echo pwned) `x`");
      const cli = join(base, 'cli.mjs');
      mkdirSync(base);
      writeFileSync(cli, 'console.log("ran")');
      const dir = join(tmp(), 'bin');
      writeCliShim(dir, process.execPath, cli, 'darwin');
      const out = execFileSync(join(dir, 'hangar'), [], { encoding: 'utf8' });
      expect(out.trim()).toBe('ran');
    },
  );

  it('writes a cmd launcher on Windows', () => {
    const dir = tmp();
    writeCliShim(dir, 'C:\\Hangar\\Hangar.exe', 'C:\\Hangar\\cli\\hangar.mjs', 'win32');
    expect(readFileSync(join(dir, 'hangar.cmd'), 'utf8')).toBe(
      '@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"C:\\Hangar\\Hangar.exe" "C:\\Hangar\\cli\\hangar.mjs" %*\r\n',
    );
  });
});
