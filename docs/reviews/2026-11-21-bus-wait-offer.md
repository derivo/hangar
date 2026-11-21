# Review: restored shells wait for the app (2026-11-21)

Reviewer: Codex (`codex exec -s read-only`), on the diff of branch `fix/bus-wait-offer`, two
rounds.

## Context

Finding #1 of the maintenance cross-review (`2026-11-18-maintenance-cross-review.md`): when
the local server starts, the agent bay restores its sessions, and a session with a password
reference calls `dev.hangar.secrets/secret.resolve`. The bus knew the app's functions only
after the bays had started, and no app can connect before that (`/connect` answers 503), so
the call failed with `Unknown function` and the shell stayed stopped. The maintainer chose
option (a): the bus waits, not the agent bay. The server now registers the functions from
`desktop-functions.json` before the bays start, and a bridge call made before `ready` waits
for the first offer, at most 60 s. After the start a call without the app fails at once as
before. Recorded as an addendum to ADR 0036.

## Findings

- P1, fixed: the early registration left out every discovered bay, including
  `dev.hangar.secrets`, which the server skips later for its host module. That removed
  exactly `secret.resolve`, and the restore still failed with `Unknown function`. Now only
  bays that run on the server (no host module other than `workspaces`) are left out. The
  server test puts a `dev.hangar.secrets` bay with `hostModules: ['secrets']` in the bays
  folder; it was red before the fix with the same error.
- P3, fixed: each waiting call kept a callback on a shared promise after its timeout, and
  `close()` did not end waiting calls. Waiting calls are now kept in a set, removed on offer
  and timeout, and rejected on `close()` ("The server is shutting down"). The bridge test
  covers the close path; it timed out before the fix.

Second round on the fixes: no findings.

## Verification

- Red first: `server.test.ts` "lets a bay that calls the desktop while starting wait for its
  offer" (`Unknown function: dev.hangar.secrets/…`), `bridge.test.ts` "lets a call made while
  the bays start wait for the first offer" (`Hangar is not open`, then a timeout for the
  close path).
- `pnpm lint`, `pnpm typecheck`, `pnpm test` (1591 passed, 2 skipped), `pnpm test:e2e`
  (71 passed, 2 skipped) green.
