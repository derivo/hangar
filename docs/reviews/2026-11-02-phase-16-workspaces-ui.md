# Review 2026-11-02 – Phase 16, workspaces UI and shared sessions

Review by Codex (`codex exec -s read-only`) over `packages/host/src/workspaces.ts`,
the settings (`apps/desktop/src/renderer/Workspaces.tsx`, IPC in
`apps/desktop/src/main/index.ts`) and sharing in the agent bay. Codex
reproduced the findings with in-memory probes against the source. Every
correction began with a red test in `apps/relay/src/workspaces.test.ts`,
`client.test.ts`, `relay.test.ts` or `apps/desktop/src/renderer/Workspaces.test.tsx`.

| Severity | Location         | Finding                                                                                                                                                       | Check                | Consequence                                                                                                                                                                                               |
| -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| high     | `workspaces.ts`  | Lists the client takes over in the handshake arrive before the `onChange` listener: a received revocation or the admission of a waiting member is not stored. | confirmed (red test) | After the handshake `connect` takes over every list whose version differs from the stored one.                                                                                                            |
| medium   | `workspaces.ts`  | A failed retry does not schedule another: after a longer outage Hangar stays disconnected.                                                                    | confirmed (red test) | Every failed attempt schedules the next (`retryLater`).                                                                                                                                                   |
| medium   | `workspaces.ts`  | Two overlapping connection attempts: the slower one wins, both sockets stay open.                                                                             | confirmed (red test) | Counter per attempt; a stale attempt closes its connection and changes nothing.                                                                                                                           |
| medium   | `client.ts`      | `joined` from the relay without a check: `identity: null` then blocks `view()` and with it the settings.                                                      | confirmed (red test) | `verifyIdentity` in `RelayClient` before a listener sees the request.                                                                                                                                     |
| medium   | `Workspaces.tsx` | If a member other than the inviter adds, the joiner keeps waiting, and the request disappears at the inviter.                                                 | confirmed (red test) | The relay remembers who invited (`invites[].by`, `invitedBy`) and sends it along in `joined`. Only the inviter sees "add", otherwise `Workspaces.accept` throws `Only the inviter can add this instance`. |
| medium   | `workspaces.ts`  | `RelayClient.renew` is never called: without a member change all lists expire after seven days, messages are lost silently.                                   | confirmed (red test) | Own lists older than `renewMs` (1 day) are signed again; check every `renewMs / 4`.                                                                                                                       |
| medium   | `workspaces.ts`  | Workspace name `constructor` reads `Object.prototype`: view and share break.                                                                                  | confirmed (red test) | `sharedOf` with `Object.hasOwn`. The relay already checks with `Object.hasOwn`.                                                                                                                           |

Own findings during the full E2E run (not from Codex):

- The server rejected every bay with `hostModules`; the agent bay now declares
  `workspaces` and was missing there. `workspaces` is optional on the server
  (red test in `apps/server/src/server.test.ts`).
- The pseudo-locale test took name, fingerprint and example address for
  hard-coded text; they are data.
- The share checkbox shows the confirmed state; the E2E test waits for that
  instead of `check()` (unreliable under load).
