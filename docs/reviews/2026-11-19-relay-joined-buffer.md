# Review: join requests right after ready reach the members (2026-11-19)

Reviewer: Codex (`codex exec -s read-only`), one round on the diff of branch
`fix/relay-joined-buffer`. Finding 3 of the maintenance cross-review
(`2026-11-18-maintenance-cross-review.md`).

## Context

After `ready`, the relay at once asks again for every join no member has added yet
(`apps/relay/src/relay.ts`). `RelayClient.connect` handles all frames of a socket
chunk synchronously, so a `joined` in the same chunk as `ready` was dispatched before
`packages/host/src/workspaces.ts` could register `onJoined`, and it was lost until the
next reconnect. The client now keeps verified joins that arrive while no listener
exists (at most 100, the relay is not trusted) and hands them to the first `onJoined`.

## Findings

- P2, fixed: the new test relied on two `ws.send()` calls arriving in one chunk, which
  TCP does not guarantee; with separate chunks it passed without the fix. It now waits
  until `joined` has arrived and registers the listener afterwards, which fails without
  the fix in every run.

Codex found nothing else: order, the 100 limit, delivery once and the identity check
held in its isolated runtime checks.

## Verification

- `apps/relay/src/client.test.ts`: the new test fails without the fix
  (`Number of calls: 0`) and passes with it; the file passes 3 of 3 runs (25 tests).
- `pnpm lint`, `pnpm typecheck` exit 0; `pnpm test` 1584 passed, 2 skipped.
