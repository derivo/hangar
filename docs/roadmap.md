# Roadmap after the MVP

Work plan for the next expansion stages. Each phase is cut so that an agent can
implement it without questions: goal, scope, assumptions, acceptance criteria,
evidence. State of the implementation: [STATUS.md](STATUS.md).

## Rules for the autonomous run

- Order as below; phase 2 (concepts) runs as documentation work in parallel to
  phase 3, because Codex reviews take time.
- Each phase ends with green gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`
  (coverage not below the current level), `pnpm test:e2e`; UI phases additionally
  axe-core light and dark, 200 % zoom and a keyboard walkthrough.
- One commit per phase (Conventional Commits, docs in the same commit,
  `A11y-Check:` trailer for UI). Commits only with the approval of the user.
- Decisions as ADRs from `docs/adr/0010-…`.
- Codex runs through `codex exec` with the model `gpt-6.1-sol` (set in
  `~/.codex/config.toml`), for reviews with `--sandbox read-only`. Findings are
  checked, not adopted; every adopted finding gets a test.
- If a phase hits an open question (below per phase), the stated default applies;
  the deviation goes into the final report.

## Phase 1 – Split view as a grid, detach a terminal (implemented)

**Goal:** See several session terminals at the same time, with a freely chosen
number; a terminal can be detached into its own window.

**Scope**

- Agent bay: workspace as a grid of fields. A field shows exactly one session;
  "Add field" splits the area, "Close field" removes one (the session keeps
  running). No free sizes by dragging in the first step.
- Each field has a minimum size of 80 × 24 terminal characters, measured with the
  font of the terminal. The arrangement depends on the available space, not on a
  fixed table: columns and rows are chosen so that the fields are as far above
  the minimum size as possible. On a 49-inch widescreen (5120 × 1440), four or
  more fields sit side by side; on a laptop at 100 % zoom only one field fits.
- If no further field fits at minimum size, "Add field" is disabled and says why.
  If the window gets smaller afterwards, the workspace scrolls instead of
  pushing fields below the minimum size.
- A click on a session in the tree fills the focused field; a session is in at
  most one field (otherwise the focus moves there).
- Grid and assignment survive restarts (`localStorage` of the bay, like the
  selected session today).
- Detach: a button in the field header opens the session in its own window. This
  needs a host function for bays (SDK: open a window of the own bay with a
  parameter) – decision as ADR 0010. The detached window replays the buffer
  through `session.buffer`; closing the window brings the session back into the
  grid. Detached windows are restored at restart.

**Assumptions / open questions**

- Default: no fixed upper limit; the minimum size limits the number.
- Default: the project overview stays its own view, not a field.

**Acceptance criteria**

1. Unit: grid calculation for laptop (1440 × 900), 27 inch (2560 × 1440) and
   49-inch widescreen (5120 × 1440): no field below 80 × 24 characters, at least
   four fields side by side on the widescreen; a session never in two fields.
2. Components: add, close, focus a field; the keyboard reaches every field
   header.
3. E2E: three sessions in the grid, input lands only in the focused shell;
   restart restores the grid.
4. E2E: detaching opens a second window with the same buffer; closing brings the
   session back.
5. E2E: a small window disables "Add field" with a hint; shrinking afterwards
   scrolls instead of squeezing.
6. axe light/dark 0 findings, 200 % zoom without overflow.

## Phase 2 – Relay and registry concepts, review by Codex (implemented)

**Goal:** Solid concepts from which phases can be cut later. No production code.

**Scope**

- `docs/concept-relay.md`: roles (instance, relay, workspace), identity and
  sign-in, end-to-end encryption, protocol and version negotiation, mapping to
  the replaceable transport in `packages/bus`, permissions for remote calls
  (blocked by default), handovers between agents, threat model, operation.
- `docs/concept-registry.md`: package format, signature and checksums, uniqueness
  of bay IDs, versions and minimum version of Hangar, renewed approval for new
  permissions, rollback, API v1, hosting.
- One ADR each (0011 relay, 0012 registry) with the basic decisions.
- Codex review of both concepts against the code (`packages/bus`,
  `packages/mcp`, `packages/sdk`); findings with assessment in
  `docs/reviews/2026-…-relay-registry.md`, adopted changes in the concepts.

**Acceptance criteria**

1. Every statement about existing code names file and location.
2. The Codex review exists; every finding is marked as adopted, rejected (with
   reason) or open.
3. Doc harness gate: claims checked against the source, links resolved.

## Phase 3 – Permissions in the UI (implemented)

**Goal:** Understand granted permissions and change them specifically, not only
revoke them.

**Scope**

- A separate "Permissions" page in the settings instead of today's list:
  grouped by caller (bay or session with name instead of token/UUID), below it
  target bay and function with the description from the manifest.
- Visible: grant mode as in the bus (`GrantMode` in
  `packages/bus/src/types.ts`: `allow`, `deny`, `session`, `ask`), sensitive
  yes/no, time of the grant, last call.
- Change: switch the grant mode, revoke, block a function in advance; for
  sensitive functions the UI offers only what the bus allows today (ADR 0006).
- Filter by bay and search; empty state with an explanation.
- For this, the bus and the storage of the permissions get timestamps and the
  last call.

**Acceptance criteria**

1. Unit/integration: the bus checks a changed grant mode immediately; the UI
   offers no mode for sensitive functions that the bus rejects (test red first).
2. E2E: an agent calls a function, the permission appears with the name of the
   session; blocking leads to a rejection at the next call.
3. axe light/dark 0 findings, keyboard walkthrough, 200 % zoom.

## Phase 4 – Scheduler for jobs (implemented)

Implemented according to ADR 0013 in `packages/scheduler`; evidence in
[STATUS.md](STATUS.md).

**Goal:** Time-driven jobs in the main process, even without a loaded bay UI
(concept: "Central scheduler in the main process").

**Scope**

- ADR 0013: time expression (cron syntax), library or own parser after
  weighing, missed runs after sleep, time zones.
- Scheduler in the main process, jobs persistent in the data folder of Hangar.
  Without an Electron dependency, so that the same code runs on a server later
  ([concept-server.md](concept-server.md)).
- SDK: a bay registers a job (`id`, time expression, handler in the main part);
  the job runs only while the bay is installed.
- Agent bay as first user: run a command at a time in a session (e.g. tests in a
  worktree every night).
- UI: list of all jobs with next and last run, result, pause, delete, "Run now".
- MCP: agents can create and list jobs of their session (permission needed).

**Assumptions / open questions**

- Default: jobs run only while Hangar runs (also in the tray); no operating
  system service.
- Default: missed runs are made up once after waking up, not several times.

**Acceptance criteria**

1. Unit with a fake clock: next run, catching up after sleep, time zone change,
   pausing.
2. Integration: the job of a test bay runs without an open bay UI.
3. E2E: create a job in the agent bay, "Run now" writes into the shell, the
   result appears in the list.
4. axe light/dark 0 findings for the job list.

## Phase 5 – Logo and icons by Codex (implemented)

Chosen: direction "Portal" (hangar door) from three Codex drafts; evidence in
[STATUS.md](STATUS.md).

**Goal:** Own logo and uniform icons instead of placeholders.

**Scope**

- Codex creates drafts with image generation: app icon (1024 × 1024), tray
  template (single color, 16/32 px, `trayTemplate.png`), Hangar mark in the
  sidebar, bay icon of the agent bay. Guideline: style of the UI (fine lines,
  black and orange, ADR 0026, colors from `packages/theme`).
- I choose and integrate: `apps/desktop/build/icon.png`,
  `apps/desktop/resources/trayTemplate*.png`, icons in the sidebar as SVG,
  manifest icon of the agent bay.
- The decision on the selection lies with the user: drafts are presented,
  integration only after the choice.

**Acceptance criteria**

1. Icons legible in light and dark, contrast of the sidebar icons ≥ 3:1 (axe).
2. `pnpm package` produces an app with the new icon; the tray symbol adapts to
   the menu bar mode.

## Phase 6 – Final check: graphify and Codex review (implemented)

**Goal:** An independent look at the whole codebase after phases 1–5.

**Scope**

- Knowledge graph with graphify (`graphify update .`: AST only, no code to an
  LLM; output in `graphify-out/`, not checked in): hubs, communities, report.
- Codex (`gpt-6.1-sol`, read-only) examines the codebase completely and the
  graph: does the architecture hold, coupling between packages, bugs, security
  gaps (token, IPC, paths, shell calls), test gaps.
- Findings checked and assessed in `docs/reviews/2026-…-codebase.md`. Confirmed
  bugs: red test, fix. Larger rebuilds are proposed as a new phase, not
  implemented unasked.

**Acceptance criteria**

1. Every finding has file:line and an assessment (confirmed, rejected with
   reason, open).
2. Every confirmed bug has a test that was red before the fix.
3. Gates green after the fixes.

**Result:** [reviews/2026-10-29-codebase.md](reviews/2026-10-29-codebase.md):
15 findings, 13 fixed, 2 open (→ phase 7).

## Phase 7 – Own execution channel for jobs (implemented)

**Goal:** Jobs of the agent bay run reliably, without disturbing the interactive
shell of a session, and on every platform (review findings 2 and 10).

**Scope**

- A job starts its own process in the worktree of the session, with its
  environment (incl. token), instead of typing into the visible shell. Output and
  exit code come directly from the process; no marker, no `$?`.
- Time limit per run with abort; an aborted run has failed.
- Windows: command through `cmd.exe /d /s /c` or the default shell of the
  platform.
- Whether and how the output stays visible in the session is decided by an ADR
  (change of ADR 0013): [ADR 0014](adr/0014-job-process.md), only in the
  settings.

**Acceptance criteria**

1. Unsent input and a running program in the session stay untouched (test).
2. A hanging command ends as failed after the time limit (test).
3. Two jobs of the same session due at the same time both run through (test).

# Expansion stage 2: server, relay, registry

As of: 2026-10-29. Order: first Hangar on a server
([concept-server.md](concept-server.md)), then the relay
([concept-relay.md](concept-relay.md), ADR 0011), then the registry
([concept-registry.md](concept-registry.md), ADR 0012). The rules above apply.

## To clarify before the start

The user decides these points. Without an answer the stated default applies; if a
phase is blocked, it says so at the phase.

| Question                                                                       | Default                                                                       | Affects |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------- |
| New dependency `ws` (WebSocket server; Node has only a client)                 | is added                                                                      | 10, 15  |
| New dependency `@noble/ciphers` (XChaCha20-Poly1305, missing in `node:crypto`) | is added; otherwise change ADR 0011 to ChaCha20-Poly1305 with a counter nonce | 14      |
| New dependency `tar` (`.bay` packages)                                         | is added                                                                      | 19      |
| GitHub remote for the repository                                               | `git@github.com:derivo/hangar.git` since 2026-11-04, private                  | 12, 21  |
| Sign-in at the relay                                                           | invitation token of the workspace creator, no email or OAuth login            | 15      |
| Operation of the relay                                                         | self-operated only (container), no public relay                               | 15      |
| Domain for registry and publisher                                              | none; index on GitHub Releases                                                | 21      |

## Browser bay (brought forward, before phase 8) – implemented

State: [STATUS.md](STATUS.md), `bays/browser/CLAUDE.md`.

**Goal:** Web pages in tabs in Hangar; agents open, read, click and take
screenshots through MCP ([ADR 0015](adr/0015-browser-bay.md)).

**Scope**

- Host capability `browser` (`hostModules` in the manifest, `ctx.browser`,
  `window.hangar.browser.show`), one `WebContentsView` per tab.
- `bays/browser`: tab bar, address bar, back, forward, reload, new tab, close
  tab; tabs of the person open again after restart.
- Functions `tab.open`, `tab.navigate`, `tab.list`, `tab.close`, `page.text`,
  `page.click`, `page.fill`, `page.screenshot`; own tabs and partition per agent
  session.
- Bookmarks, history and own windows for tabs follow later.

**Acceptance criteria**

1. Unit: ownership of tabs (an agent reaches only its own), addresses
   (`localhost:5173` → `http://`, search not provided, http/https only), errors
   with exact text.
