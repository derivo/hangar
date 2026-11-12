# Review: feeds UI leaves no server call uncaught (2026-11-12)

Reviewer: Codex (`codex exec -s read-only`), one round, on the diff of branch
`fix/feeds-unhandled-state`.

## Context

`apps/desktop/e2e/local-server.spec.ts:307` failed 2 of 5 local runs with the
uncaught page error `Error invoking remote method 'bay:invoke': Error: Not
connected: <id>` from the feeds UI. `Host.stop()` calls `servers.closeAll()`,
which empties the live connections without notifying `syncRemotes()`, and then
awaits the runtimes; the server bay views stay alive. The freshly mounted feeds
UI called `api.state()` without a `catch`, and the call reached
`packages/bridge/src/connections.ts` (`connection()` throws "Not connected").

## Findings

- **P2, fixed:** the first fix (`.catch(() => {})`) also swallowed errors on a
  live connection (e.g. a missing handler), leaving an empty bay without a hint.
  The catches now show the error in the bay's existing `role="alert"` line.
- **P2, fixed:** `api.remove()` (unsubscribe) had no `catch` either; it now shows
  its error the same way.
- **Corrected claim:** an ordinary disconnect does not hit the same path:
  `onClose` notifies `syncRemotes()`, which closes the views; only calls already
  in flight fail ("Connection closed"). The "Not connected" window exists on quit.
- **Not known:** the exact moment of the two failed runs; not reproduced with a
  trace.

## Verification

- New tests in `bays/feeds/src/ui/App.test.tsx` ("a server bay whose connection is
  gone"): both failed against the code of `main`, pass with the fix; feeds tests
  43 of 43.
- `local-server.spec.ts:307 --repeat-each=10`: 10 of 10 passed with the first fix
  and 10 of 10 with the final one.
