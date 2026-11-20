# Review: an instance that connects again gets the functions again (2026-11-19)

Reviewer: Codex (`codex exec -s read-only`), two rounds on the diff of branch
`fix/relay-announce-ask`. Finding 2 of the maintenance cross-review
(`2026-11-18-maintenance-cross-review.md`).

## Context

`RelayClient` announces its shared functions to each peer once per connection (the
`announced` set). When B restarted, B announced to A, but A still had B in
`announced` and stayed silent, so B never learned A's functions. Now the first
announce of a connection carries `ask: true`, and the receiver answers it with its
own announce, which never asks, so there is no ping-pong. Older instances ignore the
field.

## Findings

Round 1:

- P2, fixed: a malicious member could send `ask` again and again; each one returned
  the whole function catalog and every stored bay state (Codex: five asks, 2.5 MB of
  answers with a 500 kB state). Answers are now bundled per workspace and peer: at
  most one per `ASK_INTERVAL_MS` (2 s). An ask within the interval gets one answer at
  its end; `closed()` clears the timer. An answer that could not be sealed (the asker
  is not in the local list yet) does not count.

While fixing it, the existing test "two members changing the list at once" failed in
2 of 20 runs with the change and 0 of 18 without: it assumed that A's `renew` reaches
the relay before B's, which two sockets do not guarantee; the extra answer traffic
made the other order more likely. The test now checks the invariant without the
order: exactly one change gets through, the other gets `Not newer than the stored
list`, and both lists end up equal.

Round 2: no findings. Codex judged the amplification bounded, found no timer leak or
announce after close, a quick reconnect gets the catalog at the latest with the
bundled answer, and the test change legitimate.

## Verification

- New tests in `apps/relay/src/client.test.ts`: "an instance that connects again
  gets the functions of the others again" failed before the fix (no remote function
  on the new bus); "answers asking announces of one member at most once per interval"
  failed before the bundling (five answers).
- `apps/relay/src/client.test.ts`: 15 of 15 runs passed (26 tests).
- `pnpm lint`, `pnpm typecheck` exit 0; `pnpm test` 1585 passed, 2 skipped.