2. E2E with a local HTTP server: open and show a page in the bay; an agent opens
   a tab through MCP, reads text, clicks, fills a field and saves a screenshot;
   two agents have separate cookies.
3. Address bar: edge case matrix (empty, invalid, `file:`), Enter key; axe
   light/dark, keyboard walkthrough, 200 % zoom.

## Phase 8 – Core to `packages/host` – implemented

State: [STATUS.md](STATUS.md), `packages/host/CLAUDE.md`. `view-state.ts` stayed
in `apps/desktop`: window position and selected bay exist only with a window.

**Goal:** Bay loader, bay runtime and the wiring of bus, MCP and scheduler run
without Electron, so that desktop and server use the same core.

**Scope**

- `bay-loader.ts`, `bay-runtime.ts`, `settings.ts`, `view-state.ts` (as far as
  possible without Electron) and the wiring from `index.ts` (bus, token
  registry, MCP server, scheduler, `registerAgentSession`) move to
  `packages/host`.
- `HostServices` stays the interface; the desktop app supplies the Electron parts
  (window, dialogs, tray, notifications).
- No new behavior.

**Acceptance criteria**

1. `packages/host` imports no Electron (lint rule `no-restricted-imports`).
2. `packages/host/src` is in the coverage gate (90 %).
3. All gates green, E2E unchanged 24/24, also against the package.

