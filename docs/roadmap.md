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

**Open:** the remote exists since 2026-11-04 and `derivo/hangar` is public
(checked 2026-11-18), so Hangar can load its Releases and Pages without a
token. Still to decide: whether index and packages are published there or in
a separate repository. The built-in public key and a scheduled re-signing of
the index (it expires) belong to this phase.

**Acceptance criteria**

1. The release workflow publishes a signed index; Hangar reports an update and
   installs it after confirmation.

## Workspaces: inbox and activity log (ADR 0046, done 2026-11-16)

**Goal:** Work from other instances (tasks, handovers) waits in an inbox until
the person accepts it or trusts the sender; every remote call shows in a local
activity log. Built; open: a `hangar-server` option to trust a member at join
(with ADR 0047). Next: the first real test with two people over a public relay.

## Workers on virtual machines (ADR 0047, proposed)

**Goal:** Hangar servers on Linux machines work the tasks of the owner's board:
claim with a lease, run the agent in a worktree per task, push a branch, note
and complete; robust against restarts, lost connections, cancellation and usage
limits. Requires ADR 0046. Steps and acceptance in the ADR.

## Proxy bay

Proposed in [ADR 0049](adr/0049-proxy-bay.md), revised after the Codex review
([reviews/2026-11-23-traffic-bay-plan.md](reviews/2026-11-23-traffic-bay-plan.md));
UI mockup [mockups/proxy-bay.html](mockups/proxy-bay.html). Wish
2026-11-23: see everything an agent session sends and receives, sorted by
project.

**Goal:** A new bay `dev.hangar.proxy` runs mitmproxy as a local
intercepting proxy, the agent bay routes watched sessions through it, and the
person sees each request and response grouped by project and session – model
API, telemetry, MCP, packages – redacted, in memory, live. macOS, Linux and
Windows.

**Decided (2026-11-23)**

- Name: "Proxy" in both languages, id `dev.hangar.proxy`, folder `bays/proxy`.
- Watching is switched only in the agent bay (project default, per session);
  the proxy bay shows the state.
- No link from the agent bay to a filtered proxy bay in this plan.
- Pause stops recording, traffic goes on.
- Windows is part of the plan.
- `session.info` gains `color`, `status`, `agent`, `watchActive`.
- mitmproxy stays an external tool, no own engine in Node.
- Flows only in memory; across a restart only the HAR export.
- Agents get `flow.list` and `flow.get` for their own session.

### Step 0 – Spike: what the engine and the agents really do

**Done 2026-11-23 on macOS**, results in ADR 0049 ("Spike results"). Open:
point 7 on a Windows machine (`mitmdump.exe`, both agents through the proxy).

Throwaway scripts in the scratchpad, no product code. Results go into ADR 0049
and this section; the ADR changes where a result contradicts it.

1. One `mitmdump --set listen_host=127.0.0.1` with two
   `regular@127.0.0.1:<port>` listeners; add and remove a third at run time
   from the addon (`ctx.options.update(mode=…)`), confirm the bind before
   answering, and record whether open connections of other listeners survive.
   Check the bound addresses with `lsof -iTCP -sTCP:LISTEN`.
2. Proxy credentials in `HTTPS_PROXY` (`http://hangar:<pw>@127.0.0.1:<port>`):
   do `claude -p` and `codex exec` send them? Addon check per listener for
   plain HTTP and at `http_connect` for HTTPS (connection counts as
   authenticated afterwards), 407 otherwise.
3. Codex: start once with only `SSL_CERT_FILE`, once with only
   `CODEX_CA_CERTIFICATE`; note which one is needed.
4. Bypass: run both agents with a proxy and compare their open TCP connections
   (`lsof -i -a -p <pid>` in a loop, children included) with the flows; every
   connection not to the proxy port is a finding. Repeat with inherited
   lower-case `https_proxy` and `no_proxy=*` to prove the override.
5. Streaming: time to the first token of `claude -p` with and without the
   proxy, with `flow.response.stream` set in `responseheaders`.
