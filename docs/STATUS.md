# Status

As of 2026-11-06, version 0.1.0. All milestones from
[specification-mvp.md](specification-mvp.md) §10 are implemented. Verification ran
locally on macOS (arm64). The gaps are listed below, the next steps in [roadmap.md](roadmap.md).

## Milestones

| No. | Milestone                                    | Evidence                                                                                                                |
| --- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | Repository, tooling, CI, CLAUDE.md, skills   | `pnpm lint`, `typecheck`, `test` green locally; `.github/workflows/ci.yml` green once (run 42001257976), **not stable** |
| 2   | Shell with sidebar, theme, test bay          | `apps/desktop/e2e/m2-shell.spec.ts`                                                                                     |
| 3   | Agent bay: project, session, worktree, shell | `apps/desktop/e2e/m3-agents.spec.ts`                                                                                    |
| 4   | Save and restore sessions                    | `apps/desktop/e2e/m4-restore.spec.ts`                                                                                   |
| 5   | Bus, permissions, MCP server                 | `bays/agents/src/main/mcp.integration.test.ts`                                                                          |
| 6   | CLI, MCP configuration, Claude Code hooks    | `bays/agents/src/main/cli.integration.test.ts` (real shell via node-pty), `e2e/m6-cli.spec.ts`                          |
| 7   | Status bar, notifications, badges, tray      | `apps/desktop/e2e/m7-notify.spec.ts`                                                                                    |
| 8   | Docs, skills, packages                       | macOS dmg/zip and Windows NSIS built; `e2e/m8-updates.spec.ts`; this file                                               |

## Results (local, macOS arm64)