## Phase 9 – `apps/server` without a UI – implemented

State: [STATUS.md](STATUS.md), [ADR 0018](adr/0018-headless-server.md),
`apps/server/CLAUDE.md`. The server loads all bays found except those with the
host module `browser`; the reason for a rejection is English (ADR 0009).

**Goal:** A Node process loads bays, starts MCP and scheduler and runs jobs,
without a screen.

**Scope**

- `hangar-server --data <ordner> --listen 127.0.0.1:<port>` with
  `packages/host`; data as on the desktop (`permissions.json`, `jobs.json`, bay
  data).
- Prompter from rules only: without a stored grant `deny` with the reason
  "Permission missing: set it in the settings".
- `GET /health` (version, loaded bays, number of jobs); log without terminal
  contents.
- Agent bay: `project.add` takes a path when there is no folder dialog; the
  server checks it against approved root folders (`--root`, repeatable).

**Assumptions:** node-pty runs under Node as under Electron (N-API prebuilds; the
integration tests already use it under Node).

**Acceptance criteria**

1. An integration test starts the server as a child process, without Electron:
   the job of a test bay runs, the result is visible through `jobs.json` and
   `/health`.
2. A sensitive call without a rule is rejected, with a rule allowed (test).
3. A path outside `--root` is rejected, also through a symlink (test).

