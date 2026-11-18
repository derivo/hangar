# Review: maintenance cross-review (2026-11-18)

Reviewer: Codex (`codex exec -s read-only`): one cross-review of `main` at
`fbbee07` (does the concept hold, does the code have bugs), then one round on
the diff of branch `maint/2026-11-18`.

## Cross-review findings

Codex reported five P2 findings and reproduced each with doubles; its sandbox
could not run the full suite.

- **Fixed: cron day steps.** `packages/scheduler/src/cron.ts`: `anyDay` is set
  for any day field starting with `*`, also `*/2`, and then the day of month was
  ignored, so `0 0 */2 * *` ran every day. Day and weekday now both count when
  either field starts with `*`, as in cron.
- **Fixed: `--root /`.** `apps/server/src/options.ts`: the check appended a
  separator to the root, so `/` became `//` and every folder was refused.
- **Open: restoring sessions with password references.**
  `bays/agents/src/main/sessions.ts`: when the local server restores a session
  whose environment names a password, `secret.resolve` runs before the desktop
  offered its functions; the shell stays stopped until restarted by hand.
- **Open: a restarted relay peer misses the other peer's functions.**
  `packages/relay/src/client.ts`: a peer that is already in `announced` does not
  answer the announcement of a restarted peer.
- **Open: a join request can be lost on reconnect.**
  `packages/relay/src/client.ts`: a `joined` message in the same read as `ready`
  runs before `onJoined` is registered.

The three open findings need lifecycle changes; they were not verified here and
come as a separate plan.

Architecture: Codex finds it holds (Electron-free core, one permission bus,
separate bridge and relay transports). Its weak point is implicit assumptions
about readiness and re-registration after a delayed start or a one-sided
restart.

## Diff review

No findings. Codex ran 18 targeted assertions on cron edge cases and root and
repository limits, and confirmed through the GitHub API that the repository is
public with no release.

## Verification

- `cron.test.ts` "keeps a stepped day of month" failed against `main`
  (`2026-11-02` instead of `2026-11-03`), passes with the fix.
- `options.test.ts` with `parse(root).root` as allowed root failed against
  `main` ("Folder outside the allowed roots"), passes with the fix.
- `pnpm lint`, `pnpm typecheck` exit 0; `pnpm test` 1541 passed, 2 skipped.