| Command                                      | Result                                                                                                                                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`, `lint`, `typecheck`, `build` | Exit 0                                                                                                                                                                                               |
| `pnpm test`                                  | 93 files, 1296 tests green, 1 skipped, random order; coverage 98.46 % / 97.37 % (gate incl. desktop main process, 2026-11-06)                                                                        |
| `pnpm test:e2e`                              | 58 green, 1 skipped (packaged only), with error gate (2026-11-04, window invisible); `pnpm test:ssh` 3 of 3 (as of ADR 0025); `pnpm test:container` 3 of 3                                           |
| E2E against package                          | 26 of 26 green against `release/0.1.0/mac-arm64/Hangar.app` (as of after phase 8); 2026-11-04 `secrets-board`, `local-server`, `sidebar-bays` 9 of 9 against a fresh package (`--mac dir`, unsigned) |
| Lint rule `packages/host`                    | Probe file with `import { app } from 'electron'` → `no-restricted-imports` error; `packages/host/src` 100 % lines, 98.11 % branches                                                                  |
| `pnpm docs:api`                              | typedoc without warnings; every public SDK interface is documented                                                                                                                                   |

**Icons** (phase 5): The package `release/0.1.0/mac-arm64/Hangar.app` was built
with the new app icon (`icon.icns` checked); the tray image in the package is a
template image (`isTemplateImage()` true, scales 1 and 2). Contrast of the
sidebar icons against the dock (WCAG formula, axe does not check graphics):
glyph 7.59:1 (light) and 11.22:1 (dark), agent bay 14.22:1 and 15.85:1.

The package (`electron-builder --mac dir --arm64`) thus covers all specs,
including grid, separate windows, permissions and jobs with the login shell of
the package. electron-builder signs locally with an existing Apple Development
identity; notarization is not done (see below).

**Accessibility:** axe-core 4.14.0, WCAG 2.2 AA, light and dark, 0 findings
for the app shell, settings, Hangar overview, agent bay (empty tree,
error message, ended shell, project overview, grid with three fields,
undocked session in its own window, permissions with session and
permanent permission including keyboard walkthrough, "Schedule job" form with
error message, job list after a run including keyboard walkthrough); agent bay and settings also in
English. 200 % zoom without overflow of the page, also with pseudo texts
(`e2e/a11y.spec.ts` and the specs above). Exception: At 200 % zoom the grid
scrolls within itself because a terminal stays 80 characters wide (two-dimensional
content, WCAG 1.4.10).

Fresh clone (`git clone` + `pnpm install --frozen-lockfile`): all six
commands green. Electron 45 downloads its binary on first access, no
manual step is needed. pnpm reports ignored build scripts of
`electron-winstaller`; this only affects Squirrel targets, which Hangar does not use.

## Open points and limits

- **Signing and notarization**: configured (`electron-builder.yml`,
  `release.yml`), but not run. Prerequisites are an
  Apple Developer account and a Windows code signing certificate as secrets
  (list: skill `release`). Without a signature, auto-update does not work on
  macOS. The repository `derivo/hangar` is private: `electron-updater`
  (`provider: github`) and any index on its Releases or Pages need a token,
  so packaged apps find no update without one.
- **CI**: First run on 2026-11-04 after the push to
  `git@github.com:derivo/hangar.git`. Since `96332a0` Windows, Linux (with the
  AppImage), SSH, both containers and all macOS E2E tests but one are green.
  Two E2E tests read the shell too early on the runner, never locally:
  `sidebar-order.spec.ts` (fixed in `96332a0`) and the local server pages in
  `a11y.spec.ts` (the host overwrote the pushed state; the test now pushes
  until it shows). Run 41932094202 then failed two other terminal waits that
  had passed before (`m4-restore.spec.ts:13`, `project-overview.spec.ts:15`).
  E2E tests now retry twice in CI (`playwright.config.ts`); a test that passes
  on retry is reported as flaky, so a rare real failure no longer turns the
  run red. Flaky tests are to be fixed one by one locally with
  `--repeat-each`. Run 42001257976 (`8b7feaf`) was the first with every job
  green, without a retry. The two runs after it are red again (as of
  2026-11-06), both not yet investigated:
  - Run 42062340811 (`8d1d0a7`, macOS): `local-server.spec.ts:130` failed in
    all three attempts. After the app's restart the shell showed
    `echo AFTERQUIT=$$` and the next prompt, but not its output. Cause: the
    terminal dropped live output until the scrollback arrived, but over the
    bridge an event can overtake that answer. Fixed with a position in
    `session.data` and `session.snapshot` (`bays/agents/CLAUDE.md`), backed by
    `terminals.test.ts`; locally the test never failed (6 of 6 before the fix),
    so only CI shows whether it holds. The helper `shellPid` now reads the rows
    once per try (the `TypeError` on the retries).
  - Run 42005154571 (`a52e991`, Windows): `apps/relay/src/client.test.ts`
    ("answers at most 10 calls … also after its calls timed out": "The relay
    did not answer") and `apps/relay/src/workspaces.test.ts` ("renews the
    member list on its own": "Not newer than the stored list"); both passed on
    macOS and Linux in the same run. Causes: the first test bounded the
    requests to the relay while pairing with its 100 ms call timeout (now
    1000 ms); in the second a renewal and an own list change drafted the same
    version, and the relay refused the later one. `RelayClient` now publishes
    its own changes one after another (`client.test.ts`). Not yet confirmed by
    a Windows run in CI.

  `release.yml` is untested.

- **Windows**: The installer was cross-built on macOS and never started.
  Unchecked are shell start (`defaultShell`), `hangar.cmd` and the app itself.
  Skipped under Windows: the integration tests with `/bin/sh`, the SSH tunnel
  with the fake ssh (shebang script), POSIX file modes, the local server
  (macOS only) and the POSIX job tests; two job tests run through cmd.exe. A
  job that times out or whose session closes ends its whole process tree under
  Windows too (`taskkill /T /F`, `job-process.test.ts`, Windows runner only). `writeDurable` flushes
  the file instead of the folder; whether that makes the rename durable on NTFS
  is not proven.
- **Linux**: Packages are only built in CI (node-pty has no Linux prebuilds and
  is compiled during install). Not checked. `app.setBadgeCount` only works in
  Unity-like desktops.
- **Auto-update**: Channel choice and options are tested. Download and
  installation are not checked end to end without a published release.
- **Real Claude Code run** (Claude Code 2.1.312, 2026-10-28, macOS,
  session with a cleaned environment in a temp repository):
  - `claude -p` in the session: server `hangar` connected, four tools
    (Claude Code rewrites `/` and `.` in the name to `_`, e.g.
    `mcp__hangar__dev_hangar_agents_session_setDescription`).
    `session.setDescription` and `session.setStatus` return `{"ok":true}`,
    the UI shows description and status; the stop hook sets "done".
  - Interactive `claude`: For every new worktree, Claude Code asks once
    "Is this a project you created or one you trust?". After that, `hangar` is connected without
    further approval (`/mcp`: 4 tools).
  - `claude mcp list` still shows `hangar` as "Pending approval"; `-p` and
    the interactive session connect nonetheless.
  - Not checked: the notification hook ("waiting for input").
  - If Hangar was started from a Claude Code session, the session shells inherited
    its `CLAUDE_*` and `ANTHROPIC_*` variables ("Transcript saving is
    off"). Fixed: `sessions.ts` filters `CLAUDECODE`, `CLAUDE_*`,
    `ANTHROPIC_*` and `MCP_*` from the inherited environment.
- **`info/exclude`**: Git has no per-worktree exclude. The entries for
  `.mcp.json` and `.claude/settings.local.json` also apply in the main checkout
  (ADR 0008).
- **Specification §7, "once"**: For sensitive functions, the dialog offers
  "Always allow", "For this session" (for bays: "Only this time"),
  "Ask on every access" and "Deny". The interpretation is in ADR 0006.
- **Jobs** (ADR 0013): run only while Hangar runs; up to 15 seconds
  after the due time. The job of the agent bay runs as its own process in the
  worktree (ADR 0014), time limit 60 minutes; its output does not appear in the
  terminal. The call via `cmd.exe` and PowerShell is only backed by unit tests
  and has never run under Windows. A scheduled run (instead of "Run now")
  has only been checked with a faked clock in unit tests, not end to end.
- **Bundled bays**: `bays/agents` and `bays/browser` are listed in
  `electron-builder.yml`. New bays must be added there (skill `new-bay`).
- **Browser bay** (ADR 0015): Tabs of the person are permanent, each agent session has
  its own tabs and cookies; backed by `bays/browser/src/**/*.test.ts` and
  `e2e/browser.spec.ts` (local HTTP server: text, click, input, screenshot,
  separate cookies of two agents, restore, axe light/dark, 200 %).
  Also checked in the packaged app bundle. Functions without prompt
  (`openToAgents`), tabs close when their session ends (ADR 0016);
  both backed in `e2e/browser.spec.ts`. Page zoom (2026-11-07): keys,
  percent and reset in `browser-tabs.test.ts`, button in `App.test.tsx`,
  E2E `browser.spec.ts` (native key events, axe light and dark 0 findings).
- **Bays in the sidebar** (ADR 0017): empty start with plus, selection modal,
  removal via right-click; backed by `src/renderer/Sidebar.test.tsx` and
  `e2e/sidebar-bays.spec.ts` (keyboard, axe light/dark for the modal, restart,
  removal). The real native context menu is replaced in the test, not clicked.
  An error when starting a chosen bay appears in the modal; backed only by a
  unit test.
- **Shortcuts in the sidebar** (ADR 0027): Programs, folders, files and
  web pages via the plus ("Add to sidebar"), open by click, remove
  via right-click; backed by `packages/host/src/shortcuts.test.ts`,
  `src/renderer/Sidebar.test.tsx` and `e2e/shortcuts.spec.ts` (URL matrix, keyboard,
  axe light/dark, restart). File dialog, `shell.openPath`/`openExternal` and
  context menu are replaced in the E2E; the real opening is not checked automatically.
  Not run under Windows and Linux.
- **Multiple clicks on the same button** (ADR 0028): lock per action until the
  response, follow-up clicks of a multi-click ignored for creating, running,
  opening and deleting buttons, `Host.addBay` starts a bay only
  once. Backed by unit tests per button and `e2e/chaos.spec.ts` (4 tests,
  `click({ clickCount: 5 })`, 10 repetitions without failure). Submit buttons
  (add job, open, continue/pair) likewise. Every E2E test
  fails on an unhandled page error (`e2e/helpers.ts`). Server pairing
  and browser bay only per unit test under multiple clicks.
- **Main process of the desktop app** (`host.ts`, `browser-tabs.ts`, preloads):
  unit tests with Electron fake and real bay runtimes, in the coverage gate
  (`host.ts` 98.7 % / 94.1 %); `index.ts` only in the E2E. Real browser tabs in the E2E:
  load error, blocked redirect and links, popup, crash, 30 s limit
  (`e2e/browser.spec.ts`). The Electron fake only reproduces what the tests
  need; window, tray and dialog behavior of the real platform is only checked by
  the E2E.
- **`e2e/browser.spec.ts` was unstable** (fixed, derived from the code): The
  test read the file with token and MCP address as soon as it existed; but the shell
  creates it before writing. An empty content resulted in
  `fetch(undefined)` (`Failed to parse URL from undefined`). Now the test waits
  for the whole line. The failure was rare; 6 runs afterwards green are no
  proof, just no counter-evidence.
- **Grid E2E was unstable** (fixed): The agent bay measured the character size of the
  terminal only once at start. If that ran before the theme CSS was inserted
  (`dom-ready`), the fallback font applied (≈ 15 instead of 7.8 px per character) and the
  grid counted as full permanently. `Workspace.tsx` now measures again as soon as the
  measuring probe changes (`Workspace.test.tsx`).
- **E2E no longer disturbs** (2026-11-03): Under `HANGAR_E2E` the windows are
  invisible (`show: false`, opacity 0, clicks pass through), without focus and
  without dock icon; `HANGAR_E2E_SHOW=1` shows them. Probe: `isVisible` false,
  `isFocused` false, dock off. Limits: The tray icon still appears;
  native dialogs without a mock would appear (tests that trigger one replace
  it). Review: `docs/reviews/2026-11-03-e2e-hidden-windows.md`.
- **Server without UI** (ADR 0018): `apps/server/src/server.integration.test.ts`
  builds the server and starts it as a Node child process; a job of the test bay runs,
  the result is in `/health` and `jobs.json`, `SIGTERM` ends with exit 0.
  Permissions from rules or from the connected desktop (phase 11b), path check including symlink: `server.test.ts`,
  `options.test.ts`. Started by hand with the bays of the repository: agent bay
  (node-pty) loads under Node, browser bay is listed under `errors`.
- **Local server, step 1** (ADR 0036, on macOS): `e2e/local-server.spec.ts` loads a real LaunchAgent,
  the app pairs without a code, the server keeps answering after the
  app quits, the second start connects without a second entry. Copy per
  version, plist and cleanup: `local-server.test.ts`; `listen.json` and
  port before the bays: `server.test.ts`; `pair-code`: `bridge.test.ts`;
  `pairLocal`: `connections.test.ts`. Measured 2026-11-03: Electron 45 from
  a signed app copied via `ditto` runs as a LaunchAgent in
  Node mode, node-pty starts a shell, no dock entry
  (`lsappinfo`).
- **Local server, step 2** (ADR 0036):
  `e2e/local-server.spec.ts` creates a project in the agent bay of the app,
  starts with the local server (project moved, no own agent bay anymore,
  folder dialog), reads `echo $$` of the session and finds the same PID after
  quitting, after `SIGKILL` of the app and – with the packaged app – after replacing
  the bundle; an MCP call from the shell that keeps running sets the
  description; `ELECTRON_RUN_AS_NODE` is empty in the shell. Green with `out/`
  and with the packaged app. Move: `local-server.test.ts`; host:
  `host.test.ts`.
- **Local server, step 3** (ADR 0036):
  In the same E2E, the agent of the shell that keeps running opens
  `dev.hangar.browser/tab.open` via MCP; the browser bay of the app shows the tab
  "Agent Vom Server". Green with `out/` and on 2026-11-03 against the packaged app (`HANGAR_E2E_EXECUTABLE`, `e2e/local-server.spec.ts` and `e2e/a11y.spec.ts`). Protocol 3 (`offer`, `call`, `reply`, `sessionEnded`):
  `bridge.test.ts`, `client.test.ts`; only to the local server:
  `connections.test.ts`; registering, remembering across a restart and
  "Hangar is not open" via MCP: `server.test.ts`; caller
  `local-server` and subject `local-server:<bay-id>`: `bus.test.ts`; host,
  partition, dialog and move of the permissions: `host.test.ts`, browser bay
  `index.test.ts`, `prompter.test.ts`, `local-server.test.ts`. Without E2E: closing tabs
  at the session end of the server, the message when the app is closed.
  If a session ends without the app, the server reports it at the next offer
  (at most 500, in memory only; a restart of the server in between loses
  them): `bridge.test.ts`. A call in the permission dialog of the app no longer runs after a
  connection loss (`AbortSignal` up to `Bus.call`): `bus.test.ts`,
  `bridge.test.ts`, `host.test.ts`. Review:
  `docs/reviews/2026-11-03-local-server-step-3.md`.
- **Local server, step 4a** (ADR 0036):
  `e2e/local-server.spec.ts` stops the LaunchAgent with `launchctl bootout`;
  the sidebar shows "Agents (Local server is not running)", the page
  "Local server is not running", "Restart" brings the server back
  (`/health` 200) and "Agents" without suffix. Green with `out/` and on 2026-11-03 against the packaged app (`HANGAR_E2E_EXECUTABLE`, `e2e/local-server.spec.ts` and `e2e/a11y.spec.ts`). axe (WCAG 2.2 AA, light and dark) on
  "not running", "starting …" and "New version ready": `e2e/a11y.spec.ts`,
  0 findings; the states there are sent by the main process, not real.
  The hint "New version ready" with a real old runtime copy:
  `e2e/local-server.spec.ts`, fifth test, packaged only (copy under 0.0.1,
  hint, restart, copy gone). Without E2E: tray menu. Sidebar, page, hint:
  `Sidebar.test.tsx`, `App.test.tsx`; state, prompt, tray, log,
  notification without server name: `host.test.ts`; version and restart of the
  plist, a new build of the same version (copy `<version>+<build id>`, hint
  with both builds): `local-server.test.ts`, `host.test.ts`; "starting …" in the hint
  while restarting (`restarting`, also with the old server still connected):
  `host.test.ts`, `App.test.tsx`, axe in `e2e/a11y.spec.ts`; `sessions`: `bridge.test.ts`,
  `client.test.ts`, `server.test.ts`, `connections.test.ts`. At 200 % zoom
  the hint wraps; the shell reports its height (`shell:hintHeight`),
  the bay moves down below it: `App.test.tsx`, `host.test.ts`, `e2e/a11y.spec.ts`.
  Tray and prompt count running shells (`ctx.setRunning`, sum in the
  server): `sessions.test.ts`, `bay-runtime.test.ts`, `server.test.ts`. Review:
  `docs/reviews/2026-11-03-local-server-step-4a.md`.
  The page while it is down or restarting follows `server.log` (last 200 lines,
  `log-tail.ts`: missing file waited for, truncated file read from its start)
  (short reads, cut line starts dropped, endless lines capped at 64 KiB), can be paused
  and follows only while scrolled to its end (`App.test.tsx`), and names the reconnect
  attempt (`ServerView.retry`, counted before the change, gone once it gives up): `log-tail.test.ts`,
  `host.test.ts`, `App.test.tsx`, `connections.test.ts`; the real log and attempt
  after `launchctl bootout` in `e2e/local-server.spec.ts`, axe light/dark and
  200 % zoom of the log in `e2e/a11y.spec.ts`.
- **Local server, step 4b** (ADR 0036): Default in the packaged app
  on macOS, in the build from the repository only with `HANGAR_LOCAL_SERVER=1`
  or the switch; E2E start with `HANGAR_LOCAL_SERVER=0`. The third test
  in `e2e/local-server.spec.ts` runs without the variable: project in the app,
  switch on ("Takes effect after Hangar restarts."), restart (project in the
  server, service loaded), switch off (prompt), restart: project in the
  agent bay of the app, no service (`launchctl print`), no plist, no
  marker, `servers.json` empty. With the variable set, the switch is
  locked (`Settings.test.tsx`). Green with `out/` and on 2026-11-03 against the packaged app (`HANGAR_E2E_EXECUTABLE`, `e2e/local-server.spec.ts` and `e2e/a11y.spec.ts`); "Restart Hangar"
  (`app.relaunch`) without E2E. axe on the switch with hint, light and
  dark: `e2e/a11y.spec.ts`, 0 findings. Way back including winner on
  conflicts, rules of the agents from the server, abort in the middle of the way back
  (marker `returning`, bay where its folder is), failed stopping
  and step 1 service: `local-server.test.ts`; choice and variable: `localServerWanted`;
  `settings.json`: `settings.test.ts`; switch: `Settings.test.tsx`.
  Worktrees on the way back with real Git: `local-server.test.ts`. If
  stopping fails, the bay stays in the server (marker `migrated`), even without data
  there: `local-server.test.ts`. Review: `docs/reviews/2026-11-03-local-server-step-4b.md`.
- **Local server, step 5** (ADR 0036, point 11): Workspaces including
  identity in the server. `e2e/local-server.spec.ts`, fourth test: connect relay in
  the app, restart with `HANGAR_LOCAL_SERVER=1`; "Connected" with the
  same fingerprint, `<userData>/workspaces` gone, key in the server
  `plain:`. Move there and back, retroactively after step 4 with stop,
  unused folder without stop: `local-server.test.ts`; server with relay,
  without readable keys and for the paired desktop: `server.test.ts`; message
  `workspaces`: `bridge.test.ts`, `connections.test.ts`;
  `workspaceAction`: `apps/relay/src/workspaces.test.ts`; forwarding and
  page with stopped server: `host.test.ts`. Two instances over a real relay, one of them in the server: `server.test.ts` "answers an instance …" (Ben calls a shared function of a server bay, the desktop shares it). Without test: shared sessions of the agent bay between app and server. Review: `docs/reviews/2026-11-03-local-server-step-5.md`.
- **Whole E2E suite against the packaged app** (2026-11-03): 53 of 53 green
  (`HANGAR_E2E_EXECUTABLE`, app built with `electron-builder --dir` into a
  temporary folder, without signature). Without E2E remain "Restart Hangar"
  (`app.relaunch`) and the tray menu. Review of the gaps closed
  last: `docs/reviews/2026-11-03-local-server-gaps.md`.
- **Context menu of a session** (2026-11-04): `e2e/session-menu.spec.ts`:
  right-click opens at the pointer, moves up, color Blue sets
  `data-color`, Shift+F10 opens on the focused session, Esc returns
  focus, "Change description…" focuses the field, "Copy path"
  puts the path in the clipboard (`clipboard.readText`), "Schedule job…"
  focuses "Command", at the window edge the menu stays in the window, "Close
  session…" closes after confirmation. axe light and dark with open menu
  0 findings; 200 % zoom: menu in the window, last entry reachable
  (`e2e/a11y.spec.ts`). Unit: `Menu.test.tsx`, `ProjectTree.test.tsx`,
  `App.test.tsx`. Not checked: real context menu key under Windows and
  Linux (only as an event in the unit test). Review:
  `docs/reviews/2026-11-04-session-context-menu.md`.
- **Sort the sidebar** (ADR 0038, 2026-11-04): `e2e/sidebar-order.spec.ts`
  drags a bay, moves one via menu "Move up", drags a shortcut;
  `settings.json` and a restart keep the order; axe light and dark
  0 findings. With local server: board dragged in front of the bays of the app
  (`e2e/local-server.spec.ts`). Unit: `host.test.ts` (order, invalid
  inputs, menus), `Sidebar.test.tsx` (dragging, marking, lists separate).
  Not checked: context menu key by keyboard (native menu, E2E replaces it).
- **Board across workspaces** (ADR 0037 addendum, 2026-11-04):
  `apps/relay/src/board.integration.test.ts`: Anna with a real agent bay and
  real board, Ben in the same workspace over a real relay; after
  sharing, Ben creates, claims and completes in the shared project, an unshared one
  is rejected, without sharing "Access denied". Unit:
  `bays/board/src/main/index.test.ts` (naming the project, foreign instance
  or session, hidden project by ID). Not checked: two real
  Hangar apps over a relay (E2E). Review:
  `docs/reviews/2026-11-04-board-workspaces.md`.
- **Password bay and board bay** (ADR 0021, 0037, 2026-11-04):
  `e2e/secrets-board.spec.ts`: create password (form matrix), reference
  `@secret:` in the project environment, the shell gets the value, in
  `state.json` and `vault.json` there is no plain text; once deleted, the shell does
  not start and says why. Board: person creates, an agent lists, claims,
  creates and completes via MCP; the only permission dialog is `secret.resolve`
  (`uses` without dialog, ADR 0032 addendum). axe light and dark 0 findings;
  multiple clicks: `e2e/chaos.spec.ts`. `bayOnly`: `bus.test.ts`,
  `packages/mcp/src/server.test.ts`, `apps/server/src/server.test.ts`, `manifest.test.ts`. With local server:
  `e2e/local-server.spec.ts` (password from the server shell, agent creates on the board,
  exactly one permission dialog, ADR 0036 addendum); packaged green (see table). Review:
  `docs/reviews/2026-11-04-password-and-board-bay.md`.
- **Server in operation, phase 12** (ADR 0029): `pnpm test:container` builds the
  production image and checks with Docker Desktop (Linux arm64): runs as uid
  1000, `/data` with mode 700, health check `healthy`, agent bay loaded, no
  answer on the container IP; pairing via `docker exec`
  (`docker/server/docker-ssh.mjs`), session prints `before-42 key-smoke-key`
  (API key from `docker run -e`), a job checks the key and ends
  successfully; after `docker restart` the session (scrollback with "Hangar
  restarted", new shell answers) and the result of the job are there again. Without the
  fix in `sessions.ts` (filter only on `CLAUDECODE`) the test fails
  (mutation probe). In CI as job `container` (Ubuntu), not run yet (no
  push). Compose example checked with `docker compose config`, systemd unit with
  `systemd-analyze verify` (Debian bookworm, exit 0); both not as a
  running service. Backup and restore from `docs/server-operations.md`
  played through on throwaway volumes (archive 600, permissions and content back).
  Linux checked only in the container, `network_mode: host` not (macOS).
  Review: `docs/reviews/2026-11-01-server-operations.md`.
- **Remote callers in the bus, phase 13** (ADR 0011): `Caller` `remote`, check
  of `remote: true`, "not sensitive", membership and share list before
  every stored permission and again after the dialog; permissions on the subject
  `remote:<fingerprint>/<bay-id>`. Unit: `bus.test.ts`, `manifest.test.ts`,
  `prompter.test.ts`, `client.test.ts`. Membership and share list come
  from the `RelayClient` since phase 15/16; calls over a real relay are backed by
  `relay.integration.test.ts`, `handover.integration.test.ts` and
  `board.integration.test.ts` (all `apps/relay`). Review:
  `docs/reviews/2026-11-01-phase-13-bus-remote.md`.
- **Cryptography between instances, phase 14** (ADR 0011): `packages/relay` tested with
  two instances in the same process (`relay.test.ts`): end to end in
  both directions, wrong signature, modified ciphertext and modified
  header, non-member, replay also after restart of the receiver, expired
  list and self-renewing revoked members are rejected.
  Mutation probes against eight checks. `fsync` before execution is in the code,
  but not checked with a real power failure. Still without network and without storage of the
  keys. Review: `docs/reviews/2026-11-01-phase-14-relay-crypto.md`.
- **Relay server, phase 15** (ADR 0011): `apps/relay` and `RelayClient`.
  `relay.integration.test.ts`: two buses over a local relay, shared
  function works, an unshared one is neither announced nor callable,
  plain text marker neither in the log nor in `relay.json`. Container smoke test
  (`docker/relay/smoke.check.ts`): without root, `healthy`, TLS with own
  certificate, workspace survives `docker restart`. Checked only on macOS with Docker
  Desktop; the CI job `container` runs it too, but has never
  run (nothing pushed). UI: phase 16. Review:
  `docs/reviews/2026-11-02-phase-15-relay-server.md`.
- **Workspaces UI, phase 16** (ADR 0030): Settings "Workspaces"
  (relay, create, invite, join, admit only by the inviter,
  shares) and shared projects of the agent bay. `e2e/workspaces.spec.ts`: two
  instances over a local relay, joining with fingerprint, shared session
  including description and status change at the other one, end of the share; axe
  light/dark (settings, agent bay), keyboard when creating, 200 % zoom without
  horizontal overflow. Renewing the lists, retries and overlapping
  connections are only backed by `apps/relay/src/workspaces.test.ts`. macOS only;
  Linux without keychain (`plain:`) and CI not checked. Review:
  `docs/reviews/2026-11-02-phase-16-workspaces-ui.md`.
- **Handovers, phase 17** (ADR 0031): `handover.create` opens a new session in its
  own worktree, `handover.get` and `hangar handover` read it. E2E
  `e2e/handover.spec.ts`: handover from a session, display above the terminal,
  `hangar handover` in the new session, axe light/dark, 200 % zoom. Remote:
  `apps/relay/src/handover.integration.test.ts` with a real agent bay over a
  local relay, rejected without share. A remote handover between two
  desktop instances is not checked end to end. Review:
  `docs/reviews/2026-11-02-phase-17-handovers.md`.
- **Manifest permissions, phase 18** (ADR 0032): `uses`, `agentSessions`,
  `dataVersion` in the schema; `ctx.call` only to the own bay and to `uses`,
  `registerAgentSession` only with `agentSessions: true`. Backed by
  `packages/host/src/bay-runtime.test.ts` and `packages/sdk/src/manifest.test.ts`;
  the agent bay runs in the E2E suite with the new manifest. `dataVersion` has
  no effect yet (backup follows with updates). Review:
  `docs/reviews/2026-11-02-phase-18-manifest-permissions.md`.
- **`.bay` packages and index, phase 19** (ADR 0033): `pnpm pack:bay` run with Node
  against the built agent bay, system `tar` reads the package. Rejected
  in `packages/host/src/bay-package.test.ts` and `bay-index.test.ts`: wrong
  signature, wrong checksum, `../`, absolute and Windows paths, links, devices,
  duplicate paths, negative sizes, too deep paths and too many entries,
  damaged or truncated archive; when packing, paths outside the bay,
  links on the way and unsafe ID or version; expired and
  rolled-back index. Still without installation (phase 20). Review:
  `docs/reviews/2026-11-02-phase-19-bay-packages.md`.
- **Installation, update, rollback, phase 20** (ADR 0034): E2E
  `e2e/bay-install.spec.ts` with a local, signed index: installation by
  keyboard, in the sidebar after restart, update with permission diff in the dialog,
  rollback, axe light/dark in the settings, 200 % zoom without horizontal
  overflow. Data backup on a new `dataVersion`, restoring on
  rollback and resetting newly sensitive permissions are only backed by
  `packages/host/src/bay-store.test.ts`. No built-in key,
  no published index (phase 21: the GitHub remote exists since 2026-11-04, but
  the repository is private; where index and packages are published publicly
  is undecided). Review:
  `docs/reviews/2026-11-02-phase-20-installation.md`.
- **Bridge desktop ↔ server, part 10a** (ADR 0019): Pairing with code,
  token, fingerprint, protocol version and error paths backed by
  `apps/server/src/bridge.test.ts` (real server, client from `@hangar/bridge`).
  Unchecked: the branch "signature invalid" (would need a forged server).
- **Bridge, part 10b** (ADR 0019): `apps/desktop/e2e/server.spec.ts` starts
  `hangar-server` as a child process, pairs via the dialog (Enter), creates project
  and session on the server, types in the terminal (output and worktree in the
  data folder of the server), disconnects and connects via the menu and after
  a restart of the desktop app finds server, bay and terminal again; axe light/dark
  for pairing and sidebar without findings. `ServerConnections`:
  `apps/server/src/connections.test.ts`.
- **Path form, part 11a**: On a server, the agent bay asks for a path instead of the
  folder dialog (`window.hangar.server`). `e2e/server.spec.ts`
  against the real server, one wrong value each: empty → "Enter a path", outside
  `--root` → "Folder outside the allowed roots (--root): …", not a
  repository → "Not a Git repository: …", by Enter a missing folder →
  "Folder not found: …"; field keeps the value and is `aria-invalid`; last
  the valid path. axe light/dark with error message without findings. In addition
  `bays/agents/src/ui/App.test.tsx` (focus, Escape, Cancel, Enter). Open: The
  messages of the server come in its language, not in that of the desktop.
- **Permission dialog over the bridge, part 11b** (ADR 0019): `e2e/server.spec.ts` –
  an agent in the session on the server calls the sensitive function of the
  vault bay via `curl`; the dialog on the desktop reads "On the server "Testserver":
  An agent in a session of "dev.hangar.agents" wants to call
  "dev.hangar.vault/secret.read".", "Deny" → in the terminal `denied`,
  in `permissions.json` of the server `deny`. Without desktop, after time limit or
  disconnect the bus stores nothing (`server.test.ts`, `bridge.test.ts`); only the
  desktop that was asked answers, only with a matching choice; a server that floods
  questions gets at most 10 open ones (`client.test.ts`).
- **Notifications, badges and jobs of the server, part 11c/11d** (ADR 0019):
  `e2e/server.spec.ts` – a job (`hangar status waiting`) runs on the server
  while the desktop is disconnected; after connecting, the notification
  "Session is waiting for input" (bay `remote:…:dev.hangar.agents`) is there, badge 1 on the
  server bay and on the app icon, and in the settings under "On the server
  "Testserver"" the job with "succeeded". Pausing, "Run now" and
  deleting take effect in `jobs.json` of the server; after disconnecting the
  group disappears. axe light/dark, Tab through the actions and 200 % zoom without horizontal
  overflow. Collecting without desktop (at most 50), limits against a flooding
  server, time limit and check of the job list: `bridge.test.ts`,
  `connections.test.ts`, `server.test.ts`, `Jobs.test.tsx`.
- **Language and server name** (ADR 0019): The desktop sends its language with
  `auth` and `pair`; the server adopts the one named last, remembers it in
  `<data>/desktop-locale` and tells the bays (`ctx.onLocaleChange`), unless
  `HANGAR_LOCALE` fixes it. Backed by `connections.test.ts` "tells the
  server its language …" (also across a restart, unknown language changes
  nothing), `options.test.ts` "speaks the language of the desktop",
  `bay-runtime.test.ts` and `bays/agents` `index.test.ts`. E2E `server.spec.ts`:
  error in the path form in German, notification "Testserver: Session
  is waiting for input".
- **Tab colors and copy on select** (agent bay): Eight colors per
  session via "Color" in the header of the field, stored in `state.json`
  (`SessionRecord.color`). Backed by `sessions.test.ts` "sets and clears the tab
  color; rejects unknown colors" and "restarts shells … with env, description and
  scrollback" (color after restart), `SessionPane.test.tsx`,
  `ProjectTree.test.tsx`, contrast in `packages/theme/src/index.test.ts`
  (every color at least 4.5:1 against background and both surfaces, light and
  dark; smallest value 5.05:1). E2E `tab-color.spec.ts`: color chosen by tab and
  keyboard, back after restart; `a11y.spec.ts` with colored tab,
  axe light and dark 0 findings. Selected terminal text goes to the clipboard on release of the
  left mouse button: `terminals.test.ts`, E2E
  `terminal-copy.spec.ts` (double click, `clipboard.readText()`). Review:
  `docs/reviews/2026-10-30-tab-colors.md`.
- **Fixed tree header and counts** (2026-11-07): "Add project" stays at the
  top and the session counts at the bottom while the projects scroll; Tab and
  Shift+Tab scroll the focus clear of both (`scroll-padding-block`, WCAG
  2.4.11). E2E `project-order.spec.ts` (window 1000 × 420, six projects,
  axe light and dark 0 findings).
- **Sort sessions** (2026-11-04): `moveSession` (only in the own project,
  places of other projects stay, check of the index) in `sessions.test.ts`,
  channel `session.move` in `index.test.ts`; dragging only within the project,
  marking, aborted dragging and project dragging separately in
  `ProjectTree.test.tsx`; "↑"/"↓" in `ProjectPane.test.tsx`. E2E
  `project-order.spec.ts`: dragging, button of the overview, restart, axe light and
  dark 0 findings (3 of 3 repetitions).
- **Sort and collapse projects, first click** (2026-11-02):
  `moveProject` with check of the index in `sessions.test.ts`, channel
  `project.move` in `index.test.ts`; dragging, aborted dragging, collapsing,
  light "waiting" on the collapsed project and broken stored value in
  `ProjectTree.test.tsx`; "Move project up/down" in `ProjectPane.test.tsx`
  and `App.test.tsx`. E2E `project-order.spec.ts`: native dragging, buttons of the
  overview, collapsing, both back after restart, axe light and dark
  0 findings. `acceptFirstMouse` is only backed in `host.test.ts`; effect
  in an inactive macOS window cannot be checked automatically. Review:
  `docs/reviews/2026-11-02-sort-projects.md`.
- **Settings of bays, "Select copies", session in the project folder,
  grid 60 × 16** (ADR 0023, 0022, 0010): Manifest `settings`, `ctx.settings`,
  store `baySettings` backed by `manifest.test.ts`, `settings.test.ts`,
  `bay-runtime.test.ts`; settings of the bays in `Settings.test.tsx`. Switch per
  session and default for new sessions: `sessions.test.ts`, `index.test.ts`,
  `terminals.test.ts`, `SessionPane.test.tsx`; session in the project folder:
  `sessions.test.ts`, `ProjectTree.test.tsx`, `ProjectPane.test.tsx`. E2E
  `terminal-copy.spec.ts`: switch off by space bar, double click does not copy;
  default in the settings off, new session in the project folder adopts it,
  `pwd -P` shows the project. `grid.spec.ts`: two fields side by side at
  1728 × 1080, the third after zoom 0.5; a field at minimum size holds according to
  `stty size` 60 × 16. `a11y.spec.ts` axe light and dark 0 findings. Review:
  `docs/reviews/2026-10-30-bay-settings.md`.
- **Bridge, part 10c** (ADR 0019): `ssh` arguments, address check (also against
  options like `-oProxyCommand=…` as host) and tunnel setup backed by
  `packages/bridge/src/tunnel.test.ts`; pairing and restart over the tunnel with
  `apps/server/src/connections.test.ts`. A fake `ssh`
  (`packages/bridge/fixtures/fake-ssh.mjs`) really forwards the port;
  `e2e/server.spec.ts` pairs through it only with the keyboard (focus visible,
  server menu by Enter) and checks sidebar and pairing dialog at 200 % zoom
  (everything reachable, no horizontal overflow). Real SSH run on
  2026-10-30 by hand: OpenSSH 10.3p1 (macOS) against a Docker container
  (Debian, OpenSSH server, Node 24, Linux arm64) with `hangar-server --listen
