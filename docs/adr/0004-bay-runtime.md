# ADR 0004: Runtime and delivery of bays

- Status: accepted
- Date: 2026-10-28

## Context

The concept leaves open whether the main part of a bay runs in the main process
or in a utility process, and how bays with native dependencies (node-pty) are
delivered.

## Decision

- The main part of a bay runs in the **main process** and is loaded by dynamic
  `import()`. It receives only a `BayContext` (SDK) – no access to windows or
  other bays.
- The main part is bundled as **one ESM file** (`dist/main/index.js`). Native
  modules (node-pty) stay external and are resolved at runtime from the host's
  `node_modules`; `apps/desktop` therefore declares them as a dependency.
- The UI runs in a sandboxed `WebContentsView` with its own partition
  (`persist:bay:<id>`). Communication only through `window.hangar` ↔ `ctx.ui`.
- In the package, bays live under `<app>/bays/<name>` (manifest, icon, dist). In
  development, `bays/` of the repository is read; `HANGAR_BAYS_DIR` overrides
  both.

## Consequences

- Simple and fast; a crash in the main part of a bay can hit the main process.
  A later switch to `utilityProcess` is possible, because bays only see the
  `BayContext`: the context would then have to be implemented over a MessagePort
  (same `Transport` pattern as with the bus).
- Third-party bays with their own native modules are not planned for the MVP.
