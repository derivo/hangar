# Review: setup of hangar-server over SSH, ADR 0041 step 2 (2026-11-11)

Reviewer: Codex (read-only), before the commit. Scope: `packages/bridge/src/setup.ts`,
`ServerConnections.pairSetUp` and the port lookup in `open`, IPC
`shell:server.setup` in `apps/desktop/src/main/host.ts`, the dialog in
`Sidebar.tsx`, `docker/linux-machine/`, docs. Codex reproduced three findings in
isolation; it could not run Docker or the UI suites in its sandbox.

## Findings

1. **[P2] Setting up again reported success with a dead connection.** The known
   entry went through `connect()`, which swallows errors: an invalid token (new
   data folder) still returned the id. Fixed: `pairSetUp` tries the stored token
   and, if that fails, pairs with the code just read under the same id and name.
   Test in `apps/server/src/connections.test.ts` (clients removed → same id, new
   token, `invoke` works).
2. **[P2] Parallel setups deleted each other's upload.** Both used `<build>.tmp`
   and started with removing it. Fixed: `<build>.tmp.$$` per upload; a runtime
   another setup finished meanwhile is kept, the temp folder removed.
3. **[P2] Pairing before the server is ready.** `pair-code` and `listen.json`
   appear before the bays are active; `/connect` answers 503 until then. Fixed:
   `Host.setUpServer` pairs through `pairWhenReady` (as the local server does,
   30 s). Test in `host.test.ts` (first attempt fails, second pairs).
4. **[P2] Cancel left the setup running.** Closing only hid the dialog; install
   and pairing went on, the lingering hint was lost. Fixed: while it runs,
   Cancel is disabled and Escape does not close; the status says it runs.
   Aborting a running setup is not offered.
5. **[P2] A greeting of the login shell became the PATH.** Fixed: the probe
   prints `HANGAR_PATH=` on its own line and reads only that line. Test with a
   shell that greets first (red before the fix).
6. **[P2] node-pty errors lost their cause.** The last line of node's stderr is
   its version. Fixed: the `Error: …` line is reported (`errorLine`), e.g. the
   missing libstdc++. Test with node's real output shape (red before).
7. **[P3] STATUS overstated the container check.** It covers the refusals for
   an old glibc and a missing package only; the others are unit tests with
   prepared probe output. Fixed in `docs/STATUS.md`.

No shell injection found: names and addresses never reach a remote script, the
build id and paths come from the package, the PATH is escaped for systemd.
