# ADR 0050 – Agent bay by default, bay switches in the settings

Status: accepted 2026-11-26. Replaces the "Empty start" part of
[ADR 0017](0017-bays-in-the-sidebar.md); everything else of ADR 0017 stays.

## Context

ADR 0017 started a new Hangar with an empty sidebar: the person had to find the
plus and add the agent bay before Hangar did anything. The agent bay is the main
bay (ADR 0022); almost everyone adds it first. The other bundled bays (browser,
passwords, board, feeds, proxy) are optional. Besides the plus and the context
menu there was no place that showed all found bays and which of them run.

## Decision

- **Agent bay by default:** a new `settings.json` starts with
  `bays: ["dev.hangar.agents"]` (`DEFAULTS` in `packages/host/src/settings.ts`).
  Only a missing file counts as new: an existing file keeps its `bays`, also an
  empty list or a file without `bays`; a broken file keeps an empty sidebar as
  before. There is no migration. If the agent bay is not found (other bay
  folders, `HANGAR_BAYS_DIR`), it is skipped like any missing bay (ADR 0017). The
  other bundled bays stay shipped and are added with the plus.
- **Switches in the settings:** Settings → Bays → "In der Leiste" / "In the
  sidebar" lists every bay of the app the host found (installed and bundled,
  sorted by name; not the bays of the local server or of paired servers), each
  with a switch (`role="switch"`, named after the bay, Space and Enter). On does
  what the plus does, without selecting the bay, so the settings stay open; off
  does what "Remove from sidebar" does: the bay stops, its data stays. There is no
  delete. IPC `shell:bayInSidebar(id, on)`; the list follows `shell:state`, so a
  change via the plus or the context menu shows at once.

## Alternatives

- **All bundled bays by default:** six bays and their functions on the bus for
  everyone, against ADR 0017's "the person decides what runs".
- **Default for existing users too:** would add the agent bay to sidebars that
  were emptied on purpose; rejected.
- **Native checkbox instead of a switch button:** Enter does not toggle a
  checkbox; the switch button takes Space and Enter.

## Consequences

- E2E: `seedBays: false` now starts like a new Hangar with only the agent bay
  (`e2e/sidebar-bays.spec.ts`).
- Whoever wants an empty sidebar switches the agent bay off once; the file then
  keeps `bays: []`.
