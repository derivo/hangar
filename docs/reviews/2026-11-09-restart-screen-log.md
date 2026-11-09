# Review: restart screen with live log and reconnect attempt (2026-11-09)

Reviewer: Codex (read-only), before the commit. Scope: the uncommitted change
on `feat/restart-screen-log`: `apps/desktop/src/main/log-tail.ts`,
`host.ts`, `packages/bridge/src/connections.ts`, `shared.ts`,
`renderer/App.tsx`, `styles.css`, `messages.ts`, their tests and the e2e specs
`a11y.spec.ts` and `local-server.spec.ts`. Codex did not run tests or builds.

## Findings

1. **[P2] Short read ignored** (`log-tail.ts`). A file cut between stat and
   read gave NUL padding and a wrong offset. Fixed: only the bytes read count,
   `offset = start + bytesRead`.
2. **[P2] Cut line start shown as a line** (`log-tail.ts`). With no newline in
   the read window, the fragment later showed as a whole line. Fixed: text is
   dropped up to the next newline, across polls.
3. **[P2] Unbounded partial line** (`log-tail.ts`). Output without newlines grew
   the buffer without limit. Fixed: capped at 64 KiB, marked with `…`.
4. **[P2] "Reconnecting" forever** (`connections.ts`). `retry` stayed set once
   no further attempt was scheduled. Fixed: cleared on `stopRetry`.
5. **[P3] Attempt number one behind** (`connections.ts`). The state was pushed
   before the counter went up. Fixed: count first, then push.
6. **[P2] WCAG 2.2.2 Pause, Stop, Hide** (`App.tsx`). The live log could not be
   paused. Fixed: "Log anhalten" / "Pause log" button with `aria-pressed`; the
   log follows new lines only while scrolled to its end.
7. **[P2] Rotation with quick regrowth** (`log-tail.ts`). A log cut and grown
   back to at least its old size between two checks goes unnoticed. Accepted:
   launchd only appends to `server.log`; the limit is in
   `apps/desktop/CLAUDE.md`.

Found while fixing: `fs.watchFile` takes its first check late, so lines written
right after the first read could be missed (flaky in 5 of 6 seeded runs).
`tailFile` now polls with `statSync` on an unref'd 250 ms interval; 8 of 8
seeds green.

Every fix started with a failing test. Gates after the fixes: `pnpm lint`,
`pnpm typecheck`, `pnpm test` (1347 passed, 2 skipped), `pnpm build`, e2e
`a11y.spec.ts` + `local-server.spec.ts` (9 passed, 1 skipped: packaged app
only), all exit 0.
