# @hangar/host

Core of Hangar without Electron (Phase 8): the desktop app and later the server
(Phase 9) use the same code. A lint rule forbids Electron imports
(`no-restricted-imports` in `eslint.config.mjs`).

## Interfaces

- `discoverBays(roots, hangarVersion)` (`bay-loader.ts`) – finds and validates bays.
- `BayRuntime` (`bay-runtime.ts`) – creates the `BayContext` per bay; `ctx.browser`
  only with `hostModules: ["browser"]` (`hasHostModule`), `ctx.secrets` only with `secrets` and
  `HostServices.secrets` (ADR 0021); `ctx.call` only to the own bay
  and to `uses`, `registerAgentSession` only with `agentSessions: true` (ADR 0032). `HostServices` is the
  interface to the host; `baySettings(bayId)` returns the stored values,
  `baySetting` (`settings.ts`) falls back to `default`, also for a wrong type (ADR 0025), `settingChanged(key)`
  reports a change to `ctx.settings.onChange`.
- `startCore({ dataDir, version, prompter, cli, onJobsChanged })` (`core.ts`) –
  bus with `<dataDir>/permissions.json`, `TokenRegistry`, MCP server, scheduler with
  `<dataDir>/jobs.json`, CLI shim in `<dataDir>/bin`. Returns `services`
  (`CoreServices`: the part of `HostServices` without windows, dialogs, tray) and
  `close()` (stops scheduler and MCP server).
- `readSettings`, `writeSettings`, `themeSetting`, `uiLocale` (`settings.ts`) –
  `settings.json` with the types `AppSettings`, `UpdateChannel`, `LanguageSetting`,
  `ThemeSetting`; `localServer` (ADR 0036) only if chosen.
- `shortcuts.ts` – shortcuts of the sidebar (ADR 0027): `shortcutUrl` (only http/https with a host, otherwise `Invalid URL`), `shortcutName`, `addShortcut` (without duplicates), `validShortcuts` (absolute path or http/https).
- `Workspaces` (`workspaces.ts`, ADR 0030) – one relay connection per Hangar:
  `workspaces.json`, `relay-identity.json` (key via `protect`, mode 600),
  connect (only `wss://`, `ws://` only loopback; retry after `retryMs`), create,
  invite, join, admit (only the inviter)/reject/remove, share list,
  renewing the lists after `renewMs` (1 day), `forBay(bayId)` → `ctx.workspaces`.
  Only the newest connection attempt counts; every failed one schedules the next. Is the `RemoteAccess` of the bus (`startCore({ remote })`).
  `workspaceAction(ws, bus, action, args)`: the actions of "Settings → Workspaces"
  by name (`view` with the shareable functions), for the app's IPC and the bridge of the
  local server (ADR 0036, item 11).
- `.bay` packages (ADR 0033): `packBay` (only ids `dev.hangar.<…>`), `verifyPackage`, `unpackBay`, `writeTar`
  (`bay-package.ts`, only `node:` imports, because `scripts/pack-bay.ts` loads the file
  directly with Node); `signIndex`, `verifyIndex` (`bay-index.ts`).
- `BayStore` (`bay-store.ts`, ADR 0034): `catalog(channel)`, `prepare(id, version)` →
  permission diff (`rightsDiff`), `confirm`/`cancel`, `rollback`, `applyPending(resetGrant)`
  at start before loading, `bayDirs()` for `discoverBays` (`BaySource` `{ bay }`:
  an installed bay replaces a later one with the same id without an error).
- `writeCliShim(dir, execPath, cliPath)` (`cli-shim.ts`) – `hangar` launcher for the
  `PATH` of the sessions.

## Pitfalls

- `startCore` does not start the scheduler: the host starts it only when the bays
  have registered their job handlers (`core.scheduler.start()` after `host.start()`).
- The prompter comes from the caller: desktop `dialogPrompter`, the server asks via the
  bridge the paired desktop that connected most recently (`bridge.ask`, ADR 0019); without a desktop
  only stored rules (ADR 0018).
- Desktop-specific stays in `apps/desktop`: `view-state.ts`, `updates.ts`
  (`updaterOptions`), prompter dialog, browser tabs.