## Phase 10 – Bridge desktop ↔ server – implemented

Parts 10a (protocol, pairing), 10b (connection, sidebar, remote bays) and 10c
(SSH tunnel, keyboard, zoom) implemented, [ADR 0019](adr/0019-desktop-server-bridge.md).
Host, user and remote port are in one field (`benutzer@host:port`); changing
means pairing again. A real SSH run against a Docker container is documented in
[STATUS.md](STATUS.md); a server over a real network is not yet. Added later:
reconnect after an interruption (backoff up to 30 s), no `ssh` after a crash of
the app, `pnpm test:ssh` in CI.

**Goal:** The desktop app shows the bays of a server as if they ran locally.

**Scope**

- WebSocket protocol with a version field (`hello`, `invoke`, `event`), the server
  supports the current and the previous version.
- Pairing: confirm the fingerprint of the server key at the first connect,
  afterwards the token of the server.
- The preload for remote bays routes `invoke`/`on` through the connection; the
  UI comes from the local bay bundle, same bay version required (otherwise
  "Version does not match" in the sidebar).
- Sidebar: group "Server: <name>" with its bays; disconnect and reconnect.
- The desktop app sets up the SSH tunnel (`ssh -L`) itself; settings: host, user,
  remote port.

**Acceptance criteria**

