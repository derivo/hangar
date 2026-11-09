# Review local server bootstrap (2026-11-09)

Reviewer: Codex (`codex exec -s read-only`), diff before the commit. Scope:
`ensureLocalServer` in `apps/desktop/src/main/local-server.ts` ignored the exit
code of `launchctl bootstrap`. After "Restart local server" the plist pointed
to the new runtime copy, but launchd did not know the service; the server
stayed stopped without a message (three times on 2026-11-09, at 21:26, 22:39
and 23:04).

## Cause

Reproduced with a test LaunchAgent whose process takes 2 s to end on SIGTERM:
`launchctl bootout` returns 0 at once while the service is still `SIGTERMed`;
`launchctl bootstrap` fails with `5: Input/output error` until the process has
ended (first success after 2.13 s). The app called `bootstrap` once right after
`bootout`; the old service then finished unloading and nothing was loaded.

## Round 1: retry `bootstrap` 10 × 100 ms

Codex found no bugs: the retry stops at the first success, launchd rejects a
second service with the same label (so exit code 37 must not count as
success), callers handle the error (`index.ts` logs it, `host.ts` shows it in a
dialog). **Replaced afterwards:** the reproduction showed that the load fails
for as long as the old server needs to end, which can be up to launchd's
ExitTimeOut (20 s), not about 1 s.

## Round 2: wait for the unload

After `bootout`, `unloaded()` polls `launchctl print` every 100 ms until the
service is gone, at most 30 s, then `bootstrap` runs once and throws on a
non-zero exit code.

Findings:

1. **[P2] A hanging `launchctl print` is not bounded by the 30 s.** Codex:
   the deadline is checked after `await o.run(...)`, and `run` in `index.ts`
   has no timeout. **Not adopted:** this holds for every `run` call of the
   local server (`bootout`, `bootstrap`, `ditto`, `git`) and did before this
   change; a `launchctl` that never returns was not observed. A timeout for
   `run` would be a change of its own.

No further findings.

## Open

`stop()` (used by `migrateToLocalServer`/`migrateFromLocalServer`) has the same
gap: it moves data right after `bootout`, while the old server may still run,
and a following `ensureLocalServer` may still see the service as loaded and
skip the load. Not changed here.
