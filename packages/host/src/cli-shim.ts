import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Writes the `hangar` launchers into `dir` (prepended to every session's PATH).
 * They run the bundled CLI with Hangar's own Electron binary in Node mode, so no
 * separate Node installation is needed.
 */
export function writeCliShim(
  dir: string,
  execPath: string,
  cliPath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  mkdirSync(dir, { recursive: true });
  if (platform === 'win32') {
    writeFileSync(
      join(dir, 'hangar.cmd'),
      `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${execPath}" "${cliPath}" %*\r\n`,
    );
    return;
  }
  const shim = join(dir, 'hangar');
  writeFileSync(
    shim,
    `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(execPath)} ${shellQuote(cliPath)} "$@"\n`,
  );
  chmodSync(shim, 0o755);
}

/** Single-quoted sh literal: nothing inside is expanded. */
const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
