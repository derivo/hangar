# Review sorting the sidebar (2026-11-04)

Reviewer: Codex (`codex exec -s read-only`), diff before the commit. Scope: ADR
0038, `order()`, `moveBay`, `moveShortcut` and menus in
`apps/desktop/src/main/host.ts`, IPC `shell:moveBay`/`shell:moveShortcut`,
`useReorder` in `Sidebar.tsx`. Focus: inputs over IPC, duplicate or lost
entries in `settings.json` `bays`, bays of the local server when switching
off, stale menu positions, state while dragging, accessibility.

## Findings

1. **[P2] Duplicate ID in `bays`.** If a bay runs in the app and in the local
   server at the same time (for example an installed one without host modules),
   it stood twice in `bays` after a move; after switching the server off the
   app started it twice. **Adopted:** every ID once. Test `host.test.ts`
   "writes a bay that runs in the app and in the local server only once".
2. **[P2] Stale menu position.** "Move up"/"Move down" computed with the
   position when the menu was opened; if the sidebar changed until the click
   (server connected, another move), the bay landed wrong. **Adopted:** the
   position is determined at the click. Test "moves from the place a bay has
   when the menu item is clicked".

That bays of the local server run in the app after a move when switching off is
intended (ADR 0038, consequences).

## Not checked

- Codex ran without tests (read-only sandbox).
- Context menu key by keyboard: the native menu replaces E2E; the way via
  `contextmenu` is the same as for a right click.
