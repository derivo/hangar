# Review: pnpm overrides for hono and @hono/node-server (2026-11-19)

Reviewer: Codex (`codex exec -s read-only`), one round on the diff of branch
`fix/deps-hono`.

## Context

Dependabot reported seven open alerts on `main` (six moderate, one low), all in two
transitive packages pulled in by `@modelcontextprotocol/sdk` 1.32.2: `hono` 4.13.14
(fixed in 4.13.16) and `@hono/node-server` 2.1.5 (fixed in 2.1.6). An in-range
update would have resolved releases only one to three days old and moved
`@babel/runtime` and `graceful-fs` too. Instead, two pnpm overrides in
`pnpm-workspace.yaml`, next to the existing `minimatch` one, pin the first fixed
releases.

## Findings

No findings. Codex checked the override selectors against the pnpm syntax, confirmed
that only the two packages resolve differently in the lockfile, and that 4.13.16 and
2.1.6 satisfy the SDK ranges (`^4.11.4`, `^1.19.9 || ^2.0.5`).

## Verification

- `pnpm why`: one version each, `hono@4.13.16` and `@hono/node-server@2.1.6`.
- `pnpm lint`, `pnpm typecheck` exit 0; `pnpm test` 1583 passed, 2 skipped.
