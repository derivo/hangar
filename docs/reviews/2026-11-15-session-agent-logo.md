# Review: agent logo in the session entry (2026-11-15)

Reviewer: Codex (read-only, `codex exec -s read-only`), on the whole change of
ADR 0045 – `bays/agents/src/main/{agents,sessions,pty}.ts`,
`bays/agents/src/ui/ProjectTree.tsx`, `styles.css`, `logos/`, tests.

## Findings

1. **[P2] `exec claude` showed no logo.** `agentOf` looked only at the shell's
   descendants; `exec` replaces the shell under its pid. Fixed: the shell's own
   command line counts first. Test: `agents.test.ts` "finds an agent that
   replaced the shell (exec claude)" (red before the fix).
2. **[P2] The server image had no `ps`.** `node:24-bookworm-slim` brings no
   `procps`; every read failed with `ENOENT` and was swallowed, so no logos in
   the container. Fixed: `procps` in `docker/server/Dockerfile`. Test:
   `docker/server/smoke.check.ts` "has ps, which the agent bay reads the agents
   in its shells from".

Codex on fixes 1 and 2:

3. **[P2] A shell renamed like an agent (`exec -a claude bash`) hid the real
   agent below it.** Not kept: the fix (descendants first) broke the common case
   of finding 4. A deliberately renamed shell shows that name.
4. **[P2] After `exec codex`, an agent Codex starts (`claude -p`) took over the
   logo** (Codex on fix 3). Fixed by going back to fix 1: the shell's own
   command line counts first. Test: "keeps the agent that replaced the shell
   when it starts another one" (red with fix 3).

Container check of fix 2: `pnpm test:container` without `procps` 1 failed (the
new check), with it 4 of 4 green.

The code is again the version Codex reviewed for fixes 1 and 2; its only finding there is 3.
