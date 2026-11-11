# Review: Linux package of hangar-server, ADR 0041 step 1 (2026-11-11)

Reviewer: Codex (read-only), before the commit. Scope: `docker/linux-server/`,
`scripts/linux-server-package.mjs`, `docker/server/docker-ssh.mjs`,
`apps/desktop/electron-builder.yml`, the CI and release workflows. Codex could
not run Docker in its sandbox.

## Findings

1. **[P2] libstdc++ not recorded.** Node needs `CXXABI_1.3.11`, node-pty
   `GLIBCXX_3.4.22`; a machine with the right glibc could still fail. Fixed:
   `requirements.json` records both; ADR 0041 now has setup start a shell
   through node-pty with the package's Node before it writes the unit.
2. **[P2] Declared glibc not proven.** The check only compared the declaration
   with a newer machine, so a too low value passed. Fixed: the check requires
   the declared version to equal Rocky Linux 9's glibc (2.34) and node-pty to
   spawn there, and to fail on Debian 11 (2.31).
3. **[P2] `renameSync` across file systems.** The archive was exported to the
   system temp folder and renamed into the checkout (EXDEV). Fixed: exported
   into a folder inside `dist/linux-server`, removed afterwards.
