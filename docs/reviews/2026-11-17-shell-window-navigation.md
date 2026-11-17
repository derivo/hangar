# Review: main window navigation guard (2026-11-17)

Reviewer: Codex (`codex exec -s read-only`), one round, on the diff of branch
`fix/shell-navigation-guard`.

## Context

A source-only security audit of `main` at 2c19132 flagged the main window as
`needs_validation`: unlike bay views it had no `will-navigate` guard and no
window open handler. Its preload `shell.js` grants every `shell:*` channel
(servers, permissions, jobs, workspaces), and those handlers do not check the
sender. A URL dropped on the sidebar, or any other renderer navigation, would
have loaded a foreign page with that preload. The fix blocks `will-navigate` and
denies every `window.open` in the main window, the same pattern as the bay views.

## Findings

- **None.** `loadURL`/`loadFile` and reloads (including dev-server HMR) are not
  renderer navigations and still work; `will-redirect` is not needed because the
  starting navigation is already blocked; `will-frame-navigate` is not needed
  because the shell has no iframes.
- **Kept (existing):** the `shell:*` handlers still do not check the sender
  frame. With navigation blocked only the shell renderer runs with that preload;
  a sender check stays possible defense in depth.
- **Addressed:** Codex noted the unit test checks only the fake. An e2e test now
  makes a real navigation and `window.open` from the main window.

## Verification

- Unit: `host.test.ts` "keeps the shell window on its own page" failed against
  `main` (`preventDefault` not called), passes with the fix; 103 of 103.
- e2e: `m2-shell.spec.ts` "the main window stays on its page" failed without
  the fix ("Execution context was destroyed … navigation"), passed 3 of 3 with it.
- `pnpm lint`, `pnpm typecheck` exit 0; `pnpm test` 1537 passed, 2 skipped.