6. WebSocket: does Codex's `codex/responses` arrive in `websocket_message`,
   and does clearing `flow.websocket.messages` keep memory flat over 10 min?
   Send 20 MB in fragments without the final one: does the wrapper around
   `WebsocketLayer.relay_messages` (ADR 0049) close both sides with 1009 at
   16 MB, emit `ws.tooLarge` and free the buffer, without a final fragment?
7. Windows: `mitmdump.exe` from `uv tool install mitmproxy`, the bundle from
   `tls.getCACertificates('system')` – is that available in the Node of the
   Electron version Hangar ships? Both agents once through the proxy.

**Acceptance criteria:** a table in the ADR with one line per point, command and
result; the ADR names what changed.

### Step 1 – Host: `onBaysStarted`

- `packages/sdk` and `packages/host` (runtime) plus `apps/server` and the
  desktop host: `ctx.onBaysStarted(listener)`, called once after every bay of
  the process has finished `activate` (also after a failed one); a listener
  added later runs at once. Agent bay: `manager.restore()` moves from
  `activate` into it.

**Acceptance criteria**

1. Red first: a server test with fixture bays "A" and "Z" that name each other
   in `uses`; "A" calls "Z" in its `onBaysStarted` listener. Called in
   `activate` today it fails with `Unknown function`; in the listener it
   succeeds.
2. A listener added after the start runs at once; a bay whose `activate`
   throws does not hold the others back.

### Step 2 – Bay skeleton and engine

- `bays/proxy` per skill `new-bay`: manifest (`id dev.hangar.proxy`,
  functions `proxy.env` and `proxy.status`, both `bayOnly`, and `flow.list`,
  `flow.get` for agents (`sensitive`, ADR 0049); `uses`
  `dev.hangar.agents/session.info` and `dev.hangar.agents/project.list`;
  text settings `mitmdumpPath`, `maxFlows` (default `5000`), `maxMegabytes`
  (`200`), `upstreamCaFile`, `rules` (one rule per line, defaults below)),
  `CLAUDE.md`, icon.
- Shipping: `electron-builder.yml` entry with `dist/**` and `asarUnpack` for
  `bays/proxy/dist/addon/**`; `IN_SERVER` in `apps/desktop/src/main/index.ts`
  and the data move of ADR 0036; `docker/linux-server/Dockerfile` and
  `scripts/linux-server-package.mjs`.
- `src/main/engine.ts`: find `mitmdump` (setting, then `PATH`; `.exe` on
  Windows), read its version, start it with `listen_host=127.0.0.1`, no
  default listener, `flow_detail=0`, `termlog_verbosity=error`,
  `show_ignored_hosts=true`, `ssl_verify_upstream_trusted_ca=<dataDir>/upstream.pem`,
  the addon and `confdir=<dataDir>/ca`; restart with backoff
  1 s, 5 s, 30 s and the same listeners; stop on `deactivate`. Interface
  `Engine` (`start`, `stop`, `listen`, `unlisten`, `setRules`, `setCapture`,
  `ignore`, events) so tests use a fake engine.
- `src/main/protocol.ts`: JSON lines both ways, request ids, `reply` with
  `ok`/`error`, 5 s timeout, bounded queues (1 000 lines and 8 MB, overflow
  counted); broken or unknown lines are counted warnings, never a crash.
- `src/main/ca.ts`: CA on first start (folder 0700, `mitmproxy-ca.pem` 0600,
  sessions get only `mitmproxy-ca-cert.pem`); `upstream()` writes
  `<dataDir>/upstream.pem` from the system roots plus `upstreamCaFile`;
  `bundle(env)` writes `<dataDir>/bundles/<generation>/<session>-<hash>.pem`
  (hash over the content, never rewritten) from the system roots (macOS
  `/etc/ssl/cert.pem`; Linux `/etc/ssl/certs/ca-certificates.crt` or
  `/etc/pki/tls/certs/ca-bundle.crt`; Windows `tls.getCACertificates('system')`),
  the extra certificates named in the merged environment and the CA; no source
  → error with the reason. `renew()` in the order of ADR 0049.
