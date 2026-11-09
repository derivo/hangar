# @hangar/bus

Central message bus: register functions, route calls, check permissions.
No Electron dependency.

## Interfaces

- `new Bus({ permissions, prompter, remote?, now? })` – `now` only for tests (timestamps); `remote` (`RemoteAccess`: `isMember`, `isShared`) for callers of other instances, without it every remote call is rejected.
- `register(bayId, spec, handler)` / `registerTransport(bayId, spec, transport)` / `unregisterBay(bayId)`
- `call(caller, '<bay-id>/<function>', args, signal?)` – checks the permission first; if `signal` is aborted afterwards (caller gone, e.g. the local server during the permission dialog), nothing runs.
- `grants()` (with `grantedAt` and `lastUsed`), `setMode(subject, target, mode)` (settings: `allow`/`deny`, `ask` only for sensitive, never `session`, no rule for own non-sensitive functions), `revoke(subject, target, sessionId?)`, `endSession(sessionId)`, `startSession(sessionId)` (session runs again, e.g. after a failed restore; the host calls it when issuing a token)
- `MemoryPermissionStore`, `FilePermissionStore(file)`
- `subjectOf(caller)` – subject of the permissions: bay id, remote `remote:<fingerprint>/<bay-id>`, local server `local-server:<bay-id>`.
- Types: `Caller` (`bay`, `session`, `remote`, `local-server`), `RemoteAccess`, `CallInfo`, `FunctionSpec`, `Transport`, `Grant`, `Prompter`

## Pitfalls

- Rules are in ADR 0006 and 0016 (`FunctionSpec.openToAgents`: agents of any bay without asking, `deny` still applies); the tests in `bus.test.ts` are their executable form.
- A block (`deny`) from the settings applies before every other rule, even before an already granted session permission.
- Session permissions (`mode: 'session'`) live only in memory, as does `lastUsed`. Older grants in `permissions.json` have no `grantedAt`.
- If a session ends while its permission dialog is open, the call is rejected (`endSession` remembers the id). The same if a block was set in the meantime: it applies before the dialog answer.
- Remote callers (ADR 0011, Phase 13): the rule "own bay" never applies; before every stored permission `authorize` checks `spec.remote`, "not sensitive", membership and the share list – on every call, so that leaving or withdrawal takes effect immediately. A remote `sessionId` is display only: no session permissions, no `openToAgents`.
- Caller `bay` or `local-server` without a session with `declared` (target is in `uses`, set by the host, ADR 0032 addendum): non-sensitive functions without a dialog, `deny` still applies.
- `FunctionSpec.bayOnly` (ADR 0021): rejected before every rule, without a dialog, for sessions, remote callers and the local server with `sessionId`; bays and the local server without a session still go through the rules.
- A new transport (e.g. relay) implements only `Transport.invoke`; permission stays in the bus. Exception `Transport.authorizes` (ADR 0036, addendum): the other side asks and holds the rules; the bus checks only `bayOnly` and remote callers. Only the server sets it, for functions of the app.
- Caller `local-server` (ADR 0036): bays and agents of the server on this machine that call bays of the app. The rule "own bay" never applies; with `sessionId` like a session (`openToAgents`, session permissions), without like a bay. The server checks beforehand only `bayOnly` (`Transport.authorizes`, ADR 0036 addendum).
