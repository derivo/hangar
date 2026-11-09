# Review: tab colors and copy on select

Date: 2026-10-30. Reviewer: Codex (`gpt-6.1-sol`, `codex exec -s read-only`),
scope: uncommitted agent bay diff for tab colors (`SessionRecord.color`,
tokens `--hangar-color-tab-*`, selection "Color", stripe in the project tree)
and copy on select in the terminal (`TerminalRegistry.attach`).

Every finding was checked against the code. Result: 3 findings, 2 confirmed
and fixed, 1 rejected.

## Findings

| No. | Severity | File                               | Finding                                                                                     | Assessment and fix                                                                            | Test (red before the fix)                                                              |
| --- | -------- | ---------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | medium   | `bays/agents/src/ui/terminals.ts`  | Right and middle click triggered the copy and overwrote the clipboard with an old selection | Confirmed; only the left button (`button === 0`) copies                                       | `terminals.test.ts` "copies the selection to the clipboard when the mouse is released" |
| 2   | medium   | `bays/agents/src/ui/terminals.ts`  | A pending `mouseup` listener read the selection of a disposed terminal after `dispose`      | Confirmed; copying only while exactly this terminal still belongs to the session              | same test (mouse down, `dispose`, release)                                             |
| 3   | medium   | `bays/agents/src/main/sessions.ts` | Docs and CHANGELOG were missing (AGENTS.md rule 5)                                          | Rejected: the diff dated from before the docs step; docs and CHANGELOG are in the same commit | –                                                                                      |
