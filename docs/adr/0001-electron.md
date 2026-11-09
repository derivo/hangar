# ADR 0001: Electron as the desktop platform

- Status: accepted
- Date: 2026-10-28

## Context

Hangar must run on macOS, Windows and Linux, hold several isolated web
interfaces (bays) at the same time, and manage native resources such as
pseudo-terminals (node-pty) in the main process.

## Decision

Hangar is an Electron app. Each bay interface runs in its own
`WebContentsView` with its own session partition (`persist:bay:<id>`),
`contextIsolation`, `sandbox` and without `nodeIntegration`. Build with
electron-vite, packages with electron-builder.

## Consequences

- One Chromium process per bay interface: crashes stay limited to the bay.
- Native modules (node-pty) must match the Electron ABI; node-pty 1.1 uses
  N-API prebuilds, so `electron-rebuild` is not needed.
- Larger packages than with Tauri or similar; in return, node-pty can be used
  directly.
