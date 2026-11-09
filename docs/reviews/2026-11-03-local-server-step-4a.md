# Review local server, step 4a (2026-11-03)

Reviewer: Codex (`codex exec -s read-only`), diff before the commit. Scope: ADR
0036 step 4a – bays of the local server under their name, page "Local server is
not running", notice "New version ready: …", restart with confirmation, shell
count in the tray, server message `sessions`.

## Findings

Every adopted finding began with a red test.

1. **[P1] Restart without confirmation on an unknown shell count.** `sessions
?? 0` took "unknown" for "none"; a server that rejects the new app keeps
   running with its shells. **Adopted:** Hangar asks, unless the connected
   server reports 0 ("Running shells end …"). Test `host.test.ts`
   "restarts it, asking first …".
2. **[P1] No new connection attempt after a rejected version.** A protocol
   error ends the retries; `pairLocal` returned only the ID for a paired
   server. **Adopted:** `pairLocal` reconnects a known server (without effect
   if it is connected or connecting right now). Test `connections.test.ts`
   "connects again when paired already …". Found along the way: `until` there
   gives up silently after 2 s; the new test checks the status afterwards
   itself.
3. **[P2] Several clicks restart in parallel.** **Adopted:** clicks during a
   restart (including the confirmation) attach to it. Test "restarts once
   for many clicks …".
4. **[P2] Error of the restart was lost.** With an existing connection the next
   state deleted it, with a disconnected one the old connection error
   overwrote it. **Adopted:** a failed restart shows an error message ("The
   local server could not be restarted"); the error of the page is only the
   connection error now.
5. **[P2] Tray counts ended shells.** Counted are agent sessions with a token;
   a shell that ends with `exit` keeps its session.
   **Not adopted:** for that the agent bay would have to report the running of
   its PTYs to the server, a new interface. Consequence: tray and confirmation
   name a number that is too high, the confirmation comes more often than
   necessary rather than too rarely. Kept in STATUS as a gap.

## Found outside of Codex

- `updateTray` rebuilt the tray menu on every server change, also without a
  local server. In E2E (`server.spec.ts` replaces `Menu.buildFromTemplate`)
  that threw "Must pass Menu or null" in the main process. Now only if the
  status line changes; test `host.test.ts` "builds the tray menu again only
  when it changes".
- Page and status change: on retrying, the connection alternates between
  "connecting" and "failed"; the page would have flickered. An error stays
  until the next connection, "starting …" only during a restart.

## Not checked

- Codex ran without tests (read-only sandbox). The flow is proven by
  `e2e/local-server.spec.ts` (`launchctl bootout`, page, confirmation,
  "Restart").
- Notice "New version ready" and tray only in unit tests; the E2E did not run
  against the packaged app.
