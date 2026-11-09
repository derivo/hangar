// Test helper: creates throw-away git repositories (spec §8: never touch real projects).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitEnv } from './git';

export function createTempRepo(name = 'repo'): string {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'hangar-git-'))), name);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: gitEnv() });
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore', env: gitEnv() });
  // Windows runners set core.autocrlf; checkouts would get \r\n.
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'README.md'), '# test\n');
  git('add', '.');
  git(
    '-c',
    'user.name=Hangar Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'init',
  );
  return dir;
}

export const WIN = process.platform === 'win32';

/** Shell without the user's profile for real jobs: `/bin/sh`, on Windows cmd.exe. */
export const PLAIN_SHELL = WIN
  ? { file: process.env.ComSpec ?? 'cmd.exe', args: [] }
  : { file: '/bin/sh', args: [] };
