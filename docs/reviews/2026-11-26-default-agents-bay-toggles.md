# Review: agent bay by default, bay switches in the settings (2026-11-26)

Reviewer: Codex (`codex exec -s read-only`), on the staged changes of
`feat/default-agents-bay-toggles` against `origin/main` (ADR 0050). Scope: bugs,
accessibility of the switch, migration risk for existing `settings.json`. Every
finding was checked against the code before it was adopted; both held and were fixed.

| #   | Sev.   | Finding                                                                                                                                                                                      | Checked                                                                                                                                                                                                                                                                        | Change                                                                                                                                                                                                                                                                                                                   |
| --- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | medium | The plus loses its selection while the settings switch starts the same bay: it joins the running `addBay(id, false)` and gets only its promise                                               | Confirmed (new in this branch): `addBay` returned the running start unchanged; the picker closed and the settings stayed selected                                                                                                                                              | `addBay` with `select` selects after joining a running start. Unit test "selects a bay chosen with the plus while the settings switch starts it" in `host.test.ts` (red before the fix)                                                                                                                                  |
| 2   | medium | Adding a bay while it stops loses its bus functions: `removeBay` drops the runtime before the async `deactivate()`, a parallel add starts a new one, then the old stop calls `unregisterBay` | Confirmed, already in `origin/main` (plus or context menu); the switch makes it easier to reach. Reproduced in the unit test: the add during the stop only selected the old runtime, which the stop then removed, so the bay ended up stopped although it was switched back on | `removeBay` keeps its stop in `removing` per bay; `addBay` waits for it and starts anew afterwards. Unit test "adds a bay again only after its stop is done, so the stop keeps its new functions" in `host.test.ts` (holds the stop; red before the fix: one start instead of two, functions unregistered after the add) |

## Checked without finding

- Migration: missing file, `bays: []`, no `bays`, existing bays, broken JSON, `null`
  and a read error – only a missing file gets the agent bay; reading never writes.
- Switch: name, role, state, Space and Enter, focus kept after switching; bays of
  the local server and of paired servers are not listed.
- Contrast of the track (Codex, computed from `packages/theme/src/tokens.css`): off
  border 6.55:1 light / 6.39:1 dark, on 5.17:1 / 7.47:1; the knob passes 3:1.
  The axe runs in `e2e/sidebar-bays.spec.ts` and `e2e/a11y.spec.ts` (light and dark)
  report 0 violations.