- `addon/hangar_proxy.py` (built to `dist/addon/`): commands from stdin,
  only its JSON lines to stdout, mitmproxy's log to stderr, per-listener
  credentials check (plain HTTP per request, HTTPS at `http_connect`, then
  per connection) and removal of `Proxy-Authorization`, redaction of the copy
  only, body limit, streaming set in `responseheaders` and `requestheaders`,
  WebSocket forward and clear, 16 MB limit for fragmented messages via the
  `relay_messages` wrapper, version check `>=12.3,<13` at start, `tunnel`
  rows for ignored hosts with bytes counted in `tcp_message`, `capture`
  on/off.

**Acceptance criteria**

1. Unit tests for `protocol.ts` (timeouts, overflow by lines and by bytes,
   broken lines), `ca.ts` (modes 0700/0600, bundle with inherited
   certificates, new generation path on renewal, missing source),
   engine restart with listeners (fake process); 90 % coverage in
   `bays/proxy/src/main`.
2. Integration test with a real `mitmdump` against a test HTTPS server on a
   host name outside `NO_PROXY` (`proxy-test.invalid` mapped to `127.0.0.1`
   in the test's resolver, or the proxy's upstream address override), with an
   own test CA given to mitmproxy as `upstreamCaFile`, and once against a
   public HTTPS host (both trusted together):
   - the request appears as `flow.request`/`flow.response` with the session
     port, `Authorization` redacted in the event,
   - the test server received the original `Authorization`,
   - `lsof` (macOS/Linux) or `Get-NetTCPConnection` (Windows) shows only
     `127.0.0.1` listeners,
   - a wrong proxy password gets 407, HTTPS through an authenticated CONNECT
     works, the upstream never sees `Proxy-Authorization`,
   - stdout of `mitmdump` holds only parsable JSON lines, and a token in a
     query string appears only redacted,
   - a pass-through of a host on port 8443 yields a `tunnel` row with the
     known byte counts.
     Skipped with a visible reason if `mitmdump` is missing; CI installs it
     (`uv tool install mitmproxy`) on all three runners.
3. Packaged smoke test: the addon is a real file under `app.asar.unpacked`
   and `mitmdump` loads it from there.
4. `python -m py_compile` of the addon in `pnpm lint`.

### Step 3 – Sessions through the proxy

