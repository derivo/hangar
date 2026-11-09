import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempRepo } from './test-repo';
import { writeZshDir } from './zsh-prompt';

const ZSH = '/bin/zsh';

/** Runs a real zsh with Hangar's startup folder and a home with the user's own files. */
function zsh(args: string[], prompt: string, files: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hangar-zsh-home-'));
  writeFileSync(join(home, '.zshenv'), 'export FROM_ENV=env\n');
  writeFileSync(join(home, '.zprofile'), 'export FROM_PROFILE=profile\n');
  writeFileSync(join(home, '.zshrc'), 'export FROM_RC=rc\nPROMPT="own> "\n');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(home, name)), { recursive: true });
    writeFileSync(join(home, name), text);
  }
  const dir = writeZshDir(mkdtempSync(join(tmpdir(), 'hangar-zsh-data-')));
  const out = execFileSync(ZSH, args, {
    cwd: createTempRepo('prompt-repo'),
    env: { HOME: home, PATH: process.env.PATH!, TERM: 'dumb', ZDOTDIR: dir, HANGAR_PROMPT: prompt },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return { out: out.trim(), home };
}

describe.skipIf(!existsSync(ZSH))('zsh prompt (ADR 0025)', () => {
  it('loads the user files, then sets the prompt with folder and git branch', () => {
    const { out } = zsh(
      [
        '-l',
        '-i',
        '-c',
        'for f in $precmd_functions; $f; print -r -- "$FROM_ENV $FROM_PROFILE $FROM_RC|${ZDOTDIR-unset}|${HANGAR_PROMPT-none}"; print -rP -- "$PROMPT"',
      ],
      '%1~${vcs_info_msg_0_} %# ',
    );
    expect(out).toBe(`env profile rc|unset|none\nprompt-repo (main) %`);
  });

  it('keeps the own prompt when the setting is empty', () => {
    expect(zsh(['-l', '-i', '-c', 'print -r -- "$PROMPT"'], '').out).toBe('own>');
  });

  it('leaves a job shell (not interactive) with the user folder and no Hangar variables', () => {
    const { out } = zsh(
      ['-l', '-c', 'print -r -- "$FROM_PROFILE|${ZDOTDIR-unset}|${HANGAR_ZDOTDIR-none}"'],
      '> ',
    );
    expect(out).toBe('profile|unset|none');
  });

  it('follows a .zshenv that moves an unset ZDOTDIR, also for jobs', () => {
    const files = {
      '.zshenv': 'export ZDOTDIR="${ZDOTDIR:-$HOME/.config/zsh}"\n',
      '.config/zsh/.zprofile': 'export FROM_PROFILE=moved\n',
      '.config/zsh/.zshrc': 'export FROM_RC=moved\n',
    };
    const show = 'print -r -- "$FROM_PROFILE ${FROM_RC-} ${ZDOTDIR#$HOME}"';
    expect(zsh(['-l', '-i', '-c', show], '> ', files).out).toBe('moved moved /.config/zsh');
    expect(zsh(['-l', '-c', show], '> ', files).out).toBe('moved  /.config/zsh');
  });

  it('keeps the history in the user folder and sets the prompt again after .zlogin', () => {
    const { out, home } = zsh(['-l', '-i', '-c', 'print -r -- "$PROMPT|$HISTFILE"'], 'hangar> ', {
      '.zlogin': 'PROMPT="login> "\n',
    });
    expect(out).toBe(`hangar> |${home}/.zsh_history`);
  });
});
