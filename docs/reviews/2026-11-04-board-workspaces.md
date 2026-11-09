# Review: board over workspaces (2026-11-04)

Subject: uncommitted diff "agents of other instances on the board"
(ADR 0037, addendum): `bays/board/src/main/index.ts`, `manifest.json`,
`project.list` with `shared`, `apps/relay/src/board.integration.test.ts`.
Reviewer: Codex (`codex exec -s read-only`).

## Findings

| No. | Prio | Finding                                                                                                                                           | Decision                                                                                                                                                                                                                                                                                      |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P2   | Two shared projects of the same name: `find()` takes the first; after re-sorting the same call lands in a different project. Reproduced by Codex. | Accepted. Ambiguous names are rejected with `Project name is ambiguous`; test `refuses a project name that two shared projects carry` (first red, then green). `handover.create` (`bays/agents/src/main/functions.ts:160`) already had the same search by name before; not part of this diff. |
| 2   | P3   | Ownership without a session ID (as over the relay) tested only indirectly; foreign instance without an ID is missing.                             | Accepted as unit test `owns a task per instance when the relay carries no session` (foreign instance: claim/note/done rejected, own one done). No additional relay test: the path is the same, the relay delivers the ID empty, the existing integration test proves that.                    |