- Proxy bay `proxy.env({ sessionId, inherited })`: only from
  `dev.hangar.agents` (bay caller, with or without `local-server:`), which
  fixes the origin key of the session; idempotent per session (same port
  and credentials on repeated calls, also after a shell restart; the bundle
  path changes only when `inherited` yields other certificates); binds the port
  via `listen` and answers only after its `reply`; returns the variables of
  ADR 0049 in upper and lower case (proxy URLs with the port's credentials)
  and the path of the session bundle (built from `inherited`: `{
NODE_EXTRA_CA_CERTS?, SSL_CERT_FILE?, … }` of the merged environment).
  `onAgentSessionEnded` unbinds; a freed port is not reused for 60 s.
  `proxy.status` returns `{ engine: 'running' | 'missing' | 'failed',
version?, reason? }`.
- Agent bay: `SessionRecord.watchTraffic` and `Project.watchTraffic` (default
  for new sessions) in `state.json`. In `startShell` – also on `restore()` –
  (now in `onBaysStarted`) – a watched session calls `proxy.env` next to
  `secret.resolve`; the shell
  starts only after both answers, only the answer of the last start counts.
  `environment()` applies the proxy variables last, so they override process
  and session values of the same names in both cases. Failure: `Shell not
started: <reason>`, `session.exit` -1. `uses` gets
  `dev.hangar.proxy/proxy.env` and `dev.hangar.proxy/proxy.status`.
- Agent bay: `session.info` additionally returns `color` (or `null`),
  `status`, `agent` (or `null`) and `watchActive` (the running shell got proxy
  variables); additive, the board ignores them.
- Agent bay UI: checkbox "Watch traffic" in the project overview (default for
  new sessions) and in the context menu of a session ("Watch traffic – from the
  next start"); a session whose wish differs from `watchActive` says "applies
  at the next start". If `proxy.status` reports no proxy bay or no engine,
  switching on is disabled with the reason (`aria-disabled`, description);
  switching off always works, so a session whose shell does not start for
  that reason can be run unwatched again.
- Proxy bay `src/main/sessions.ts`: session id → `{ projectId, project,
name, color, status, agent, watchActive, ended }` via `session.info` and
  `project.list`; asked at `proxy.env` and on UI `state`, at most every 5 s per
  session; `Unknown session` marks it ended and keeps the last values.

**Acceptance criteria**

1. Unit tests in the agent bay with a fake `call`: watched session gets the
   variables, unwatched does not and calls nothing, failure blocks the start,
   only the answer of the last start counts, inherited `https_proxy` and
   `no_proxy=*` are overridden, `session.info` returns the new fields;
   without engine a watched session can be switched off and then starts.
2. Unit tests in the proxy bay: repeated `proxy.env` returns the same port;
   with other certificates in `inherited` it returns a new bundle path and
   the old file is byte for byte unchanged; ended session unbinds; a port is not reused within 60 s; the same session
   id from another origin gets its own key; a renamed session
   shows the new name after the next refresh; an ended one keeps project and
   name.
3. Cold start (server test): a stored watched session restores with its shell
   running through the proxy, not `Shell not started`.
4. E2E: a watched session runs `curl https://proxy-test.invalid/` (resolved
   as in step 2) and the flow appears under its project and session; a
   request to Hangar's MCP URL does not appear (stays direct); `flow.list`
   over MCP with the session's token returns the flow, with another session's
   token not.

### Step 4 – Flow store

- `src/main/store.ts`: ring buffer by count and bytes, flows keyed by id,
  stream chunks and WebSocket messages appended up to the body limit,
  classification by `rules` (first match wins), counters per project and
  session (requests, bytes up and down, errors, per class), pause markers.
- Default rules:

  ```text
  model-api   api.anthropic.com/v1/messages
  model-api   chatgpt.com/backend-api/codex/responses
  model-api   api.openai.com/v1
  telemetry   api.anthropic.com/api/event_logging
  telemetry   api.anthropic.com/api/claude_code/metrics
  telemetry   chatgpt.com/backend-api/codex/analytics-events
  telemetry   *.datadoghq.com
  telemetry   *.sentry.io
  mcp         mcp-proxy.anthropic.com
  mcp         api.githubcopilot.com/mcp
  packages    registry.npmjs.org
  packages    pypi.org
  packages    files.pythonhosted.org
  ```

  Anything else is "other".

- UI channels: `state` (engine, projects in `project.list` order with their
  sessions and counters), `flows({ project?, session?, classes?, text?,
errorsOnly?, before?, limit })`, `flow.get(id)`, `clear({ project?,
session? })`, `pause(boolean)`, `export({ ids? })`, `passThrough({ host,
port })`,
  `renewCa`. Events: `state`, `flow` (new or changed, batched every 250 ms).

- Functions for agents `flow.list` and `flow.get` with the schemas of ADR 0049
  (`sensitive`): only callers `{ kind: 'session', bayId: 'dev.hangar.agents' }`
  or its `local-server` form, keyed by origin and session.

**Acceptance criteria:** unit tests for `flow.list`/`flow.get` (own flows only,
another session's id is `Unknown flow`, the same session id from another bay
or origin gets nothing, a bay caller gets `No session`, schema: `since`
exclusive, `limit` 1–200, `more`, open and failed flows with `null` fields,
bodies as `utf8` and as `base64`, a text and a binary WebSocket message, an
SSE event, `truncated` per direction, repeated header names, 100 000
characters per direction across body and messages, redaction as in
the UI), a bus test that a release "for this session" does not reach a second
session, and unit tests for eviction by count and by bytes, rule
parsing (invalid line named, default applies), first-match classification,
filters, batching, pause (during the pause a request passes, nothing is stored
or counted, the marker row appears on resume).

### Step 5 – UI

As in the mockup ([mockups/proxy-bay.html](mockups/proxy-bay.html)):

- Header: engine state with version and port count, or the install hint
  (`uv tool install mitmproxy`, `brew install mitmproxy`); "Pause"/"Resume",
  "Clear", "Export HAR".
- Left column: "All sessions", then one group per project in the agent bay's
  order (name, requests, bytes; collapsible, state in `localStorage`) with its
  watched sessions (tab color stripe, status light with the status as text for
  screen readers, agent, requests, bytes); ended sessions marked "ended".
  A project filters to all its sessions, a session to itself.
- Middle: filter field (host, path, method), class chips with counts,
  "Follow" toggle; table with time, session, method, host + path, status,
  class, size, duration. One focusable element per row; selecting keeps focus
  on it (no re-render of the row list), ↑/↓ move, Enter opens the detail.
- Detail below or right (by width): tabs "Overview", "Request", "Response",
  "Stream", "Headers" (WAI-ARIA tabs, panel labelled by the active tab); JSON
  pretty-printed; redacted values marked; notice "Bodies may contain secrets"
  in the detail, next to "Copy as curl (headers redacted)" and in the export
  dialog; "Pass through this host" with host and port on TLS errors.
- Texts de/en in `messages.ts`; empty states: no engine, no watched session,
  no flows yet ("Only traffic that uses the proxy is shown").

**Acceptance criteria**

1. E2E with the fake engine: project and session filter, collapse, keyboard
   selection keeps focus, detail tabs, follow, pause/resume marker, clear, live
   stream rows.
2. axe-core light and dark: 0 violations; keyboard walkthrough and 200 % zoom
   documented; `A11y-Check:` trailer.
3. 5 000 rows stay usable: virtualized rows; an E2E test scrolls the table
   from top to bottom in 2 s with `requestAnimationFrame` timing in the page
   and attaches the frame times; budget: 95th percentile below 25 ms on the
   CI macOS runner. If it fails, the default limit is lowered.

### Step 6 – Export, pass-through, CA renewal

- HAR 1.2 export of the filtered rows or the selection, redacted as stored,
  with the warning about bodies.
- "Pass through this host": escaped and anchored `host:port` for
  `ignore_hosts`, list in the settings, `tunnel` rows; applies from the next
  connection.
- "Renew CA" in the order of ADR 0049 (new bundle generation, cached
  `proxy.env` answers cleared); running watched shells are named ("restart to
  trust the new CA").

**Acceptance criteria:** HAR opens in a browser's network panel (manual check,
noted in STATUS); pass-through of `pinned.invalid:8443` does not match
`xpinned.invalid:8443` or `pinned.invalid:443`; after renewal a restarted shell
works, a running one fails TLS and is named, `proxy.env` answers nothing during
the swap, the old bundle file is unchanged.

### Step 7 – Documentation and review

`bays/proxy/CLAUDE.md`, `docs/mcp.md` (`flow.list`, `flow.get`),
`docs/bay-development.md` (bay list, `onBaysStarted`), `bays/agents/CLAUDE.md` (watch traffic, `session.info`), README
packages, STATUS, CHANGELOG "Unreleased", ADR 0049 to "accepted". Codex review
of the whole diff with `--sandbox read-only`, record in `docs/reviews/`;
second pass because TLS interception and secrets are involved.

## Outside this roadmap

Third-party bays (not planned for now: only a registry with own bays; would
require an operating system sandbox for the main part), browser and password
bay, phone view and web UI, command palette, automatic worktree setup, signing
and notarization (certificates of the user).

## Noted, not yet planned

- **Server on a Linux machine, set up from the app** (wish 2026-11-11,
  [ADR 0041](adr/0041-remote-linux-server.md)): Linux runtime shipped in the
  app, setup and updates over SSH as a systemd user unit, pairing without a
  code, subscription login on one's own machine. Four steps, none done yet.

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
