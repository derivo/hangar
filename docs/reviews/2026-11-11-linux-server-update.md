# Review: update, restart and removal of a server set up over SSH, ADR 0041 steps 3 and 4 (2026-11-11)

Reviewer: Codex (read-only), before the commit. Scope: `serverUpdate`,
`uninstallServer`, `serverLog` and the runtime cleanup in
`packages/bridge/src/setup.ts`, `ServerConnections.setUpAt`, `Host.install`,
`checkServerUpdates`, `restartServer`, `removeServer` and the server menu in
`apps/desktop/src/main/host.ts`, the hint in `App.tsx` and `Sidebar.tsx`,
`docker/linux-machine/setup.check.ts`, docs. Codex reproduced findings 1, 3, 4
and 5 in isolation; it could not run Docker or the UI suites.

## Findings

1. **[P1] Uninstall deleted even when stopping failed.** `disable --now` ran
   with `|| true`, so a server still running lost its runtime (and its data
   when ticked). Fixed: under `set -e`, an installed unit must stop before
   anything is deleted; without a unit file nothing needs to stop.
2. **[P1] Cleanup could delete another build that runs.** Two apps installing
   different builds for the same user: one's cleanup kept only its own build.
   Fixed: the build the unit starts at cleanup time is kept too. Left: a
   build another app has just unpacked but not yet put into the unit can still
   go; that app's setup then fails with a message (no user data is lost).
3. **[P1] Removing during a restart was undone.** The restart paired again
   after the pairing was removed. Fixed: removing waits for a running restart
   of that server. Test in `host.test.ts` (asked only after the restart).
4. **[P2] A late build comparison brought back a hint.** The comparison at
   start answered after an install had cleared it. Fixed: results of a
   comparison started before an install are dropped. Test in `host.test.ts`.
5. **[P2] Setting up again did not publish the cleared hint.** Fixed:
   `install` pushes the state. Test in `host.test.ts` (sent state without
   hint).
6. **[P2] The container check expected the first package's build.** With both
   packages built, that is the other architecture on CI. Fixed: it expects the
   build actually installed.
