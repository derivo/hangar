# ADR 0048 – Grid fields shrink instead of scrolling

Status: accepted 2026-11-19. Replaces the scrolling part of
[ADR 0010](0010-grid-and-bay-windows.md).

## Context

ADR 0010 kept every field at 60 × 16 characters at least; a window made
smaller after fields were added scrolled the grid. Disconnecting a second
screen moves the Hangar window to the laptop screen and makes it smaller. The
fields then no longer fit, the grid shows scrollbars and the terminals of the
fields below the window are out of view.

## Decision

- The minimum of 60 × 16 characters only decides whether "Add field" is
  enabled. Fields that exist share the window: `layout` in
  `bays/agents/src/ui/grid.ts` picks the arrangement whose fields shrink least.
- Fields shrink down to 30 × 4 characters plus header (`SHRUNK_COLUMNS`,
  `SHRUNK_ROWS` in `Workspace.tsx`, set as the `minmax` minimum of columns and
  rows). Only below that, for example at 200 % zoom, does the grid scroll; a
  smaller terminal would leave no room next to the header.
- A field whose header no longer fits scrolls within itself
  (`.field { overflow: auto }`) instead of being drawn over the next field.
- The 60 × 16 minimum stays available to tests as `data-min-width` and
  `data-min-height` on the grid (`e2e/grid.spec.ts`).

## Consequences

- At 100 % zoom a window moved to a smaller screen shows no scrollbars as long
  as every field still gets 30 × 4 characters; the terminals get fewer columns
  or rows, and the programs in them receive a resize (as in any terminal made
  smaller).
- A field can be smaller than 60 × 16 characters until the window grows again
  or a field is closed.
- At 200 % zoom or in very small windows the grid still scrolls.

## Alternatives

- **Keep scrolling (ADR 0010):** terminals keep their size, but some fields are
  out of view and the window shows scrollbars.
- **Shrink without a lower limit:** at 200 % zoom the header filled the whole
  field and the terminal got no rows (observed in `e2e/grid.spec.ts`).
- **Hide the fields that do not fit:** keeps 60 × 16, but sessions disappear
  from view without the person doing anything; more code and state.
