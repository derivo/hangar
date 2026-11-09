# ADR 0036 – Agent bay in the local server: shells survive the app

Status: accepted 2026-11-03 (basis: [ADR 0018](0018-headless-server.md),
[ADR 0019](0019-desktop-server-bridge.md),
[ADR 0029](0029-hangar-server-in-operation.md); reviews of the first draft with
its own terminal process and of this draft:
[2026-11-03](../reviews/2026-11-03-adr-0036-draft.md))

## Context

The agent bay starts every shell with node-pty in the main process of the app.
Quitting, restarting, updating or crashing the app ends all shells and the
agents in them. Wanted (2026-11-02): shells and agents keep running when Hangar
is quit and started again.

Keeping only the shells alive is not enough: afterwards an agent needs the MCP
server (`HANGAR_MCP_URL`, port new on every start), its token (only in memory),
the scheduler and the status from the hooks. The `hangar-server` (ADR 0018)
holds exactly these parts together; the desktop pairs with it over the bridge
(ADR 0019), also over loopback without SSH.

## Decision

1. **Local server from its own copy of the runtime:** On the first start of a
   build the app copies itself (Electron, `hangar-server.mjs`, CLI, bundled
   bays, node-pty including `spawn-helper`) to
   `<userData>/local-server/runtime/<version>+<build id>` (about 270 MB on
   macOS; the build id hashes `Info.plist` with the asar hash, server, CLI, the
   Electron version and the signature's `CodeResources`, so a new build of the
   same version is copied anew, addendum 2026-11-07). The
   server runs with Electron in Node mode from this copy; it gets bays and CLI
   as explicit paths (`--bays`, new `--cli`). An app update thus replaces
   nothing that the running server or the hooks of its shells need. Copies that
   no server uses any more are deleted by the app.
2. **Lifetime through the system's service**, not as a child of the app:
   macOS LaunchAgent `~/Library/LaunchAgents/dev.hangar.server.<hash>.plist`
   (`<hash>`: 8 characters of the SHA-256 of the data folder, so that the dev
   profile and tests never take over the installed app's service; `RunAtLoad`,
   `KeepAlive`, log in `<data>/server.log`, folder 0700). The app creates and
   starts it; quitting the app leaves it running. The server ends only with
   logout, restart of the machine or "Restart local server".
3. **Listen first, then bays:** The server binds its port before activating the
   bays. If the stored one is taken, it uses a free one and writes it with the
   fingerprint to `<data>/listen.json` (atomic, 0600); the app reads the file
   before every connect. No restart loop with restored shells.
4. **Pairing without code entry:** The server also writes every new pairing
   code to `<data>/pair-code` (atomically replaced, 0600). The app reads it,
   checks the fingerprint against `listen.json` and pairs as today; after that
   the stored token applies.
5. **One owner of the agent bay:** After the move (point 8) the app no longer
   starts its own agent bay, not even if the server is missing; it then shows
   "Local server is not running" with "Restart" and the log. In the sidebar the
   server's agent bay stands without the server name ("Agents"), notifications
   without "<server>: ". The app loads its UI from the server's runtime copy,
   so always in its version.
6. **Folder dialog:** For the local server the app shows the system's folder
   dialog and passes the path to `project.add`; the server checks it as before
   against `--root` (home folder).
7. **Desktop bays for agents of the local server:** Bays that run only in the
   app (browser bay, host module `browser`) are offered by the app to the local
   server over the bridge; the server registers them with
   `Bus.registerTransport`. The caller is a kind of its own, `local-server`,
   with session ID; the app checks permissions under its own subject
   (`local-server:<bay-id>`, changed 2026-11-03: with the session ID a block
   would apply only to one session) and separates browser partitions per
   session (`session-local-server:<bay-id>-<session-id>`). The server checks
   beforehand as for its own functions; both check (decided 2026-11-03). Only
   the local server gets this, remote servers do not. **Changed 2026-11-04:**
   Only the app asks; see addendum below. If the app is closed, the call fails
   with "Hangar is not open".
