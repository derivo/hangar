# ADR 0025 – Prompt of the session shell as a text setting

Status: accepted. Extends [ADR 0023](0023-bay-settings.md).

## Context

The prompt in the terminals of the agent bay looked like `anna@laptop hangar %`.
Hangar already loads the zsh configuration completely: the shell runs in a pty,
so it is interactive, and starts with `-l` on macOS. It therefore reads
`.zshenv`, `.zprofile` and `.zshrc` without `ZDOTDIR` being set. The plain
prompt came from `/etc/zshrc` (`PS1="%n@%m %1~ %# "`), because the person's own
`.zshrc` set none. What is wanted is a prompt with folder and Git branch that
can be adjusted in the settings, and optionally the prompt of the person's own
zsh.

A `PS1` from the environment does not help, because `/etc/zshrc` overwrites it.

## Decision

- **Text settings for bays:** Manifest `settings` knows the type `text` besides
  `boolean` (`default` is a string). `ctx.settings.get` returns
  `boolean | string` (`SettingValue`); a stored value whose type differs from
  `default` is ignored. The Hangar settings show a text field and save every
  change.
- **Setting `prompt` of the agent bay** in zsh prompt syntax, default
  `%F{cyan}%~%f%F{magenta}${vcs_info_msg_0_}%f %# ` (folder, branch in
  parentheses). Empty means: the prompt of the person's own zsh, Hangar changes
  nothing.
- **Own `ZDOTDIR`:** If the shell is a zsh and the prompt is not empty, Hangar
  sets `ZDOTDIR=<dataDir>/zsh`, `HANGAR_PROMPT` and, if present, the old
  `ZDOTDIR` as `HANGAR_ZDOTDIR`. The files there each load the file of the same
  name of the person (at top level, not in a function), with their `ZDOTDIR`,
  set or unset as before; their own `.zshenv` may still move it. After the
  person's own `.zshrc` and, in a login shell, after their own `.zlogin`,
  Hangar sets `PROMPT` and hooks `vcs_info` (context `hangar`) into `precmd`.
  After that `ZDOTDIR` goes back to the person; nested shells read their own
  files again. Non-interactive shells (jobs) get it back right after `.zshenv`.
  The history that `/etc/zshrc` would put into Hangar's folder on macOS stays in
  `${ZDOTDIR:-$HOME}/.zsh_history`.
- Applies to new and restarted shells; running ones do not change.
- **zsh only:** bash, sh and Windows stay unchanged.

## Consequences

- Prompt tools that reset the prompt before every line (such as Powerlevel10k)
  win against the setting; whoever uses them empties the field.
- On macOS `/etc/zshrc` looks for `.zkbd` key definitions in Hangar's folder;
  whoever uses them loads them in their own `.zshrc` or empties the field.
- The setting is a freely written prompt with `prompt_subst`; it is evaluated
  like the person's own `.zshrc` and comes only from the person's
  `settings.json`.

## Alternatives

- **Build nothing, adjust `.zshrc`:** is enough for the own prompt, but offers
  no default with branch and no setting.
- **`PS1`/`PROMPT` through the environment:** overwritten by `/etc/zshrc`.
- **Own `-c` command line or `--rcs` tricks:** lose the login shell or the order
  of the startup files.
