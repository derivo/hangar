# Review: handovers with an ambiguous project name (2026-11-04)

Subject: `handover.create` in `bays/agents/src/main/functions.ts` rejects
project names that two projects carry. Reason: finding 1 from
`docs/reviews/2026-11-04-board-workspaces.md`, fixed there for the board.
Reviewer: Codex (`codex exec -s read-only`).

## Findings

| No. | Prio | Finding                                                                                                                                           | Decision                                                                                                                                                                                       |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P2   | A local session names the name of its own project, a second project carries it too: the first draft rejected that as ambiguous.                   | Accepted. The name of the own project means the own one; test covers a session in the first and in the second twin (first red, then green).                                                    |
| 2   | P3   | Only rejections tested; success paths with twins are missing (local without `project`, remote with exactly one shared twin, in front and behind). | Accepted. Test `refuses a project name that two projects carry, unless it is the own or the one shared` checks all three; in addition locally two foreign twins → `Project name is ambiguous`. |

Observed at the gate: a full `vitest run --coverage` once had a failed test
(name not recorded); three runs afterwards with random order green. UNKNOWN:
which test, whether from the diff.
