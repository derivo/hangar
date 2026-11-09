# Review local server stop (2026-11-09)

Reviewer: Codex (`codex exec -s read-only`), diff before the commit. Scope:
`stop()` in `apps/desktop/src/main/local-server.ts`, used by
`migrateToLocalServer` and `migrateFromLocalServer`. Follow-up to the open
point of [2026-11-09-local-server-bootstrap.md](2026-11-09-local-server-bootstrap.md).

## Gap

`stop()` moved bay data, jobs, permissions and workspaces right after
`launchctl bootout`. `bootout` returns 0 while the old server is still ending
(`SIGTERMed`, up to launchd's ExitTimeOut of 20 s), so the old server could
still write into the data being moved, and a following `ensureLocalServer`
could still see the service as loaded (`launchctl print` = 0), keep it and
never `bootstrap` it.

## Round 1: wait for the unload

After a successful `bootout`, `stop()` calls `unloaded()` (from the bootstrap
fix) and waits until `launchctl print` no longer finds the service, at most
30 s. A service that `print` does not find returns at once, without waiting.

Findings:

1. **[P1] The timeout lets the move run while the server is still there.**
   `unloaded()` returned after 30 s also when `print` still found the service;
   the restart path then reports the refused `bootstrap`, the migrations had no
   such check. Codex reproduced it with a simulated clock. **Adopted:**
   `unloaded()` returns `false` on timeout, `stop()` then throws "Stopping the
   local server failed" like a failed `bootout`; nothing moves and the next
   start tries again. Test "moves nothing when the server has not ended after
   30 s". `ensureLocalServer` ignores the result, its `bootstrap` reports the
   failure as before.

## Round 2

No findings.
