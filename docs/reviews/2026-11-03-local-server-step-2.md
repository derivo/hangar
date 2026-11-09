# Review local server, step 2 (2026-11-03)

Reviewer: Codex (`codex exec -s read-only`), diff before the commit. Scope: ADR
0036 step 2 – one-time migration, agent bay only in the server, folder dialog
for the local server, shell environment without `ELECTRON_RUN_AS_NODE`.

## Findings

Every adopted finding began with a red test.

1. **[P1] Worktrees break when moved.** The sessions in `state.json` still
   pointed to the old folder, Git did not know the new paths. **Adopted:**
   `worktreePath` is rewritten, then `git worktree repair`. Test
   `local-server.test.ts` with real Git.
2. **[P1] Existing server data was lost.** Data from step 1 in the server
   folder was overwritten. **Adopted:** it is renamed to
   `<id>.before-migration`.
3. **[P2] Migration continued despite a failed `bootout`.** The running server
   would have kept writing the data while it was moved. **Adopted:** error
   "Stopping the local server failed"; without a marker, the app starts the bay
   itself as before.
4. **[P2] Permissions of the server overruled denials of the app.**
   **Adopted:** when merging `permissions.json` and `jobs.json` the entries of
   the app win.
5. **[P2] Several runtime copies were merged.** The UI of a bay then came from
   the wrong version. **Adopted:** `discoverBays` per root.
6. **[P2] Read errors counted as a missing file.** **Adopted:** `readJson`
   returns `undefined` only for `ENOENT` or broken JSON and throws otherwise.

## Found outside of Codex

- Unhandled "Not connected" rejections in the agents UI (`remote`, `state`,
  `quota` on first load). Now with `.catch`; test in `App.test.tsx`.
- `e2e/terminal-copy.spec.ts` broke with the long temp path since `92237a8`
  (line wrap); the check now compares in the shell.

## Not checked

Codex ran without a real LaunchAgent. The run is proven by
`e2e/local-server.spec.ts` (quit, `kill -9`, bundle swap, same shell PID, MCP
call from the shell that keeps running), also against the packaged app.
