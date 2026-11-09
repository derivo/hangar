# ADR 0017 – Adding and removing bays

Status: accepted.

## Context

So far Hangar loads every bay it finds on start and shows it in the sidebar. With
the browser bay there are two; with the registry (ADR 0012) there will be more.
Whoever opens Hangar should decide which bays they use.

## Decision

- **Empty start:** A new Hangar shows only the Hangar symbol at the top of the
  sidebar (Hangar overview, selected) and below it "Add bay" (plus).
- **Adding:** The plus opens a modal with all found bays that are not yet in the
  sidebar (icon, name, id). A selection starts the bay, adds it at the bottom of
  the sidebar and selects it.
- **Only added bays run:** main part, functions on the bus (so MCP tools), jobs
  and interface exist only for bays in the sidebar. Without the browser bay in
  the sidebar, agents have no browser functions.
- **Removing:** A right click on the bay icon (or the context-menu key) opens a
  menu with "Remove from sidebar". Hangar ends the bay (`deactivate`), closes its
  windows and tabs and unregisters its functions. The data folder stays; when the
  bay is added again, everything is back.
- **Storage:** `settings.json` holds the ids of the sidebar in order (`bays`). If
  a bay is missing at start, it is skipped.
- **Modal above bay views:** Bay interfaces are separate views above the content
  area. As long as the modal is open, the host hides them (`shell:modal`).
- **Start selection:** the bay selected last, if still in the sidebar, otherwise
  the Hangar overview.

## Alternatives

- **All bays run, the sidebar shows only a selection:** Agents could use
  functions of invisible bays; rejected, because the person should decide what
  runs.
- **Selection as a page instead of a modal:** one more click back.

## Consequences

- There is no migration: Hangar does not yet have users with an existing
  sidebar.
- E2E tests add the bays they need via `settings.json` (`e2e/helpers.ts`).
