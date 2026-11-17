# Review: shell size before the shell runs (2026-11-17)

Reviewer: Codex (`codex exec -s read-only`), one round, on the diff of branch
`fix/pty-size-before-start`.

## Context

Reported in the packaged app: in an agent-bay terminal sometimes only the bottom
quarter updates and the rest stands still. Every shell started at 100 × 30
(`bays/agents/src/main/sessions.ts`, `spawnShell`); a `resize` that came while no
shell ran (waiting for a password, restart) was dropped, and the terminal sends
its size again only on attach or a layout change. The e2e test
`session-env.spec.ts` ("a restarted shell has the size of its terminal")
reproduced it: `stty size` gave `30 100` instead of `31 107` after
"Shell neu starten".

## Findings

- **P1, fixed:** the new unit test did not typecheck (`Promise<unknown>` for
  `resolveSecrets`).
- **P2, fixed (existing bug):** `restoreSuffix()` kept a scroll region (DECSTBM)
  the killed program had set; with `ESC[68;90r` replayed only lines 68–90 of 90
  scrolled until a resize. The suffix now resets it (`ESC 7 ESC[r ESC 8`, the
  cursor saved because DECSTBM moves it home).
- **Kept:** two views of one session still share one size (last report wins).
- **Not known:** which of the two causes the reported freeze had; the packaged
  app was not checked.

## Verification

- Unit: the size test failed against `main` (`100,30`), passes with the fix;
  agents tests 350 of 350.
- e2e: the restart test failed without the fix, passed 3 of 3 with it;
  `session-env`, `m4-restore`, `grid` and `m2-shell` specs 6 of 6.
