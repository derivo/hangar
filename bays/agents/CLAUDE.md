# bays/agents – Agent bay (`dev.hangar.agents`)

Projects (Git repositories), sessions (shell in the project folder, ADR 0022; handovers in their own worktree, ADR 0031), status,
description, environment variables, status bar, scheduled commands ("Schedule job").

## Structure

- `manifest.json` – id, functions (visible over bus and MCP).
- `src/main/` – runs in the main process (coverage gate 90 %).
  - `index.ts` – `activate(ctx)`: wires UI channels and bus functions.
  - `sessions.ts` – `SessionManager`: projects, sessions, shells, scrollback, status.
  - `git.ts` – worktrees (only `execFile`, never shell strings).
  - `pty.ts` – node-pty wrapper and default shell; `status.ts` – heuristic; `ports.ts` – port blocks.
  - `store.ts` – write `state.json` atomically.
  - `jobs.ts` – `SessionJobs`: jobs of the bay (ADR 0013, 0014); a job starts the command as its own process in the worktree with the environment of the session (`SessionManager.runCommand` → `job-process.ts`) and reports exit code and last line. If the session closes, running jobs are ended and their jobs deleted (`sessionClosed`).
  - `job-process.ts` – `shellCommand` (call per shell: POSIX `-c`, `cmd.exe /d /s /c`, PowerShell `-Command`), `startJobProcess` (empty input, time limit, process group under POSIX, `taskkill /T /F` under Windows; 2 s after a kill Hangar closes the output pipes itself, so a child the kill missed cannot keep the run open).
  - `agent-config.ts` – `.mcp.json`, Claude Code hooks and `statusLine: "hangar statusline"` in the worktree or project folder (ADR 0008, 0024); an own `statusLine` in `settings.local.json` is kept.
  - `quota.ts` – `readCodexQuota` (last line with `rate_limits.primary`, 300 min, with `secondary` at 10080 min as `week`, in the newest log of the two newest day folders under `$CODEX_HOME/sessions/Y/M/D/` that has one – newer logs without it, e.g. of `codex exec`, are skipped; only the last 1 MB per log), `QuotaTracker` (per provider in memory, event `quota` on change). Codex is read at start and every minute, Claude reports via `quota.report` (ADR 0024).
  - `messages.ts` – texts for humans (errors in the UI, notifications), de/en; errors of the bus functions in `functions.ts` stay English (ADR 0009).
  - `test-*.ts` – test helpers (temporary repo, fake PTY, fake context).
- `src/ui/` – React + xterm.js. Texts in `messages.ts` (de/en). `terminals.ts` keeps one terminal per session alive;
  `Statusbar.tsx` shows the segments (`bar` as a scale with `role="meter"`).
