# Review: 100 ports per session, terminal replay, mouse modes, black-orange UI

Date: 2026-10-31. Reviewer: Codex (`gpt-6.1-sol`, `codex exec -s read-only`),
scope: commits `68a771f` (100 ports per session, copy hint, no device answers
such as `1;2c` from the replay), `96e65a1` (`restoreSuffix` switches off mouse
modes after a restart) and `9502fcd` (black-orange UI, ADR 0026).

Every finding was checked against the code. Result: 2 findings, both
confirmed and fixed. No finding for `96e65a1` and `9502fcd`.

## Findings

| No. | Severity | File                              | Finding                                                                                                                                  | Fix                                                                                            | Test (red before the fix)                                                             |
| --- | -------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | medium   | `bays/agents/src/main/ports.ts`   | Only start ports in the new block counted; an earlier session with base 40090 occupies 40090–40189, yet the next session got 40100–40199 | A block is occupied as soon as it overlaps the block of another session (from its base)        | `ports.test.ts` "skips blocks that overlap a session from the time of smaller blocks" |
| 2   | medium   | `bays/agents/src/ui/terminals.ts` | Until the buffer was loaded and replayed, all input was lost, keystrokes too (noticeable with a slow answer, for example from a server)  | Input is discarded only while xterm processes the buffer; before that, input goes to the shell | `terminals.test.ts` "forwards keystrokes typed before the scrollback has arrived"     |

## Limits

- Keystrokes in the milliseconds in which xterm processes the buffer are still
  lost; there they cannot be told apart from xterm's answers.
