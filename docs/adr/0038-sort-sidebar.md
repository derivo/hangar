# ADR 0038 – Sort bays and shortcuts in the sidebar

Status: accepted 2026-11-04. Extends [ADR 0017](0017-bays-in-the-sidebar.md),
[ADR 0027](0027-shortcuts-in-the-sidebar.md) and
[ADR 0036](0036-shells-survive-restart.md).

## Context

New bays land at the bottom of the sidebar (ADR 0017); nothing could be
reordered. With a local server, its bays (agents, board) also always came after
the app's bays, whatever `settings.json` said. Wish of the person (2026-11-04):
sort bays in the sidebar by drag and drop.

## Decision

- **Two lists:** bays (those of the app and those of the local server together)
  and shortcuts. Dragging works only within one list; the dragged element then
  stands at the target's position (like projects in the agent bay). A line above
  or below the target shows the position. Bays of a remote server stay under
  their server and are not sortable.
- **Without dragging (WCAG 2.5.7):** The context menu (right-click or context
  menu key) has "Move up" and "Move down", disabled at the ends. Bays of the
  local server get a menu for this, with only these two entries (they still
  cannot be removed).
- **Storage:** the order of the bays in `settings.json` `bays`, with the
  identifiers of the local server's bays; a server bay that is missing there
  comes after the others. Entries that the sidebar does not show (a bay that is
  no longer on disk) stay at the end of the list. Shortcuts in the order of
  `shortcuts`.
- **IPC:** `shell:moveBay(id, index)` and `shell:moveShortcut(id, index)`; `id`
  is the identifier the sidebar shows (for the local server
  `remote:<server-id>:<bay-id>`), `index` an integer within the list.
  Everything else changes nothing. `ShellState.order` names the bays in this
  order.

## Consequences

- Once a bay of the local server has been moved, its identifier is in `bays`. If
  the local server is turned off, it then runs in the app (it was in the sidebar
  after all); without moving, only the agent bay stood there so far.

## Alternatives

- **Arrow buttons on every icon:** cost space in a 44 px wide sidebar; the menu
  already exists.
- **Store the order of server bays separately:** two sources for one list;
  rejected.
