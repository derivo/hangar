# Review password bay and board bay (2026-11-04)

Reviewer: Codex (`codex exec -s read-only`), diff before the commit. Scope:
password bay (ADR 0021), board bay (ADR 0037), `bayOnly` in manifest, bus, MCP
and bridge, host module `secrets`, references `@secret:NAME` in the agent bay,
board in the local server. Focus: do agents or other instances reach
passwords, does plain text land on disk, races on shell start, permission check
and states of the board.

## Findings

1. **[P1] Start error after the password resolution unhandled.** If
   `spawnShell()` threw after the answer of the password bay (PTY error, linked
   `.mcp.json`), the rejection stayed unhandled; in the server process that ends
   Node. **Adopted:** `.then(…).catch(…)` in `startShell`, the terminal shows
   "Shell not started: …". Test `sessions.test.ts` "says in the
   terminal when the shell fails to start after the answer".
2. **[P2] Done tasks of another session writable.** `ownable()` checked the
   owner only for `doing`. **Adopted** (ADR 0037: "whoever took … must not
   note or complete"): check as soon as a session has the task. Test
   `index.test.ts` "keeps other sessions off a task one took, and off a done
   task".
3. **[P2] Missed session end.** If a session ended while the board was not
   running (taken off the sidebar), its task stayed in progress.
   **Adopted:** on a conflict the board asks `session.info` about the other
   session; "Unknown session" frees the task. Test "frees a task whose session
   ended while the board was not running". The display "in progress with …"
   stays until then; the person can set it back to "Open".
4. **[P3] Password name `__proto__`.** Valid name, but `values[name] = …`
   set the prototype. **Adopted:** `Object.fromEntries`. Test "resolves a
   password named like a property of every object".

No bypass of `bayOnly` found; stale answers and answers after the session end
are discarded (confirmed by Codex with memory probes).

## From the E2E run

- Board and agent UI left rejected `bay:invoke` unhandled when the connection
  to the server ended ("Connection closed"). Fixed with tests in
  `bays/board/src/ui/App.test.tsx` and `SecretsHint.test.tsx`; failed actions
  at the board appear as a message above the columns.
- Bays asked each other with a permission dialog at app start. Decision by
  The maintainer: `uses` counts as permission for non-sensitive functions
  (ADR 0032, addendum).

## Second round

Reason: the rule `declared` (ADR 0032, addendum) changes permissions in the
bus. Codex checked only it and the fixes above: no finding. `declared` is set
only by the host (`ctx.call`, recomputed at the local server's listener); SDK
arguments, MCP and relay cannot smuggle it in; no bypass of `sensitive`,
`deny`, `bayOnly` or rules for other instances. The trust boundary remains the
paired local server: its statement on bay and session is trusted.

## Not checked

- Codex ran without tests (read-only sandbox).
- Passwords and board with the local server switched on only with unit tests
  (`server.test.ts`, `host.test.ts`); E2E runs with `HANGAR_LOCAL_SERVER=0`.
- Packaged app with the new bays not built.

## Addendum: gaps closed (2026-11-04)

- **E2E with local server** (`e2e/local-server.spec.ts`, "with the local
  server, a password still reaches the shell …"): password in the app,
  `@secret:` in the agent bay of the server, value in the shell; agent creates
  via MCP at the board (in the server), the person in its UI. The first run
  found **two permission dialogs** for one call: bus of the server and bus of
  the app both asked (ADR 0036 point 7, "both check"). Decision by the maintainer:
  only the app asks (ADR 0036, addendum). Implemented with
  `Transport.authorizes`; tests `bus.test.ts` "leaves the check to a transport
  that authorizes itself", `server.test.ts` (no `ask` at the server).
- **Packaged app:** fresh package (`electron-builder --mac dir`, unsigned,
  into a temporary folder, `release/` untouched); `secrets-board`,
  `local-server`, `sidebar-bays` 9 of 9 green, also the test "New version
  ready" that runs only packaged.
- **Codex on the change `authorizes`:** no finding; `bayOnly` and remote
  callers are still checked by the server, the app reconstructs callers
  including the session. Finding in the existing code (P2, also in HEAD): a
  lock from the settings did not apply to a session with a session permission.
  **Adopted:** `deny` before every rule; test "lets a denial from the settings
  beat a session grant".