1. E2E with a locally started server (without SSH): create a project and session
   on the server, the terminal types and shows output, restarting the desktop app
   connects again.
2. Wrong fingerprint or wrong token: connection rejected (test).
3. The arguments for `ssh -L` are tested; a real SSH run is documented in the
   final report or named as unchecked.
4. axe light/dark, keyboard walkthrough and 200 % zoom for pairing and sidebar.

## Phase 11 – Questions and results over the bridge

Implemented: 11a (path form for server projects), 11b (permission dialog over the
bridge), 11c (notifications and badges) and 11d (jobs of the server in the
settings). Without a connection a permission question fails instead of storing
`deny` (a `deny` would stay permanently).

**Goal:** What needs a person on the server reaches the desktop.

**Scope**

- Pass the permission dialog on to a connected desktop; without a connection
  `deny` as in phase 9.
- Notifications and badges to connected desktops; without a connection collected
  and shown at the next connect.
- Agent bay: path input instead of a folder dialog for remote projects.
- The job list of the settings also shows the jobs of the server.

**Acceptance criteria**

1. E2E: a sensitive call on the server opens the dialog on the desktop, "Deny"
   takes effect on the server.
2. E2E: a job runs without a connection, result and notification appear after
   connecting.
3. Form "Path": edge case matrix (empty, outside the root, not a Git
   repository, Enter key), error messages with exact text.

## Phase 12 – Operation of the server

Implemented (ADR 0029): image, Compose and systemd example,
[server-operations.md](server-operations.md), `pnpm test:container`. Fixed on the way:
API keys of the service did not arrive in sessions.

**Goal:** The server runs permanently and can be backed up and updated.

**Scope**

- Container image (Node, Git, bays) and systemd unit (`Restart=always`) as an
  example; docs for setup, backup of the `--data` folder, deploy keys per
  repository, API keys as environment variables (agents on the server sign in
  with an API key; a subscription login applies only to clients on your own
  notebook).
- Restoring the sessions after a restart of the service as locally.
- ADR "Hangar server" (next free number) from the concept.

**Acceptance criteria**

1. Container smoke test locally with Docker: start, `/health` green, job runs,
   restarting the container restores sessions.
2. Linux checked only through the container; without a remote no CI on Linux
   (named in the final report).

## Phase 13 – Bus: remote callers

Implemented: `Caller` `remote`, `RemoteAccess` in the bus, manifest `remote` and
blocked prefix `remote.`, dialog text. What supplies membership and the share
list comes with phases 14 and 16; until then the bus rejects every remote call.

**Goal:** The bus knows callers of other instances safely, without a network
(ADR 0011).

**Scope**

- `Caller` `remote` with instance fingerprint and workspace.
- Rule "own bay" only for local callers (`packages/bus/src/bus.ts`, place
  `authorize`).
- Before any stored permission: membership, share list, "not sensitive";
  permissions bound to the fingerprint.
- Manifest: functions with `remote: true`; prefix `remote.` blocked for local
  bays.

**Acceptance criteria**

1. Red tests first: a remote caller with the same bay ID does not satisfy "own
   bay"; `allow` without a share list is not enough; sensitive functions can
   never be called remotely.
2. Existing permissions and tests unchanged green.

## Phase 14 – `packages/relay`: envelope and cryptography

