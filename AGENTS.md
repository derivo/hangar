# Hangar

Electron desktop app that keeps standalone applications ("bays") in a sidebar
on the left. Main bay: the agent bay (`bays/agents`, id `dev.hangar.agents`) –
shells for AI agent sessions, new ones in the project folder (ADR 0022);
besides it the browser, board and password bays. Specification:
[docs/specification-mvp.md](docs/specification-mvp.md).

## Layout and commands

Packages, commands and startup are in the [README.md](README.md) – maintain them
there, do not repeat them here.

Calling an agent: MCP tool `<bay-id>/<function>` with `Authorization: Bearer
$HANGAR_TOKEN` → the token is mapped to a session → the bus checks permission →
handler in the main part of the bay. Details: [docs/architecture.md](docs/architecture.md).

## Rules

1. **Test first, then code.** Every behavior change starts with a red test.
2. **No change without green tests.** Before every commit: `pnpm lint`,
   `pnpm typecheck`, `pnpm test` (lefthook enforces this in the pre-commit hook).
   For UI or flow changes additionally `pnpm test:e2e`.
3. **Never lower coverage.** 90 % of lines and branches in `packages/*/src`,
   `bays/*/src/main`, `apps/server/src` and in the main process and the preloads
   of the desktop app are enforced in `vitest.config.ts`. Do not touch the
   thresholds.
4. **Decisions as ADRs** in `docs/adr/NNNN-title.md` (numbered consecutively).
5. **Update documentation in the same commit** (package CLAUDE.md, docs/,
   CHANGELOG.md under "Unreleased").
6. No `any` without an explanatory comment directly above it.
7. Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, `test:` …).
8. Tests with Git worktrees run only against temporary repositories
   (`mkdtemp`), never against real projects.
9. **Documentation in English** (ADR 0039): README, `docs/` (ADRs and review
   records included), `CLAUDE.md`, `AGENTS.md`, skills and CHANGELOG. UI texts
   stay German and English (ADR 0009).

## Where to find what

- Every package and every bay has its own `CLAUDE.md` with purpose,
  interfaces and pitfalls – read it before making changes.
- MCP tools: [docs/mcp.md](docs/mcp.md); bay development:
  [docs/bay-development.md](docs/bay-development.md); status:
  [docs/STATUS.md](docs/STATUS.md); next steps:
  [docs/roadmap.md](docs/roadmap.md).
