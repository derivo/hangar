# Review local server, step 4b (2026-11-03)

Reviewer: Codex (`codex exec -s read-only`), diff before the commit. Scope: ADR
0036 step 4b – switch in the settings, way back of the agent bay
(`migrateFromLocalServer`, shared `moveBay`), `localServerWanted` (default only
packaged under macOS), wiring in `index.ts`.

## Findings

Every adopted finding began with a red test.

1. **[P1] After an aborted way back the server started without data.**
   If the way back failed after moving the bay folder, the bay still ran in the
   server; it would have written an empty state, which the next way back would
   have laid over the real data. **Adopted:** the bay runs where its folder
   lies (`bayInLocalServer`). Test `local-server.test.ts` "runs the bay where
   its data lies …".
2. **[P1] A lock from the server was lost on the way back.** Rules of the
   agents on bays of the app that the server's check had stored stayed there,
   the older permission of the app applied again. **Adopted:** the way back
   fetches rules with the bay as subject from the server, they win. Test
   "keeps the rules the person set in the server …".
3. **[P1] The marker confused half a way back with a finished migration.**
   If switched on again afterwards, the migration skipped everything.
   **Adopted:** while under way the marker is called `returning`; the migration
   then moves completely and removes it. In the same test.
4. **[P2] The switch promised what the variable prevented.**
   **Adopted:** with `HANGAR_LOCAL_SERVER=0`/`1` it is locked and says
   "Set by HANGAR_LOCAL_SERVER."; `enabled` takes the variable into account.
   Test `Settings.test.tsx` "locks the switch …". The E2E goes there and back
   once through the switch without the variable.
5. **[P2] The new a11y part failed under Windows and Linux.**
   **Adopted:** only under macOS.

## Not checked

- Codex ran without tests (read-only sandbox).
- "Restart Hangar" (`app.relaunch`) without E2E; the E2E restarts itself.
- Against the packaged app `e2e/local-server.spec.ts` and `e2e/a11y.spec.ts` ran
  green (2026-11-03). Two tests assumed the build default from the repository
  (switch off); they now fix their initial state themselves
  (`localServer: false`). The a11y test thereby started a server service in the
  test's temporary HOME, which kept running; unregistered.