Implemented: `packages/relay` (identity, member list, envelope, `ReplayGuard`,
`Endpoint`), dependency `@noble/ciphers`. Deviation: the tests were written
after the code; mutation probes show that they catch every security check (see
review).

**Goal:** Messages between instances are signed, encrypted and protected against
replay.

**Scope**

- Identity document (Ed25519, X25519), HKDF per direction, XChaCha20-Poly1305
  with a 192-bit nonce, canonical header as AAD, signature over
  header + nonce + ciphertext.
- Epoch and number per connection; receive state persistent before execution.
- Signed, versioned member list.

**Acceptance criteria**

1. Tests with two clients in the same process: end-to-end, wrong signature,
   modified ciphertext, modified header, replay after restart, expired member
   list are rejected.
2. Review by Codex (read-only) for this package only; findings checked as in
   phase 6.

## Phase 15 – Relay server

Implemented: `apps/relay`, `RelayClient` in `packages/relay`, image
`docker/relay`. Deviation: the client does not check arguments against
`inputSchema` (no JSON schema validator installed); the handlers check. A join
waits until the confirmed inviter signs a list
([review](reviews/2026-11-02-phase-15-relay-server.md)).

**Goal:** Instances connect outbound to a self-operated relay.

**Scope**

- `apps/relay`: WebSocket over TLS, workspaces, invitation token, forwarding
  without storing contents.
- Transport in the bus (`registerTransport`) for remote functions
  `remote.<instanz>.<bay-id>/<funktion>`.
- Container image as in phase 12.

**Acceptance criteria**

1. Integration test: two Hangar buses over a local relay, a call of a shared
   function succeeds, one of a function that is not shared fails.
2. The relay sees no contents in its log and memory (test for a plaintext
   marker).

## Phase 16 – Workspaces in the UI

Implemented: [ADR 0030](adr/0030-workspaces-ui.md), settings
"Workspaces", sharing per project in the agent bay, "Other instances" in the
project tree. Deviations: the status goes as its own encrypted message `state`
instead of through a bay function (no permission dialogs per query); the sharing
of a project applies to all workspaces of the instance; without a keychain the
keys are stored unencrypted (mode 600). Linux and CI not checked
([review](reviews/2026-11-02-phase-16-workspaces-ui.md)).

**Goal:** People set up workspaces and see what other instances share.

**Scope**

- Settings: create a workspace, invite, confirm the fingerprint on both sides,
  remove a member; share list per function.
- Agent bay: sharing per project (default off), events on status change;
  workspace view with instance, project, session, status, summary, marked as
  remote origin.

**Acceptance criteria**

1. E2E with two desktop instances and a local relay: invitation, confirmation,
   a status change appears on the other side.
2. Forms with edge case matrix; axe light/dark, keyboard, 200 % zoom.

## Phase 17 – Handovers

Implemented: [ADR 0031](adr/0031-handovers.md), `handover.create` and
`handover.get`, `hangar handover`, display above the terminal of the target
session. Deviations: a handover always opens a new session and never writes into
a running shell; no reply to the sender and no history in the sidebar; at most
five open remote handovers. Review:
[reviews/2026-11-02-phase-17-handovers.md](reviews/2026-11-02-phase-17-handovers.md).

**Goal:** An agent hands work over to another, first locally, then remotely.

**Scope**

- `dev.hangar.agents/handover.create` (branch, task, context) and display in the
  target session; then the same function through the share list.
- Remotely only text and Git references (remote, branch), never files.

**Acceptance criteria**

1. Local: E2E handover between two sessions.
2. Remote: integration test over the relay; rejected without sharing.

## Phase 18 – Manifest: `uses`, `agentSessions`

**Implemented** (ADR 0032). Deviations: the check of `uses` sits in the bay
runtime (`ctx.call`), not in the bus – it is the only source of callers of kind
`bay`, the bus does not know manifests. `hostModules` existed already.
`dataVersion` is only checked, the backup follows in phase 20. Fixture bays
needed no change (no foreign calls, no sessions); the test bays of the server
carry `agentSessions: true`.

