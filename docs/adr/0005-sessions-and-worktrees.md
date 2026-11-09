# ADR 0005: Sessions, worktrees and the status heuristic

- Status: accepted
- Date: 2026-10-28

## Context

The specification does not define the location and end of life of worktrees,
the closing of sessions, or the exact effect of the 30-second heuristic.

## Decision

- **Location:** Worktrees live in the bay's data folder:
  `<userData>/bays/dev.hangar.agents/worktrees/<projekt>-<kurz-id>`. Branch:
  `hangar/<kurz-id>` (first 8 characters of the session UUID), the base is the
  current HEAD of the repository.
- **Closing a session:** End the shell, `git worktree remove` **without**
  `--force`. If the worktree has uncommitted changes, it stays on disk (no work
  is lost); the branch is always kept. Removing a project closes all its
  sessions in the same way.
- **Status:** New sessions start as `idle`. Output turns `idle` into `working`;
  30 seconds without output turn `working` back into `idle`. `waiting` and
  `done` are set only by the agent (or the user); the heuristic never overwrites
  them, so a "waiting" hint is not lost through output.
- **Environment variables:** per session, names follow shell rules, `HANGAR_*`
  is reserved. A change restarts the shell so that it takes effect.
- **Ports:** Each session gets a block of 100 ports starting at 40000 (until
  2026-10-30: 10) (`HANGAR_PORT_BASE`), whose first port is free when the block
  is allocated.
- **Shell:** `$SHELL` (otherwise the account shell, otherwise `/bin/sh`) as a
  login shell (`-l`); on Windows `COMSPEC` or PowerShell.

## Consequences

- Worktrees of cleaned-up sessions disappear; leftover worktrees with changes
  must be removed by the user (`git worktree remove --force`).

## Addendum: restoration

- `state.json` (projects, sessions with description, env, ports, status bar) and
  per session `scrollback/<id>.log` (at most 500 000 characters, written every
  5 seconds and on exit) are stored.
- After a restart, each session starts a **new** shell in the same worktree; the
  old history is replayed first, separated by "— Hangar restarted —". Running
  programs (e.g. an agent) do not survive a restart; the status is therefore set
  to `idle`.
- If the old history ended in a full-screen program (alternate screen), it is
  left before the marker.
- If the worktree is missing, the session stays in the list without a shell.
