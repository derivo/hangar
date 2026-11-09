# ADR 0018 – Hangar server without an interface

Status: accepted.

## Context

Jobs run only while Hangar runs; a closed laptop misses them
([concept-server.md](../concept-server.md)). Since phase 8 the core lives
without Electron in `packages/host`. Phase 9 brings it as a Node process to a
machine without a screen. The bridge to the desktop app follows in phase 10.

## Decision

- **`apps/server`:** `hangar-server --data <ordner> [--listen 127.0.0.1:<port>]
[--root <ordner>]… [--bays <ordner>]…`, bundled to `dist/hangar-server.mjs` and
  started with Node. The data folder is laid out like `userData` on the desktop
  (`permissions.json`, `jobs.json`, `settings.json`, `bays/`, `bin/`).
- **Loopback only:** `--listen` accepts only `127.0.0.1`, `::1` or `localhost`.
  The desktop later reaches the server through an SSH tunnel.
- **Permissions only from rules:** There is nobody to answer a dialog. If a
  stored rule is missing, the server denies:
  `Access denied: <bay> → <funktion> (no rule on the server: set one in permissions.json)`.
  The text is English like all errors of the bus functions (ADR 0009).
- **Bays:** The server loads all found bays (`--bays`, without it `bays/` of the
  repository), not the sidebar from `settings.json`, because the server has no
  sidebar. Bays with a host module that does not exist there (`browser`) it does
  not load and reports them under `errors` in `/health`.
- **Path instead of a folder dialog:** `ctx.pickFolder({ path })` checks the path
  on the server. After resolving symbolic links it must lie under a `--root`; the
  real path comes back. Without `path` the server throws. The agent bay passes a
  path from the interface on at `project.add`. The desktop ignores `path`.
- **`GET /health`:** version, loaded bays, bays not loaded with reason, jobs with
  time and success of the last run. A job's output is missing there and in the
  log, because it may contain terminal content; it is in `jobs.json`.
- **Without a target until phase 10:** Notifications, badges and UI events go
  nowhere. Since phases 10b and 11c they go to connected desktops (ADR 0019).
- **Job tick:** as on the desktop every 15 s; `HANGAR_TICK_MS` changes it
  (tests).

## Alternatives

- **Electron without a window on the server:** brings Chromium and a display
  dependency; rejected.
- **Defer prompts to a later desktop:** A job would hang; rejected, a job ends
  with a clear reason (concept-server.md).
- **Allow all paths:** Agents reach every folder of the service user via
  `project.add`; rejected in favor of approved root folders.

## Consequences

- Unattended jobs need rules set beforehand in `permissions.json`.
- The browser bay does not exist on the server.
- Tested under Node as a child process (`server.integration.test.ts`); the agent
  bay including node-pty loads under Node.
