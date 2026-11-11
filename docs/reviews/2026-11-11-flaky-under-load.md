# Review: unit tests stable under CPU starvation (2026-11-11)

Reviewer: Codex (read-only), before the commit. Scope: the uncommitted change
on `test/flaky-under-load`: `apps/relay/src/client.test.ts`,
`vitest.config.ts`, `vitest.setup-ui.ts`, `CHANGELOG.md`. Codex did not run
tests.

## Findings

1. **[P2] Handshake timer leaks on failure** (`packages/relay/src/client.ts`).
   `connect()` rejected on close, error or an error message without clearing
   its handshake timer; without the short `callTimeoutMs` in the test it now
   stayed active for 60 s. Fixed: `fail` clears the timer. Red test first: the
   handshake timer (recognised by its delay) was never passed to
   `clearTimeout`. A first version counted all fake timers and failed on Linux
   CI, where `ws` still has its close timer running.

Codex confirmed that assertions stay intact and fake timers are restored
before teardown.
