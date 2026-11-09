# apps/server

Hangar without a user interface (ADR 0018): one Node process with the core from
`@hangar/host`. Loads bays, starts the MCP server and scheduler and answers
`GET /health`. No Electron (lint rule `no-restricted-imports`).

## Structure

- `src/main.ts` – entry point: arguments, start, `SIGTERM`/`SIGINT` → `close()`.
- `src/options.ts` – `parseOptions(argv)` (`--data`, `--listen` loopback only,
  `--root`, `--bays`, `--cli`; `--data` becomes absolute) and `checkedFolder(path, roots, locale)` (replaces the
  folder dialog; the root of the repository must also lie under `--root`).
- `src/server.ts` – `startServer(options)`: `HostServices` without a UI,
  prompter, notifications, badges and job changes via the bridge, load bays,
  `/health`. Listens before the bays start (ADR 0036); with port 0 first
  the one from `<data>/listen.json`, if it is taken, a free one. Afterwards port and
  fingerprint are in `listen.json` (0600, `writePrivate`). Until all bays have
  started, the bridge answers `/connect` with 503 (`ready`), otherwise an early
  desktop would see an empty bay list. Deletes `ELECTRON_RUN_AS_NODE` from its own
  environment (set by the LaunchAgent, ADR 0036); shells and jobs would inherit it otherwise.
- `src/messages.ts` – texts of the server for humans (German, English).
- Language: that of the desktop that connected most recently with `locale`,
  remembered in `<data>/desktop-locale`; `HANGAR_LOCALE` sets it. A change goes
  via `BayRuntime.localeChanged` to the bays (`ctx.onLocaleChange`).
- `src/bridge.ts` – `attachBridge`: WebSocket `/connect` for desktops (ADR 0019),
  key in `<data>/identity.json`, paired desktops in `<data>/clients.json`
  (token hash only), pairing code in the log and in `<data>/pair-code` (0600, for the desktop on the same machine). Every message is checked before processing
  for type and fields (`parse`). `ask(request)` asks the paired
  desktop that connected most recently (timeout `askTimeoutMs`, 5 minutes); `answer` counts only
  from the asked socket and only with a choice that fits the question (`valid`).
  The desktop shows one question at a time per connection, at most 10 open. Without a desktop, answer or connection `ask` throws, so that the bus stores
  nothing – never return `deny`. `notify`/`badge` (11c): to all open
  paired sockets; without one the last 50 notifications in memory,
  after `auth`/`pair` to the next desktop together with all badges. `jobs`/`job`
  (11d, paired only) and `jobsChanged()` for the job list of the desktop.
  `offer` (ADR 0036, paired only): functions of the bays of the app; fields
  are taken individually (without `remote`), at most 500. `call(target,
args, caller)` goes to the desktop that offered most recently, and fails
  without one or if it leaves before answering (`desktopClosed`, "Hangar is
  not open"); `sessionEnded` reports to it the end of an agent session, remembered
  without it (at most 500) until the next `offer`. `sessions(count)`:
  number of running shells (tray of the app), to all desktops and after
  `auth`/`pair`; `server.ts` sums `ctx.setRunning` of the bays
  (`runningChanged`).
- `server.ts` registers what is offered with `Bus.registerTransport` and
  `authorizes: true` (only the app asks, ADR 0036 addendum; bays of the
  server keep their functions; a new offer replaces the old one) and
  remembers it in `<data>/desktop-functions.json` (0600): the tools are in the list
  from the start, even with the app closed.
- `test-setup.ts`: `startBridge(askTimeoutMs?, bays?)` – only the bridge on an
  HTTP server, for tests of `ask`, `notify` and `badge`. The echo bay of
  `startEchoServer` reports `started` and badge 1 on start.
- `fixtures/job-bay` – test bay that answers its jobs with `done <n>`.
- `vite build` bundles everything into `dist/hangar-server.mjs`; bays and node-pty
  are loaded at runtime.

## Start

```
pnpm --filter @hangar/server build
node apps/server/dist/hangar-server.mjs --data ~/hangar-data --root ~/repos
```

## Pitfalls

- Operation (ADR 0029): production image `docker/server/` (`pnpm image:server`), Compose and systemd example, guide `docs/server-operations.md`. `pnpm test:container` checks the image; `docker/server/docker-ssh.mjs` replaces `ssh` with `docker exec`, because the server in the container listens only on its loopback.
- Dev server with real SSH in Docker: `pnpm dev:server`, check `pnpm test:ssh` (`docker/dev-server/`, ADR 0020). The container mounts `dist/` of server, CLI and agent bay; `pnpm dev:server` rebuilds and recreates it (volumes stay).
- Bays with `hostModules: ["browser"]` or `["secrets"]` are not loaded by the server (error in `/health`);
  `workspaces` is always available (ADR 0036, item 11): `Workspaces` in
  `<data>/workspaces`, keys without a keychain (`plain:`, mode 600);
  `safe:` keys (still in the keychain of the app) → log `workspaces not
available: …`, the bay runs without `ctx.workspaces`. A paired desktop
  controls them with the message `workspaces` (`workspaceAction`); every change
  reports `bridge.workspacesChanged()`.
- `/health` and the log show no job output (may be terminal content); it
  is in `jobs.json`.
- The server loads all bays it finds, not the sidebar from `settings.json`.
  It does read the settings of the bays (`baySettings`, ADR 0023) there, though; the
  desktop app does not show or change them.
- A bay is in the list only after `activate`; a session end during
  `activate` does not reach it (as on the desktop).
- `server.integration.test.ts` builds the server with Vite into a temporary folder
  and starts it as a child process; `HANGAR_TICK_MS` shortens the job tick.
- On start, `fingerprint SHA256:…` and `pairing code XXXX-XXXX` are in the log;
  after every pairing a new code.
- Default paths (`bays/`, CLI) assume that `dist/` is in the repository.