**Goal:** Bays declare what they use; the bus enforces it (ADR 0012, works
without a registry too).

**Scope**

- Manifest fields `uses`, `agentSessions`, `hostModules`,
  `dataVersion`.
- The bus rejects calls outside `uses`; `registerAgentSession` only with
  `agentSessions`.
- Extend the agent bay and fixture bays.

**Acceptance criteria**

1. Red tests first for every rule; existing bays run unchanged.

## Phase 19 – `.bay` packages and signature check

**Implemented** (ADR 0033). Deviations: own tar code without a new dependency;
one key for index and packages (no `publishers.json`); key rotation still open.
The package contains `manifest.json`, icon and `dist/`.

**Goal:** Bays can be built as signed packages and checked.

**Scope**

- `pnpm pack:bay <id>`: tar.gz, SHA-256, Ed25519 signature.
- Check module: signature, checksum, path escape (also symlinks), index with
  expiry date and version counter.

**Acceptance criteria**

1. Tests: wrong signature, wrong checksum, `../` and symlink in the archive,
   expired and rolled-back index are rejected.

## Phase 20 – Installation, update, rollback

**Implemented** (ADR 0034). Deviations: index address and key from the
environment until phase 21 brings a built-in key; pointer in `_state.json`; old
versions are deleted on switching; approval dialog as a native confirmation;
older versions only through rolling back; removing installed bays is missing.

**Goal:** Bays are installed from an index, updated and rolled back, without a
new Hangar build.

**Scope**

- Storage `<userData>/packages/<id>/<version>/`, pointer to the active version,
  switch at the next start; backup of the data on a new `dataVersion`.
- Approval dialog with permission diff (new functions, `uses`, capabilities).
- Settings: install, update, roll back bays.

**Acceptance criteria**

1. E2E with a local index: installation, update with permission diff, rollback.
2. axe light/dark, keyboard, 200 % zoom.

## Phase 21 – Index on GitHub Releases

**Goal:** Hangar finds updates of its bays by itself.

**Scope**

- Static index and packages on GitHub Releases; API paths `/v1/…`.
- Daily update check through the scheduler; installation never without
  confirmation.

**Open:** the remote exists since 2026-11-04, but `derivo/hangar` is private;
Hangar cannot load its Releases or Pages without a token. Decision needed
first: a separate public repository for index and packages, or making
`derivo/hangar` public. The built-in public key and a scheduled re-signing of
the index (it expires) belong to this phase.

**Acceptance criteria**

1. The release workflow publishes a signed index; Hangar reports an update and
   installs it after confirmation.

## Outside this roadmap

Third-party bays (not planned for now: only a registry with own bays; would
require an operating system sandbox for the main part), browser and password
bay, phone view and web UI, command palette, automatic worktree setup, signing
and notarization (certificates of the user).

## Noted, not yet planned

- **Sessions survive a restart of Hangar** (ADR 0036, agent bay in the local
  server): step 1 done (runtime copy, LaunchAgent, `listen.json`, `pair-code`,
  pairing without a code; only with `HANGAR_LOCAL_SERVER=1`); step 2 done (move,
  agent bay only in the server, folder dialog, environment); step 3 done (bays of
  the app for agents of the local server, protocol 3); step 4 done (name in the
  sidebar, "not running", new version, tray; switch with a way back, default in
  the packaged app on macOS); step 5 done (workspaces including identity in the
  server, settings over the bridge, protocol 4).
- **Sort bays in the sidebar** (wish 2026-11-04, **implemented**, ADR 0038):
  reorder bays and shortcuts of the left sidebar by drag and drop. `settings.json`
  already keeps the sidebar in order (ADR 0017). Without dragging also by
  keyboard or menu ("Move up", "Move down", WCAG 2.5.7), as when sorting the
  projects in the agent bay.
