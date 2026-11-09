# Review gaps of the local server (2026-11-03)

Reviewer: Codex (`codex exec -s read-only`), diff before the commit. Scope: the
gaps from `docs/STATUS.md` on ADR 0036 that can be closed without a remote –
duplicate agent bay after a failed stop, tabs after a session ends without the
app, permission dialog after a connection loss, tray counts shells
(`ctx.setRunning`), notice "New version ready" at 200 % zoom; plus tests for
worktrees on the way back and the notice with a real old runtime copy.

## Findings

1. **[P2] Abort only after the close handshake.** `Connection.close()` only
   started the handshake; until the `close` event the signal of the call stayed
   open. **Adopted:** `close()` aborts the running calls immediately. Test
   `bridge.test.ts` "fails a call while no desktop offered …".
2. **[P2] A restart of the server loses remembered session ends.** If a session
   ends without the app and the server restarts before the next offer, its tabs
   stay until the app restarts. **Not adopted:** two rare events in a row; the
   tabs live only in the app's memory and end with it. Comment `ponytail:` in
   `apps/server/src/bridge.ts`.
3. **[P3] Shell count wrong after a failed restart.** `restart()` stopped the
   old shell but reported nothing on an error. **Adopted:** `changed()` in the
   `finally`. Test `sessions.test.ts` "reports the stopped shell
   also when its restart fails".

## Not checked

- Codex ran without tests (read-only sandbox).
- E2E: `out/` 10 green, 1 skipped (packaged only); packaged app (built into the
  scratchpad, unsigned) 53 green – before fixes 1 and 3, both proven with unit
  tests.
