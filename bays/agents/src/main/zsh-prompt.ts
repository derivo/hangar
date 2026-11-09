import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

// zsh reads its startup files from $ZDOTDIR. Hangar points it at its own folder; each file
// there loads the user's file of the same name at top level (in a function, `typeset`
// in the user's file would become local) with the user's ZDOTDIR, set or unset as before,
// so a user .zshenv may still move it. .zshrc and, in a login shell, .zlogin set the
// prompt from HANGAR_PROMPT after the user's file; then ZDOTDIR goes back to the user's,
// so nested shells read the user's files directly. Shells that are not interactive (jobs)
// get it back after .zshenv.
const HEADER = '# Written by Hangar (ADR 0025); changes are overwritten.\n';
const LOAD = (file: string) => `_hangar_user_dir
[[ -r \${ZDOTDIR:-$HOME}/${file} ]] && source \${ZDOTDIR:-$HOME}/${file}
_hangar_user=\${ZDOTDIR-}
`;

const FILES: Record<string, string> = {
  '.zshenv': `${HEADER}_hangar_zdotdir=$ZDOTDIR
_hangar_user=\${HANGAR_ZDOTDIR-}
unset HANGAR_ZDOTDIR
_hangar_user_dir() {
  if [[ -n $_hangar_user ]]; then export ZDOTDIR=$_hangar_user; else unset ZDOTDIR; fi
}
_hangar_prompt() {
  [[ -n $HANGAR_PROMPT ]] || return 0
  autoload -Uz vcs_info add-zsh-hook
  zstyle ':vcs_info:*:hangar:*' formats ' (%b)'
  zstyle ':vcs_info:*:hangar:*' actionformats ' (%b|%a)'
  _hangar_vcs_info() { vcs_info hangar }
  add-zsh-hook precmd _hangar_vcs_info
  setopt prompt_subst
  PROMPT=$HANGAR_PROMPT
}
_hangar_done() {
  _hangar_user_dir
  unfunction _hangar_user_dir _hangar_prompt _hangar_done
  unset _hangar_user _hangar_zdotdir HANGAR_PROMPT
}
${LOAD('.zshenv')}if [[ -o interactive ]]; then ZDOTDIR=$_hangar_zdotdir; else _hangar_done; fi
`,
  '.zprofile': `${HEADER}${LOAD('.zprofile')}ZDOTDIR=$_hangar_zdotdir
`,
  '.zshrc': `${HEADER}# /etc/zshrc on macOS put the history into this folder.
[[ $HISTFILE == $_hangar_zdotdir/.zsh_history ]] && HISTFILE=\${_hangar_user:-$HOME}/.zsh_history
${LOAD('.zshrc')}_hangar_prompt
if [[ -o login ]]; then ZDOTDIR=$_hangar_zdotdir; else _hangar_done; fi
`,
  '.zlogin': `${HEADER}${LOAD('.zlogin')}_hangar_prompt
_hangar_done
`,
};

/** Writes Hangar's zsh startup files to `<dataDir>/zsh` and returns that folder. */
export function writeZshDir(dataDir: string): string {
  const dir = join(dataDir, 'zsh');
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(FILES)) writeFileSync(join(dir, name), text);
  return dir;
}

/**
 * Variables that make a zsh show `prompt` (zsh prompt syntax, `${vcs_info_msg_0_}` is the
 * git branch). None for another shell or an empty prompt: the user's own prompt stays.
 */
export function promptEnv(
  shellFile: string,
  prompt: string,
  dataDir: string,
  env: Record<string, string>,
): Record<string, string> {
  if (!prompt || basename(shellFile) !== 'zsh') return {};
  return {
    ZDOTDIR: writeZshDir(dataDir),
    ...(env.ZDOTDIR && { HANGAR_ZDOTDIR: env.ZDOTDIR }),
    HANGAR_PROMPT: prompt,
  };
}