127.0.0.1:7420` and an echo bay, via `ServerConnections` with own
  ssh config (key, host key via `ssh-keyscan`). Result: fingerprint
  equal to the server log, pairing with code, `invoke` → "hello from
  linux/arm64", after restart of `ServerConnections` and after disconnecting connected
  again, one `ssh` process during the connection and none after;
  wrong user → `SSH failed: nobody@127.0.0.1: Permission denied
(publickey).`, wrong port → `Cannot reach …`. Since ADR 0020 repeatable with
  `pnpm test:ssh` (dev server in Docker, 2026-10-30 3 of 3 green: session of the
  agent bay in the container prints `Linux aarch64`; a process killed hard
  with an open tunnel leaves no `ssh` behind, the local port closes). In
  CI as its own job on Ubuntu (`.github/workflows/ci.yml`, job `ssh`), not run there
  yet (no push). Reconnecting after a drop with 1, 2, 4 …
  at most 30 s pause: `apps/server/src/connections.test.ts` (server gone and
  back; no attempts after disconnecting, removing, wrong key or
  token).
  The desktop app itself with real `ssh` against the dev server: one-off
  Playwright run, pairing via the dialog, terminal shows `uname -sm` →
  `Linux aarch64` in the worktree of the container (not kept as a permanent test).
  Not over a real network (latency, drops).
- **Electron pinned to 45.1.0**: electron-builder needs an exact version.
- **Warning on the first `pnpm install`**: pnpm can only link the `hangar` bin of
  `@hangar/cli` after the build. This is harmless, the app uses
  its own shim.

## Code review (Codex, gpt-6.1-sol)

Review of phases 7 to 10 (2026-10-30, `ec53529..5dfa040`): 11 findings, all
confirmed and fixed with a previously red test, plus two findings from the dev server;
table in [reviews/2026-10-30-phases-7-to-10.md](reviews/2026-10-30-phases-7-to-10.md).

Review of quota bar, sessions in the project folder and field header
(2026-10-30): 4 findings, all confirmed and fixed with a previously red test;
[reviews/2026-10-30-quotas.md](reviews/2026-10-30-quotas.md).

Review of 100 ports per session, terminal replay, mouse modes and the black-orange
UI (2026-10-31, `68a771f`, `96e65a1`, `9502fcd`): 2 findings, both
confirmed and fixed with a previously red test;
[reviews/2026-10-31-ports-terminal-theme.md](reviews/2026-10-31-ports-terminal-theme.md).

Review of the collapsible project bar (2026-10-31): 1 bug and 2 test gaps,
all confirmed and fixed;
[reviews/2026-10-31-project-bar.md](reviews/2026-10-31-project-bar.md).

Review of the shortcuts in the sidebar (2026-11-01, ADR 0027): 3 findings, all
confirmed; 2 fixed with a previously red test, Linux limit (`xdg-open` does not start
executable files) recorded in ADR 0027;
[reviews/2026-11-01-shortcuts.md](reviews/2026-11-01-shortcuts.md).

Review of the tests for completeness, edge cases and multiple clicks (2026-11-01,
ADR 0028): 2 high and 9 medium multiple-click findings, all fixed with a red test;
Codex review of the implementation: 6 findings, all fixed (`removeBay`
during start in the second addendum). The open test gaps are closed;
Codex review of the second addendum: 4 findings, all fixed;
[reviews/2026-11-01-tests-chaos.md](reviews/2026-11-01-tests-chaos.md).

A review of the code produced 17 findings; all were confirmed in the code and fixed with a
test (commits `9b42e82`, `90384dd`, `15963fc`, `60280b3`, `58732e0`,
details in the CHANGELOG under "Fixed"). Not checked by running: the new
`publish` job in `release.yml` (never run) and the Windows behavior of
`hangar.cmd` and PATH (only backed by unit tests).

## Decisions

ADR 0001–0039 under [adr/](adr/), all accepted and implemented: Electron,
monorepo, bus and MCP, bay runtime, sessions and worktrees, permissions,
MCP transport, CLI and hooks, texts and languages, grid and bay windows, relay
(0011, phases 13–17), registry (0012, phases 18–20), scheduler, jobs as own
process, browser bay, functions open to agents, bays in the sidebar, server
without UI, bridge desktop ↔ server, dev server in Docker, password bay,
sessions in the project folder, settings of bays, quota bar, prompt of the
session shell, black-orange UI, shortcuts, multiple clicks, server
in operation, workspaces in the UI, handovers, manifest permissions,
`.bay` packages, installing and rolling back, status "waiting on background",
agent bay in the local server, board bay, sort the sidebar, documentation in
English. Open from 0012: the
index on GitHub Releases (phase 21). Concepts:
[concept-relay.md](concept-relay.md), [concept-registry.md](concept-registry.md),
[concept-server.md](concept-server.md); Codex review of the concepts in
[reviews/](reviews/2026-10-28-relay-registry.md).
