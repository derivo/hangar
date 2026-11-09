# Review: bay settings, "Selecting copies", session in the project folder, grid 60 × 16

Date: 2026-10-30. Reviewer: Codex (`gpt-6.1-sol`, `codex exec -s read-only`),
scope: uncommitted diff for manifest `settings` and `ctx.settings` (ADR 0023),
IPC `shell:baySettings`/`shell:baySetting`, the "Selecting copies" switch per
session, session in the project folder (ADR 0022) and minimum size 60 × 16
(ADR 0010).

Every finding was checked against the code. Result: 4 findings, 3 confirmed
and fixed, 1 rejected.

## Findings

| No. | Severity | File                                 | Finding                                                                                                                | Assessment and fix                                                                                                                                                                                                                          | Test (red before the fix)                                                                              |
| --- | -------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | medium   | `apps/desktop/src/main/index.ts`     | `shell:baySettings`/`shell:baySetting` do not check the sender                                                         | Rejected for this diff: no `shell:*` handler checks the sender today (not even `shell:setGrant`); bays run sandboxed with only `window.hangar` and cannot reach `shell:*`. A sender check for all `shell:*` would be a hardening of its own | –                                                                                                      |
| 2   | medium   | `packages/host/src/settings.ts`      | A declared key such as `constructor` read the inherited function instead of the default when the store was empty       | Confirmed; own keys only (`Object.hasOwn`)                                                                                                                                                                                                  | `settings.test.ts` "keeps only boolean bay settings and falls back to the declared default (ADR 0023)" |
| 3   | medium   | `bays/agents/src/ui/ProjectPane.tsx` | A session in the project folder without a description showed an empty open button and no place in the project overview | Confirmed; `sessionName` and `branchOf` as in the project tree and field                                                                                                                                                                    | `ProjectPane.test.tsx` "names a session in the project folder by its place, not by an empty branch"    |
| 4   | low      | `apps/desktop/e2e/grid.spec.ts`      | Formatting violates Prettier, lint fails                                                                               | Confirmed; formatted                                                                                                                                                                                                                        | `pnpm lint`                                                                                            |

## Own findings during the review

- `e2e/grid.spec.ts`: at minimum width the field header wraps to three lines
  (229 px measured); a field of minimum size held only 12 instead of 16 lines.
  `CHROME.height` rises from 220 to 280. At 1400 × 900 and 100 % only one field
  fits (1012 px width, two fields need about 1054 px); the test therefore
  checks two fields side by side at 1728 × 1080.
- `e2e/i18n.spec.ts`: under the pseudo-locale the texts of the bay settings
  came out as English; now via `catalogFor`.
