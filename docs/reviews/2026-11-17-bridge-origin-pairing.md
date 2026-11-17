# Review: bridge Origin check and pairing block (2026-11-17)

Reviewer: Codex (`codex exec -s read-only`), two rounds (the diff touches
authentication), on the diff of branch `fix/bridge-origin-pairing`.

## Context

A source-only security audit of `main` at 2c19132 flagged the server bridge as
`needs_validation`: the WebSocket `/connect` checked no `Origin`, so a web page
in any browser on the machine could connect to the loopback port, and a wrong
pairing code left the socket open for the next guess without any limit (8
symbols from 32, about 2^40 codes). The fix answers an upgrade with an `Origin`
header with 403 (the desktop's Node WebSocket sends none) and refuses every
pairing attempt, on any socket, for 1 s after a wrong code.

Closing the socket on a wrong code (the first plan) was dropped: the desktop
keeps a probe open for a second try (`connections.test.ts`). Rotating the code
after failures was dropped too: it does not lower the chance per guess.

## Findings

Round 1 (on a first version that queued attempts behind a 1 s delay):

- **P1, fixed:** the queue was unbounded; a flood of `pair` messages grew memory
  and delayed legitimate pairing without limit. Replaced by a timestamp: attempts
  within the block are refused at once, nothing is queued.
- **P2, fixed:** closed sockets still added delay, and the delay timers outlived
  `bridge.close()`. No timers remain; refused attempts do not extend the block.

Round 2: no findings.

- **Kept:** anyone who can reach the port can keep pairing blocked by sending a
  wrong code every second. Web pages can no longer reach it; local processes and
  SSH tunnel users already run as a trusted user.
- **Not known:** a live handshake check that Electron's main process sends no
  `Origin` exists only through the e2e runs below, not as its own assertion.

## Verification

- Unit: the Origin test failed against `main` (`101 Switching Protocols`), the
  block test failed (`Too many pairing attempts` not thrown); both pass with the
  fix. Server tests 88 of 88; `Sidebar.test.tsx` 68 of 68 including the new
  message.
- e2e: `server.spec.ts` pairs with a wrong code, then the right code (refused
  with the new message), then pairs after 1 s; axe 0 violations on that state in
  light and dark. `server`, `local-server` and `a11y` specs: 13 passed, 1 skipped
  (packaged only).
- `pnpm lint`, `pnpm typecheck` exit 0; `pnpm test` 1539 passed, 2 skipped.
