# ADR 0034 – Install, update, roll back bays

Status: accepted (Phase 20; basis: [ADR 0012](0012-registry.md),
[ADR 0033](0033-bay-packages-and-index.md),
[concept-registry.md](../concept-registry.md) "Installation, update, rollback")

## Context

With signed packages and index (ADR 0033), the path into the app is missing:
install and update bays from the index, without a new Hangar build, only after
confirmation and with a way back that keeps code and data together.

## Decision

- **Storage** `<userData>/packages/<id>/<version>/`, state in
  `<userData>/packages/_state.json` (active, previous and next version per bay,
  highest seen index version). Separate from the data folder
  `<userData>/bays/<id>`; only the host writes there.
- **Flow** (`BayStore`): `prepare` loads index and package, checks index,
  checksum and signature, unpacks into a temporary folder, checks the manifest
  and that identifier and version match the index, and returns the permission
  diff. Only what the configured update channel carries and what is newer than
  the running version is offered and installed; older versions exist only
  through rollback. Only `confirm` stores the version and notes it for the next
  start; `cancel` discards it. Identifier and version in the index must be safe
  folder names.
- **Permission diff** against the running version (also a bundled one): new
  functions, new `uses`, `agentSessions` new, new `hostModules`, functions that
  are newly sensitive. For the latter the switch resets stored `allow`
  permissions; the next call asks again. The dialog is a native confirmation
  with the diff as text.
- **Switch at the next start** (`applyPending`, before loading the bays). If
  `dataVersion` changes, Hangar copies the data folder to
  `packages/<id>/data-<old version>`; a rollback restores this backup and puts
  the current state next to it. The dialog says that changes since the update
  are lost. If the first installed version replaces a bundled bay with a
  different `dataVersion`, Hangar backs up to `data-bundled-<version>`. After
  that only the active and previous version with their data backup remain; the
  rest is deleted.
- **Loading:** Installed bays come before the bundled ones and replace them
  without an error message; a development folder (`HANGAR_BAYS_DIR`) takes
  precedence. A newly installed bay is added to the sidebar (`settings.json`
  `bays`).
- **Index source:** `HANGAR_BAY_INDEX` (https or local path) and
  `HANGAR_BAY_INDEX_KEY` (public Ed25519 key, JWK `x`). Without both, the
  setting shows "No bay index set up.". If the index is unreachable or invalid,
  the setting names the error and keeps listing the installed bays, so that
  rollback stays possible. The built-in key and the published index come with
  Phase 21.
- **UI:** "Settings → Install bays": per bay identifier, "Installed: …" or
  "Not installed", "From the next start: …", buttons "Install …",
  "Update to …", "Roll back to …". One action at a time (ADR 0028), until the
  list is reloaded; a channel change reloads the list.

## Consequences

- Deviating from the concept: pointers in `_state.json` instead of a file
  `active` per bay (the underscore prevents a collision with a bay identifier);
  old versions go at the switch already, not only after the second successful
  start.
- No removal of installed bays, no check for updates at start and daily
  (Phase 21), no switch while running.
