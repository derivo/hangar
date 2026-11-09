# ADR 0010 – Grid and separate windows for bays

Status: accepted

## Context

Several agent sessions should be visible at the same time, on a 49-inch
widescreen clearly more than three side by side, without a terminal becoming
unreadably small. A session should also be detachable into its own window, for
example for a second screen. Bays run in sandboxed `WebContentsView`s and cannot
open windows themselves (`window.open` is rejected).

## Decision

- **Grid in the bay:** The agent bay arranges its fields itself
  (`bays/agents/src/ui/grid.ts`). Each field has a minimum size of
  60 × 16 terminal characters (until 2026-10-30: 80 × 24), measured by the
  terminal font plus a fixed margin (header, status bar, padding, room for the
  xterm.js scrollbar). The arrangement chosen is the one whose fields are
  furthest above the minimum size. If no further field fits, "Add field" is
  disabled (`aria-disabled`, still focusable) and gives the reason as a
  description and tooltip, not as a permanent line; if the window then becomes
  smaller, the grid scrolls. No dragging of field sizes in the first step.
- **One session, one place:** A session is in at most one field or in its own
  window. The field of a detached session shows a notice with "Bring back".
- **Windows as a host function:** The SDK gets `window.hangar.windows` (`open`,
  `close`, `list`, `onChange`, `current`). A window loads the bay's UI again with
  `?window=<key>`, with the same preload, the same partition and the same sandbox
  rules as the view. `ctx.ui.send` reaches the view and all windows of the bay;
  IPC from a window is assigned to its bay via `event.sender`. A bay can only
  open and close its own windows.
- **Restoration:** Open windows are stored with bay, key, title and position in
  `view.json` and open again on the next start.

## Alternatives

- **Fixed table (1×1, 2×1, 2×2 …)**: simple, but does not use a widescreen and
  lets fields on small windows shrink below any usable size.
- **Minimum size via CSS (`minmax`, `auto-fill`)**: does not know the character
  width of the terminal font and cannot disable "Add field".
- **Windows in the bay's main part (`ctx.windows`)**: The request comes from the
  UI; the detour through the main part would add nothing but a second channel.

## Consequences

- Every bay can use its own windows; the agent bay is the first user.
- The margin allowance is a constant (`CHROME` in
  `bays/agents/src/ui/Workspace.tsx`); `e2e/grid.spec.ts` checks with `stty size`
  that a field of minimum size really holds 60 × 16 characters. If the field
  header changes, this test fails.
- With 80 × 24, only one field fit at 100 % zoom on a laptop, and the notice was
  permanently shown. With 60 × 16, two fields fit side by side; more only on
  larger screens or with smaller zoom. Measured: A window at the default
  resolution of a 16″ MacBook Pro (1728 × 1080) holds two fields side by side,
  1400 × 900 only one. At minimum width the field header wraps to three lines;
  `CHROME.height` is therefore 280 px.
