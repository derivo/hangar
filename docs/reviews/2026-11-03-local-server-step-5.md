# Review local server, step 5 (2026-11-03)

Reviewer: Codex (`codex exec -s read-only`), diff before the commit. Scope: ADR
0036 point 11 – workspaces including identity in the local server, move there
and back, settings over the bridge (protocol 4, message `workspaces`).

## Findings

Every adopted finding except 1 began with a red test.

1. **[P1] Failed key move starts an empty agent bay.** If the bay data already
   lay in the server, the error path still set "bay in the app".
   **Adopted:** as on the way back, the bay runs where its folder lies
   (`bayInLocalServer`). Without a unit test: the error path is in `index.ts`
   (excluded from coverage); `bayInLocalServer` is tested.
2. **[P2] Aborted move leaves unreadable keys.** The keys were rewritten in the
   source before the folder moved. **Adopted:** `moveWorkspaces` rewrites them
   in a copy (`workspaces.moving`); the source stays readable until the copy is
   in place. Test `local-server.test.ts` "leaves the identity readable …"
   (target not deletable).
3. **[P2] An error on fetching empties the page.** A server without workspaces
   (for example with `safe:` keys) rejected `view`, the page did not catch it.
   **Adopted:** `Host.localWorkspaces('view')` then returns a state with an
   error. Test `host.test.ts` "runs the settings there …".
4. **[P3] `share` without on/off switched a share off.** **Adopted:**
   `workspaceAction` checks number and type of the arguments per action
   (`Invalid arguments for <action>`). Test
   `apps/relay/src/workspaces.test.ts`.

## Found outside of Codex

- Every start of the app creates `<userData>/workspaces` with an identity, even
  without a relay. The later move would therefore have stopped the server once
  for everyone with a local server. A folder without `workspaces.json` was never
  in use: it is deleted without stopping the server.
- `preload.test.ts` reads the IPC channels from the source; a loop over the
  actions hid them. The handlers are written out individually again.

## Not checked

- Codex ran without tests (read-only sandbox).
- Shared sessions of the agent bay between app and server, and the packaged
  app. A call through the relay into a bay of the server is proven
  (`server.test.ts` "answers an instance …").