8. **Move once, with a marker:** With the agent bay stopped and before the first
   start of the server the app moves: the bay's data
   (`<userData>/bays/dev.hangar.agents`), its jobs from `jobs.json`, its entries
   in `permissions.json` and its `baySettings`. Then it writes
   `<userData>/local-server/migrated` (atomic); only from then on does point 5
   apply. If the move aborts, everything stays as it was and it starts over at
   the next start. Running shells end once in the process. Grid and collapsed
   state of the UI start empty once (new partition).
9. **Environment of the shells:** `ELECTRON_RUN_AS_NODE` and the other variables
   of the server start do not get into the environment of sessions and jobs.
10. **New version:** The server keeps running in its version until the person
    chooses "Restart local server" (notice "New version ready"). The app
    rewrites the plist only if the copy it runs from is missing. The restart
    ends the shells; the history stays as today. The bridge checks the protocol
    version.
11. **Workspaces (ADR 0030):** The workspaces move into the local server with
    the agent bay, including the identity: Hangar stays one instance with the
    same fingerprint, nobody joins anew. The server holds the relay connection;
    "Settings → Workspaces" talks to it over the bridge (step 5). The server has
    no keychain: the private keys are stored there unencrypted (`plain:`,
    mode 600) like its bridge key in `identity.json`; the way back encrypts
    them again with `safeStorage`.
12. **Windows and Linux not at first:** The NSIS installer ends processes in the
    installation folder, the AppImage is mounted only while it runs. There the
    agent bay stays in the app for now.
