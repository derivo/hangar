# ADR 0002: Monorepo with pnpm workspaces

- Status: accepted
- Date: 2026-10-28

## Context

Shell, bus, MCP server, SDK, theme, CLI and bays are developed together and
share types. Agents should be able to work on the repository without prior
knowledge.

## Decision

- One repository with pnpm workspaces (`apps/*`, `packages/*`, `bays/*`).
- Internal packages export their TypeScript source directly
  (`"exports": "./src/index.ts"`); bundling happens only in the app or bay
  (Vite). Only the CLI is built separately to `dist/`, because it runs as its
  own program.
- One shared `tsconfig.json`, one Vitest configuration with two projects
  (`node`, `ui`) and one ESLint configuration for the whole repository.
- `node-linker=hoisted`, because electron-builder expects a flat
  `node_modules`.

## Consequences

- One `pnpm typecheck` and one `pnpm test` cover everything.
- Packages cannot be published individually; this is not needed in the MVP. For
  a published SDK, a separate build step would have to be added.
