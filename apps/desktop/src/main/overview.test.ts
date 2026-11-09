import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitIdentity } from './overview';

/** Environment whose global git config is a temporary file with `content`. */
function gitEnv(content: string) {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-git-'));
  writeFileSync(join(dir, 'gitconfig'), content);
  return { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: join(dir, 'gitconfig') };
}

describe('gitIdentity', () => {
  it('reads name and email from the global git config', async () => {
    const env = gitEnv('[user]\n\tname = Ada Lovelace\n\temail = ada@example.invalid\n');
    expect(await gitIdentity(env)).toEqual({
      installed: true,
      name: 'Ada Lovelace',
      email: 'ada@example.invalid',
    });
  });

  it('leaves out what is not set', async () => {
    expect(await gitIdentity(gitEnv('[user]\n\tname = Ada\n'))).toEqual({
      installed: true,
      name: 'Ada',
    });
  });

  it('reports git as missing when it cannot be run', async () => {
    expect(await gitIdentity({ PATH: '' })).toEqual({ installed: false });
  });
});
