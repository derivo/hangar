# Review: collapsible project bar

Date: 2026-10-31. Reviewer: Codex (`gpt-6.1-sol`, `codex exec -s read-only`),
scope: uncommitted diff for `ProjectTree` (collapsed only status lights, state
in `localStorage` `treeCollapsed`), CSS and tests.

Every finding was checked against the code. Result: 1 bug and 2 test gaps, all
confirmed and fixed.

## Findings

| No. | Severity | File                                     | Finding                                                                                                                             | Fix                                                                                             | Test                                                                                                    |
| --- | -------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | medium   | `bays/agents/src/ui/ProjectTree.tsx`     | When collapsed the second line is missing; two sessions with the same description in the same project had the same name and tooltip | With a description the short ID is part of the name, for example "Login (455b82f8) – shop"      | `ProjectTree.test.tsx` "collapses to a column of status lights …" (red before the fix)                  |
| 2   | low      | `ProjectTree.test.tsx`, E2E              | Checked only by click; a loss of focus when toggling would go unnoticed                                                             | Tests for Tab, Enter and Space; the focus stays on the button in both directions                | `ProjectTree.test.tsx` "toggles by keyboard and keeps the focus on the toggle", `tree-collapse.spec.ts` |
| 3   | low      | `apps/desktop/e2e/tree-collapse.spec.ts` | Only the width of the workspace was checked, not whether the terminal gets more columns                                             | `stty size` before, after collapsing (more columns) and after expanding (the same number again) | `tree-collapse.spec.ts`                                                                                 |

The tests for 2 and 3 were not red: the behavior was right, only the proof was
missing.
