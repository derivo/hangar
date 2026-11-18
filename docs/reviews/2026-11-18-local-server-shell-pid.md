# Review: local-server e2e reads the shell pid from a file (2026-11-18)

Reviewer: Codex (`codex exec -s read-only`), one round on the diff of branch
`test/local-server-shell-pid`.

## Context

`local-server.spec.ts` ("the agent bay moves into the local server") failed on
macOS CI in runs 43970975387 and 44192441915, all three attempts each: after
`kill -9` and a restart, the poll for `AFTERKILL=<pid>` on the screen timed out.
The screenshots show the command followed directly by the next prompt, and
characters missing at wrap points, so pty and xterm differed in width. The probable
cause is the resize after the reconnect: the shell redraws its prompt over the
output line. `shellPid` now has the shell write `$$` to a temporary file and reads
that file; the test still proves that input reaches the same shell. Output reaching
the UI stays covered by `RUN_AS_NODE=[]` and the description `nach-neustart`.

## Findings

No findings.

## Verification

- Not reproducible locally: 8 of 8 passed with `--repeat-each=8` before the change.
- After the change: `local-server.spec.ts` with `--repeat-each=3`: 15 passed,
  3 skipped (packaged only); no `hangar-e2e-pid-*` folder left behind.
- `pnpm lint`, `pnpm typecheck` exit 0.
- Not known: whether the change ends the CI failures; that needs several macOS runs.