- `PathForm.tsx` – project by path when the bay runs on a server (`window.hangar.server` set): there is no folder dialog; `project.add` gets the path, the server checks it against `--root`. An empty path is rejected in the UI, otherwise the server's message appears at the field.
- `ProjectPane.tsx` – project overview: sessions with the Git state of the worktree, orphaned `hangar/*` branches, environment variables for new sessions (`Project.env`, mixed in below the session values on creation).
- `Workspace.tsx` + `grid.ts` – grid of fields (ADR 0010): minimum size 60 × 16 characters (`MIN_COLUMNS`, `MIN_ROWS`, margin `CHROME`; the field header wraps to three lines at minimum width, `e2e/grid.spec.ts` checks new elements in the header), arrangement by available space, "Add field" disabled (`aria-disabled`, reason as description and `title`) when no more field fits. "Undock" opens the session via `window.hangar.windows` in its own window; there `App.tsx` renders only this session.
- Tab color: a session (entry in the project tree and field in the grid) can carry one of eight colors (`TAB_COLORS` in `types.ts`, `SessionRecord.color`, set via `session.update` with `color`, `null` removes it). It is stored in `state.json`, not in `localStorage`. Selection: native `<select>` "Color" in the header of the field; shown as a stripe (`--tab-color`, `inset` shadow instead of a border, so that `CHROME` does not change). The values are tokens `--hangar-color-tab-*` in `@hangar/theme`; its test checks at least 4.5:1 against the background and both surfaces, light and dark.
- Terminal links (OSC 8): `linkHandler` in `main.tsx` asks with the real target (`t.openLink`; the text of an OSC-8 link can claim anything) and then calls `window.open(uri)`, the host opens http/https in the browser (`setWindowOpenHandler`); xterm's default (empty window, address afterwards) opened nothing (`e2e/terminal-links.spec.ts`).
- Terminal: selected text goes to the clipboard when the mouse is released (`TerminalRegistry.attach`, `mousedown` in capture before xterm, `mouseup` at the window, also if released outside the terminal) as long as the session has `copyOnSelect` (if it is missing, on applies). Toggle: checkbox "Selecting copies" in the header of the field → `session.update` with `copyOnSelect` → `TerminalRegistry.setCopyOnSelect`. New sessions take the bay setting `copyOnSelect` (manifest `settings`, ADR 0023; `ctx.settings.get` via `ManagerDeps.copyOnSelect`).
- Prompt (ADR 0025): `zsh-prompt.ts` – if the shell is a zsh and the bay setting `prompt` is not empty (`ManagerDeps.prompt`), `environment()` sets `ZDOTDIR=<dataDir>/zsh`, `HANGAR_PROMPT` and `HANGAR_ZDOTDIR` (old `ZDOTDIR`). The startup files there load the person's (with their `ZDOTDIR`, set or not) and afterwards set `PROMPT` with `vcs_info` (after `.zshrc`, in login shells once more after `.zlogin`); then `ZDOTDIR` is restored (jobs: after `.zshenv`), `HISTFILE` stays in the person's folder. Empty or another shell: nothing. Applies from the next shell start.
- Sessions in the project folder (ADR 0022): `session.create` from the UI always creates with `place: 'project'`; `worktreePath` is the project folder, `branch` empty. No worktree on creation, none removed on closing. Old worktree sessions keep running. The UI shows "Project folder" under "Branch" (`branchOf`); without a description a session is named after its short id (`sessionName`, in the main part `labelSessions` likewise).
- `QuotaBar.tsx` – footer "Usage limits" across the whole width (not in the own window): per provider with a value name, "5h", scale (`role="meter"`, share free), "94% left", "resets 20:40"; a past reset counts as 100 % free (recalculated every minute).
- Field header: row 1 description and top right icon buttons "↗" Undock (in the own window "↙" Dock, `windowAction`) and "×" close session (accessible names via `aria-label`), row 2 environment variables, schedule job, close field (`fieldActions`), row 3 telemetry.
- Grid (fields, focus), project overview, collapsed project bar and collapsed projects are in the `localStorage` of the bay (partition `persist:bay:<id>`, keys `grid`, `selectedProject`, `treeCollapsed`, `collapsedProjects`) and are back after a restart.
- Project bar collapsed (`ProjectTree`, `data-collapsed`): width `--hangar-sidebar-width`, one button per session with a status light (`aria-label` "Name (short id) – project, status", `title` without status; the short id only with a description, otherwise the name is already unique); `.layout` therefore has `auto` as its first column. The grid re-measures itself via `ResizeObserver` (`e2e/tree-collapse.spec.ts`).
- Handovers (ADR 0031): `handover.create`/`handover.get` in `functions.ts`, `SessionManager.handover(projectId, handover, startPoint?)` opens a new session in its own worktree (locally from `startPoint`, removes at most five open), `SessionRecord.handover`. Never input into a running shell. Shown above the terminal in `SessionPane.tsx`. A project name that two projects carry is rejected (`Project name is ambiguous`), unless a session names that of its own project. Relay test: `apps/relay/src/handover.integration.test.ts`.
- Order of the projects: `moveProject(id, index)` (channel `project.move`) puts the project at `index` and stores in `state.json`. In the tree the row `.tree-project` is draggable (native HTML drag and drop, the dragged project in a ref, an aborted drag moves nothing); without dragging "Move project up/down" in `ProjectPane.tsx`. Sessions likewise within their project: `moveSession(id, index)` (channel `session.move`, `index` counts within the project; the sessions of other projects keep their places in `state.sessions`), in the tree the entry of the session is draggable (only onto sessions of the same project), without dragging "↑"/"↓" per session in `ProjectPane.tsx`. Collapsing only for projects with sessions; when collapsed, a "waiting for input" light stays on the project (`e2e/project-order.spec.ts`).
- Context menu of a session: `Menu.tsx` (WAI-ARIA `menu`, entries, separators, color row as `menuitemradio`; `position: fixed`, kept within the window) opens in `ProjectTree.tsx` by right click, Shift+F10 or the context menu key (macOS turns no key into a `contextmenu`). Moving is done by the tree (`onMoveSession`), everything else by `App.tsx` via `onSessionAction`; description, environment variables and job go as a `PaneRequest` to the `SessionPane`, which opens the form, focuses it and reports with `onRequestDone` that the request does not come back. For undocked sessions these three entries are disabled (the own window has the forms). "Copy path" reports itself as `role="status"` (`.notice`, 3 s). Esc returns the focus to the session, Tab and Shift+Tab continue from there (`e2e/session-menu.spec.ts`).
- Workspaces (ADR 0030, host module `workspaces`): `share.ts` – `sharedState` (only projects with `shared: true`; name, branch, description, status), `remoteProjects` (check states of other instances, shorten texts to 200 characters). The manager publishes only when the state changes (`ManagerDeps.share`). UI: checkbox "Share in workspaces" in `ProjectPane.tsx`, `RemoteList.tsx` ("Other instances", read-only) in the project tree.
- When a session switches to `waiting`, the manager reports a notification;
  the badge of the bay is the number of waiting sessions. It reports the number of
  running shells on every change with `ctx.setRunning` (tray of the local server).
