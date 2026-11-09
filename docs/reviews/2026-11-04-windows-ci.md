# Review Windows and Linux CI fixes (2026-11-04)

Reviewer: Codex (`codex exec -s read-only`), diff before the commit. Scope:
`writeDurable` in `packages/relay/src/replay.ts`, `repoRoot` in
`bays/agents/src/main/git.ts`, the central test temp folder
(`scripts/test-tmp.ts`) and the tests skipped under Windows. Focus: durability
on Windows, path comparisons that now mismatch, skips that hide product bugs.

## Findings

1. **[P1] Durability on Windows.** The first fix skipped the folder fsync under
   Windows and relied on NTFS journaling. Node renames with `MoveFileExW`
   without `MOVEFILE_WRITE_THROUGH`; a power loss could lose a stored replay
   counter. **Adopted:** under Windows `writeDurable` opens the renamed file and
   flushes it (`fsync` → `FlushFileBuffers`). Test `durable.test.ts` "syncs the
   renamed file on Windows". **Open:** that this makes the rename itself
   durable on NTFS is not proven; Node offers no write-through rename.
2. **[P2] Duplicate projects after the update.** `repoRoot` now returns
   `C:\…`; projects stored before kept `C:/…`, and `addProject` compared with
   `===`. **Adopted:** the duplicate check compares with the resolved stored
   path. Test `sessions.test.ts` "rejects a duplicate whose stored path is
   spelled differently".

Codex found no product bug hidden by the skips (file modes, shebang fake ssh,
`SIGTERM` exit code, empty `PATH`). Not run under Windows; evidence is the next
CI run.

## Second round

Scope: `executableName: hangar` for Linux in `electron-builder.yml`, job tests
through cmd.exe (`PLAIN_SHELL`, `WIN` in `test-repo.ts`), local server tests
and the relay file mode check skipped under Windows.

1. **[P2] Ending a job on Windows.** Codex simulated the shell-only kill:
   children keep the pipes open, the job ends only when they do (950 ms for a
   100 ms limit). Existing gap, not a regression; the code already names it
   (`ponytail:` comment in `job-process.ts`). **Not adopted in this round:**
   the fix (`taskkill /T /F`) can only be checked on Windows; it is in
   `docs/STATUS.md` under Windows.

Confirmed by Codex: the cmd.exe test matches `shellCommand` (`/d /s /c`) and
`lastLine` (CRLF and edge spaces removed); `executableName` changes only the
Linux binary (electron-builder 26.18.0: macOS and Windows names and the three
artifact names unchanged, CI globs and updater unaffected).

## Third round (macOS E2E, relay container)

Scope: `grid-template-columns: minmax(0, 1fr)` in `bays/browser/src/ui/styles.css`
(reproduced locally: at 1024 px window width and 200 % zoom the bay was 514
CSS pixels wide in a 480 pixel viewport), `browser.spec.ts` resizes the window
to 1024 × 743 before the zoom check, `restore-view.spec.ts` bounds within a
1024 × 768 screen, relay smoke test opens the TLS folder to uid 1000.

1. **[P2] Folder rights in the operations guide.** `docs/relay-operations.md`
   named only readable files; the mounted folder needs the search right for uid
   1000 too. **Adopted.**
2. **TLS folder as the cause of `unhealthy`: not proven.** Codex: with
   `EACCES` the relay exits before listening, which fits, but the CI log does
   not show it. **Adopted:** the smoke test prints `docker logs` when the
   container does not become healthy, so the next failure names its cause.

Confirmed by Codex: the CSS change keeps the tab strip scrolling (`.tabs`
`min-width: 0`, `overflow-x: auto`, tabs `flex: none`); the new window bounds
fit the screen and the minimum window size.
