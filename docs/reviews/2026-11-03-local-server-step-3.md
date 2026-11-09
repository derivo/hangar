# Review local server, step 3 (2026-11-03)

Reviewer: Codex (`codex exec -s read-only`), diff before the commit. Scope: ADR
0036 step 3 – bays of the app for agents of the local server, protocol 3
(`offer`, `reply`, `call`, `sessionEnded`), caller `local-server`.

## Findings

1. **[P1] Locks ineffective after a migration from step 2.** The marker from
   step 2 ended the migration before the new rewriting of the permissions to
   `local-server:<bay-id>`; the lock of a browser function then no longer
   applied. **Adopted:** with a marker the migration rewrites the permissions
   anyway. Test `local-server.test.ts` "… also after step 2 had migrated". Found
   by ourselves along the way: the rewriting may only run after stopping the
   server, otherwise the agents of the app lose their locks if stopping fails
   and the agent bay stays in the app. Test "… while the bay stays in the app".
2. **[P2] Abort during a permission dialog of the app.** If the connection goes
   while the app asks about a call of the server, the call runs after the
   approval anyway; the server has already reported it as failed.
   **Not adopted:** the functions of the browser bay are `openToAgents` and
   never ask. With a bay that asks, only a confirmed call would run without an
   answer. For that `Bus.call` would need an abort; that comes when such a bay
   is offered.
3. **[P2] Session end during a connection gap is lost.** Tabs of the session
   stay until the app restarts, its session permissions in memory (session IDs
   do not come back). **Not adopted**, kept in STATUS as a gap.
4. **[P2] Damaged `desktop-functions.json` prevented the start.** An entry such
   as `null` threw on registering, and the LaunchAgent would have started the
   server again and again. **Adopted:** the file is checked like an `offer`
   (`offered`). Test `server.test.ts` "ignores a damaged file …".

## Found outside of Codex

- The host first built the caller with `{ kind: 'local-server', ...caller }`.
  A `kind` in the server's message would have overwritten the kind, and with it
  the subject and the rule "own bay". Now it is built field by field;
  test `host.test.ts` "… only for its bays".

## Not checked

- The E2E ran only with `out/`, not against the packaged app.
- An older app that speaks version 2 is still accepted by the server, it offers
  nothing. A new app is rejected by an older server at `hello` until it
  restarts (step 4).