- Passwords (ADR 0021): a value in `Project.env`/`SessionRecord.env` is a text or `{ secret: NAME }` (`EnvValue`, `isSecretRef`); the UI writes `KEY=@secret:NAME` (`env-text.ts`, no escape) and shows the passwords below the field (`SecretsHint`, `aria-describedby`). On shell start `ManagerDeps.resolveSecrets` (`dev.hangar.secrets/secret.resolve`) resolves the references; only the answer of the last start counts (`Live.start`). If it fails, the terminal writes `Shell not started: <reason>` and the bay reports `session.exit` with -1. Values are never in `state.json`.
- For bays (`bayOnly`): `session.info` (`{ projectId, project, name }`) and `project.list` (`[{ id, name, shared }]`), used by the board (ADR 0037).

## UI channels (`window.hangar.invoke`)

`state`, `project.add`, `project.remove`, `project.details`, `project.deleteBranch`,
`project.setEnv`, `project.setShared`, `session.create`, `session.close`,
`session.restart`, `session.update`, `session.input`, `session.resize`,
`session.buffer` (for UIs of older desktops), `session.snapshot`, `job.add`, `quota`, `remote`, `secrets` (passwords of the password bay, `null` without it). Events: `state`, `session.data`, `session.exit`, `quota`, `remote`.

`session.data` carries `end`, the number of characters the session has sent so
far; `session.snapshot` returns the scrollback with the `end` of its last
output. Over the bridge an event can overtake the answer to the snapshot
(`packages/bridge/src/client.ts`: a result only resolves a promise, an event is
forwarded at once), so `TerminalRegistry` keeps output that arrives before the
snapshot and writes what is newer than its `end`. A server of an older version
has no `session.snapshot`; `api.snapshot` then falls back to `session.buffer`
and early output is dropped as before.

## Pitfalls

- `Workspace.tsx` measures the character size via `.cell-probe` and observes the probe with `ResizeObserver`: the theme CSS arrives only at `dom-ready`, the font after that; measuring once would otherwise have locked in the fallback font.
- If the header of a field (`SessionPane`) changes, `CHROME` in `Workspace.tsx` must match: `e2e/grid.spec.ts` checks with `stty size` that a field of minimum size holds 60 × 16 characters.
- `closeSession` takes the session out of the state before it removes the worktree; this way nobody can restart it in the meantime.
- Only the main view stores grid and project selection; a session window shares the `localStorage` but does not write it.
- A session is in only one place; `TerminalRegistry.attach` hides only terminals in the same field.
- `writeAgentConfig` refuses symbolic links in `.mcp.json`/`.claude` (otherwise writing outside the worktree).
- If Hangar itself runs in a Claude Code session (`CLAUDECODE` set), session shells do not inherit `CLAUDECODE`, `CLAUDE_*`, `ANTHROPIC_*` and `MCP_*` from Hangar's environment; session environment and shell profile still set them. Otherwise they inherit everything, so that API keys of a server service reach the agents (ADR 0029).
- `deleteBranch` deletes only orphaned `hangar/*` branches (`git branch -D`, also unmerged); every other name is rejected. The UI asks beforehand and names lost commits.
- `runCommand` needs a shell that has been started once (`Live.env`: environment including token); a restart of the shell gives running jobs no new token. Time limit 60 minutes (`ManagerDeps.jobTimeoutMs` for tests). `job.add` from the UI returns German/English errors, `job.add` via MCP the English ones of the scheduler.
- Session shell: login shell (`-l`) on macOS, no login on Linux (`defaultShell`): Debian's `/etc/profile` resets `PATH` and would lose the CLI folder.
- `shutdown` blocks new sessions; a creation that is just waiting for Git or the port aborts before the shell start (`t.shuttingDown`).
- Tests with Git only via `createTempRepo()` – never against real repositories.
- node-pty stays external when bundling (`vite.main.config.ts`), the host supplies it.
- Do not intercept key shortcuts: all input goes unchanged to the shell
  (voice input of Claude Code = hold the space bar).
- Decisions: ADR 0004 (runtime), ADR 0005 (sessions/worktrees/status), ADR 0010 (grid, own windows), ADR 0013 (jobs), ADR 0022 (project folder), ADR 0024 (quotas), ADR 0025 (prompt).
