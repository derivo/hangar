# Review 2026-11-01 – Phase 14, `packages/relay`

Review of the new package by Codex (`codex exec -s read-only`), this package
only (roadmap Phase 14). Codex ran 17 checks of its own with Node scripts; file
access emulated in memory, no Vitest.

The tests were written after the code (deviation from "red first"). Compensation:
mutation probes against eight security checks (replay not stored, replay not
checked, signature not checked, revocation dropped, expiry not checked, signer
not a member, wrong recipient, time window) – each makes at least one test
fail. The corrections below began with red tests.

| Severity | Location     | Finding                                                                                                          | Check                | Consequence                                                                                                                          |
| -------- | ------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| high     | `members.ts` | If the relay withholds a revocation, the revoked member signs a newer list and extends itself beyond seven days. | confirmed (red test) | Per member, the issue time of the newest list signed by **another** instance counts (`vouchedTimes`); stored together with the list. |
| medium   | `members.ts` | A list with `issued` in the future never expires.                                                                | confirmed (red test) | `issued` at most 5 minutes ahead (`CLOCK_TOLERANCE_MS`), otherwise rejected.                                                         |
| medium   | `replay.ts`  | Two guards on the same file work with old copies; a replay gets through, the newer state is overwritten.         | confirmed (red test) | State is read fresh before every check.                                                                                              |
| medium   | `replay.ts`  | Valid JSON of the wrong shape (missing `seq`) is accepted as state; replays get through.                         | confirmed (red test) | Shape is checked on reading, otherwise `Broken replay state`.                                                                        |
| medium   | `replay.ts`  | Atomic rename without `fsync`: after a power failure the old state can come back.                                | confirmed (code)     | `writeFileSync(..., { flush: true })` and `fsync` of the folder. Not testable without a real power failure.                          |

Own finding: member lists from the relay were not checked for their shape; a
string as `revoked` satisfies every `includes`. Now `wellFormed` before every
check (red test first).

Limit, remains: if another member, from whom the relay also withholds the
revocation, signs a renewal, the revoked member continues to count there. For
that the relay would have to withhold all lists between the members; Phase 15
therefore also exchanges the list end-to-end between instances.
