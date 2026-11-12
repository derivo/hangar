# Review: old runtime copies of the local server only go once it is gone (2026-11-12)

Reviewer: Codex (read-only), two rounds before the commit. Scope:
`ensureLocalServer` in `apps/desktop/src/main/local-server.ts` and
`local-server.test.ts`. Found in the maintenance review of 2026-11-11: the copy
of the old build was deleted before `bootout`, against ADR 0036 point 1. Codex
reproduced every finding with the real function against a simulated file
system and launchctl; no real launchd run.

## Findings

1. **[P1] The next start still deleted the running copy** (round 1). Moving
   the cleanup after a successful `bootstrap` protected the failed restart
   itself, but the plist already named the new copy: the next
   `ensureLocalServer` kept it, found the service loaded and deleted the copy
   the old server still ran from. Fixed: a failed `bootstrap` writes the
   previous plist back, so the plist always names the program launchd runs.
   Test: after the failed restart a second call reports `1.1.0` and keeps it.
2. **[P2] Writing back a plist whose copy is gone** (round 2). When the old
   copy was missing, the new plist was valid and the old one could not start
   at the next login. Fixed: written back only when the old program still
   exists. Test: copy gone, load fails, the plist names `1.2.0`.

Accepted: after a failed restart where `bootout` did succeed, the next start
loads the old build again; "Restart server" tries the new one.

## Verification

`pnpm exec vitest run apps/desktop/src/main/local-server.test.ts`: 47 passed.