13. **Turning on and off (addition 2026-11-03, step 4b):** On macOS the local
    server is the default in the packaged app; a build from the repository
    (`pnpm dev`, E2E) starts it only on request, otherwise a LaunchAgent from
    the repository build would run that does not notice rebuilds.
    "Settings → Local server" stores the choice in `settings.json`
    (`localServer`); it applies at the next start, because the move and the
    way back run before permissions and jobs are loaded. `HANGAR_LOCAL_SERVER`
    (`0`, `1`) decides over setting and default; the switch is then locked.
    Turning off asks beforehand: On the way back the app stops the service,
    deletes plist and runtime copies, fetches data, jobs, permissions and
    settings of the agent bay back (the server's win), gives the permissions of
    its agents the bay's subject again and takes over their rules from the
    server (they win), then removes the server from `servers.json`. Keys and
    other data of the server stay; turning on again moves again. On the way the
    marker is called `returning`: An aborted way back ends at the next start, a
    turn-on in between moves everything once more. Until then the bay runs where
    its data folder is.

## Consequences

- Quitting, restarting, updating and crashing the app leave shells, agents, MCP,
  tokens and jobs untouched. `claude --continue` is needed only after a restart
  of the machine or of the server.
- Shells keep running without Hangar being open; they cost memory and quota. The
  tray menu shows how many are running.
- Permission questions need the app (ADR 0019: without a desktop `ask` throws,
  nothing is stored). If it is closed, a call that would have to ask fails.
- About 270 MB on disk per version, as long as a server uses it.
- The server accepts connections on loopback; every local user reaches the
  port. Protection as with remote servers: fingerprint, pairing code, token. A
  broken frame before login ended the server (fixed 2026-11-03, `bridge.ts`).

## Measured

- 2026-11-03, macOS 27, Hangar with Electron 45: An app copied with `ditto` and
  signed (`codesign --verify --deep --strict` valid) runs as a LaunchAgent with
  `ELECTRON_RUN_AS_NODE`; node-pty from `app.asar` starts a shell. No Dock
  entry (`lsappinfo`), no blocking prompt. node-pty must be loaded through
  `app.asar/…`, not through `app.asar.unpacked/…` (otherwise it looks for
  `spawn-helper` doubly unpacked). Whether macOS reports "Background item
  added" has not been observed.

- Claude Code and a restart of the server (open before step 2): not applicable.
  Shells are children of the server and end with it; MCP port and token live
  exactly as long as the shells. Hooks and statusline talk to the server, not to
  the app, and reach it even with the app closed.

## Implementation in steps

1. Runtime copy, `--cli`, `listen.json`, `pair-code`, LaunchAgent, automatic
   pairing; agent bay still in the app. E2E: app starts, pairs the local
   server. **Done 2026-11-03**, only with `HANGAR_LOCAL_SERVER=1` (otherwise the
   agent bay would appear twice in the sidebar).
2. Move with marker, agent bay only in the server, folder dialog, environment
   without server variables. **Done 2026-11-03** (still only with
   `HANGAR_LOCAL_SERVER=1`), including the UI from the runtime copy. Replacing
   the bundle is checked by the E2E only with the packaged app
   (`HANGAR_E2E_EXECUTABLE`). Not yet: name without server in the sidebar and
   "Local server is not running" (point 5), these come with step 4. E2E: quit
   the app (real quit), kill it hard (`kill -9`) and replace the bundle; after
   that same PID of the shell (`echo $$`) and an MCP call from the shell that
   keeps running. By hand: a Claude agent over ten minutes without the app.
3. Desktop bays for the local server (point 7). **Done 2026-11-03** (still only
   with `HANGAR_LOCAL_SERVER=1`): protocol 3 with `offer` and `reply` from the
   desktop, `call` and `sessionEnded` from the server. The server remembers the
   last offer in `desktop-functions.json`, so that the tools are listed even
   with the app closed. The move rewrites permissions of the agent bay on
   app bays to `local-server:<bay-id>`. An older server rejects the new app at
   `hello` until it restarts (step 4). E2E: An agent in the server opens a tab
   in the app's browser bay.
4. New version, tray, settings, docs; then relay in the server (point 11). **4a
   done 2026-11-03** (still only with `HANGAR_LOCAL_SERVER=1`): bays of the
   server under their name in the sidebar, page "Local server is not running"
   with "Restart" and "Open log", notice "New version ready" above the bay,
   restart with a confirmation when shells are running, shell count in the tray
   (message `sessions` of the server; since 2026-11-03 the sum of
   `ctx.setRunning` of the bays, so running shells instead of registered
   sessions). An older server that rejects the new app at `hello` thus appears
   as "not running" and can be restarted from there. An error stays until the
   next connection, "starting …" only during a restart. E2E: `launchctl bootout`,
   then page, "Restart", bay back.
   **4b done 2026-11-03:** switch in the settings with the agent bay's way back
   into the app (point 13); default in the packaged app on macOS, can be turned
   off there or with `HANGAR_LOCAL_SERVER=0`. E2E: without the variable switch
   on, restart (project in the server), switch off, restart; project back in
   the app's agent bay, no service, no plist.
5. Relay in the server (point 11). **Done 2026-11-03:** The server runs
   `Workspaces` in `<data>/workspaces` and is `RemoteAccess` of its bus. The
   move brings `<userData>/workspaces` along (the keys as `plain:`), also
   afterwards after step 4, then with a one-time stop of the server; a folder
   without `workspaces.json` was never in use and is deleted without stopping
   the server. The way back brings it back. Protocol 4: message `workspaces`
   (action and arguments, only paired) from the desktop, `workspaces` (changed)
   from the server; both sides run the actions with `workspaceAction` from
   `@hangar/host`. With keys that only the keychain can read (`safe:`), the
   server starts without workspaces. E2E: connect the relay in the app, restart
   with the local server; status "Connected" with the same fingerprint, key in
   the server `plain:`.

## Addendum 2026-11-04: only the app asks

With "both check" (point 7), the first call of a sensitive function of the app
came twice as a permission dialog: once from the server's bus over the bridge,
then from the app's bus; each answer ended up in its own rules file. Decision
of the maintainer: For functions that the app offers, only the app asks. The server
reports them with `Transport.authorizes`; its bus then checks only `bayOnly`
and remote callers, dialog, stored rules, `openToAgents` and session
permissions are with the app (subject `local-server:<bay-id>`). The rules thus
stand only where the settings show them. E2E: `e2e/local-server.spec.ts`
expects exactly one dialog for the password retrieval from the server.
