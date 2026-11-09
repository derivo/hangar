# Review 2026-11-02 – Phase 17, handovers

Review by Codex (`codex exec -s read-only`) over `handover.create`/`handover.get`,
`SessionManager.handover`, `hangar handover` and the display in `SessionPane.tsx`.
Every correction began with a red test in `bays/agents/src/main/handover.test.ts`,
`bays/agents/src/ui/SessionPane.test.tsx` or `packages/cli/src/cli.test.ts`.

| Severity | Location                    | Finding                                                                                                  | Check                | Consequence                                                                                                                                                  |
| -------- | --------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| medium   | `functions.ts`              | The share of the project is checked before the serial queue; a revocation during the wait has no effect. | confirmed (red test) | `SessionManager.handover` checks share and upper limit only when the handover is its turn.                                                                   |
| medium   | `SessionPane.tsx`, `cli.ts` | A Git address without a branch disappears from the display and `hangar handover`.                        | confirmed (red test) | Own line "Remote" if no branch is named.                                                                                                                     |
| medium   | `functions.ts`              | Valid branch names such as `feature/login+api` or with umlauts are rejected.                             | confirmed (code)     | **Not adopted:** deliberately a safe subset (`A-Z a-z 0-9 . _ / -`, no leading `-`, no `..`); removed branches are only displayed anyway. Stated in the ADR. |

Own finding before the review: task and context land in the terminal of the
target session via `hangar handover`; control characters in them (such as OSC
52, which writes the clipboard) would have taken effect there.
`handover.create` rejects control characters except line break and tab,
`hangar handover` removes them before output (red tests in `handover.test.ts`
and `cli.test.ts`).
