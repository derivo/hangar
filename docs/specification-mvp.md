# Hangar MVP – One-shot specification

> Authoritative specification for the MVP. Background and later ideas:
> [concept.md](concept.md).

Build the complete MVP of Hangar from this document, from start to finish,
without follow-up questions.

## 1. Way of working

1. Read the whole document before you write code.
2. Build only what is in section 4 (scope). Section 11 (Out of scope) is not
   built, but the architecture must not block it.
3. Work through the milestones of section 10 in order. A milestone is done only
   when its tests are green and all quality rules of section 8 are met.
4. Write tests first, then code.
5. Commit after every milestone (Conventional Commits).
6. If the document leaves something open, make a reasonable decision and record
   it as an ADR in docs/adr/.
7. At the end, pnpm install, pnpm lint, pnpm typecheck, pnpm test,
   pnpm test:e2e and pnpm build run through without errors.
8. Finish with docs/STATUS.md: what was built, known gaps, next steps.

## 2. Product

Hangar is an Electron desktop app for macOS, Windows and Linux. It is a shell
for several independent applications called bays. Each bay appears as an entry
in a sidebar on the left and runs isolated.

The first and, in the MVP, only bay is the agent bay: a terminal wrapper for
managing local AI agent sessions (for example Claude Code, Codex). Each session
is a shell in its own Git worktree. The model is the layout of Supacode or
Parallel Code.

## 3. Terms

| Term       | Meaning                                                                             |
| ---------- | ----------------------------------------------------------------------------------- |
| Hangar     | The desktop app that loads and connects bays                                        |
| Bay        | Independent application in Hangar with a unique ID                                  |
| Bay ID     | Reverse domain name, for example dev.hangar.agents; unique                          |
| Project    | A Git repository that was added as a folder in the agent bay                        |
| Session    | A shell in its own worktree of a project, with a UUID                               |
| Bus        | Central message bus in the main process through which bays offer and call functions |
| MCP server | Local server that provides all bay functions for agents                             |

## 4. Scope of the MVP

### Hangar shell

- Electron app with a sidebar on the left; each bay runs in its own
  WebContentsView
- Loads bays from bays/ based on their manifest
- Shared theme as CSS variables (colors, fonts, spacing) with dark mode, which
  bays adopt
- Keeps running in the background with a tray icon when the window is closed;
  bays and shells keep running
- System notifications and badges on the bay in the sidebar
- Own data folder per bay; the bay manages its state itself
- On macOS, microphone permission (NSMicrophoneUsageDescription), so that shells
  inherit it

### Agent bay

- Add and remove projects as folders
- Sidebar as a tree: projects, below them indented the sessions with a short
  description and status
- New session: creates a Git worktree with its own branch and starts the user's
  default shell in it (since ADR 0022: starts in the project folder, without a
  worktree)
- Terminal through node-pty, rendered with xterm.js
- Environment variables configurable per session
- Description per session: set by the agent through MCP, manually overridable
- Status per session: working, waiting, background (ADR 0035), done, idle;
  fallback heuristic: no output for 30 seconds yields idle
- On waiting, a system notification and a badge
- Status bar at the bottom per session, filled through MCP (see section 6)
- Sessions are saved and restored after a restart: shell in the right worktree,
  description, environment variables, scrollback
- Keyboard input is passed through to the shell unchanged; Hangar binds no
  shortcuts to the space bar, so that the voice input of Claude Code (hold space
  bar) works
- No Git handling of its own such as merge or pull requests; the agent handles
  that itself

### Agent integration

Every shell gets these environment variables on start:

| Variable          | Content                                         |
| ----------------- | ----------------------------------------------- |
| HANGAR_SESSION_ID | UUID of the session                             |
| HANGAR_TOKEN      | Token of the session for the MCP server         |
| HANGAR_MCP_URL    | Local address of the MCP server                 |
| HANGAR_PROJECT    | Name of the project                             |
| HANGAR_PORT_BASE  | First free port for dev servers of this session |

- Hangar places an MCP configuration for Claude Code in the worktree that points
  to HANGAR_MCP_URL
- Hangar sets up Claude Code hooks in the worktree (Stop, Notification,
  UserPromptSubmit) that report the status through the hangar CLI
- The hangar CLI offers: `hangar status <working|waiting|background|done|idle>`,
  `hangar describe "<Text>"`,
  `hangar statusbar set <key> <value> --type <type> [--max <n>]`

## 5. Architecture

### Repository

Monorepo with pnpm workspaces, TypeScript in strict mode.

```
hangar/
  apps/desktop/          Electron app (main, preload, renderer)
  packages/bus/          Message bus, permissions, types
  packages/mcp/          MCP server on top of the bus
  packages/sdk/          TypeScript SDK for bays
  packages/theme/        CSS variables, dark mode
  packages/cli/          hangar-CLI
  bays/agents/           agent bay (manifest.json, src/main, src/ui)
  docs/                  Documentation and ADRs
  .claude/skills/        Skills for agents
```

Tools: electron-vite, electron-builder, Vitest, Playwright, ESLint, Prettier,
lefthook.

### Tasks of the packages

| Package        | Task                                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| apps/desktop   | Starts Electron, loads bays, holds bus, MCP server, tray and notifications                                                        |
| packages/bus   | Registers bay functions, forwards calls, checks permissions; transport replaceable, so that a remote transport can be added later |
| packages/mcp   | Provides all bay functions as MCP tools, maps tokens to sessions                                                                  |
| packages/sdk   | API for bays: offer functions, call other bays, notifications, badges                                                             |
| packages/theme | Design tokens as CSS variables                                                                                                    |
| packages/cli   | Command hangar, talks to the MCP server through HANGAR_MCP_URL                                                                    |
| bays/agents    | Projects, worktrees, shells, sessions, status bar                                                                                 |

### Manifest of a bay

```json
{
  "id": "dev.hangar.agents",
  "name": "Agents",
  "version": "0.1.0",
  "icon": "icon.svg",
  "ui": "dist/ui/index.html",
  "main": "dist/main/index.js",
  "functions": [
    { "name": "session.setDescription", "sensitive": false },
    { "name": "session.setStatus", "sensitive": false },
    { "name": "statusbar.set", "sensitive": false },
    { "name": "statusbar.remove", "sensitive": false }
  ]
}
```

The manifest is validated on load (for example with zod). Duplicate bay IDs lead
to an error.

### Flow of a call

1. An agent calls an MCP tool and sends its session token along.
2. The MCP server maps the token to a session.
3. The bus checks the permission (section 7).
4. The bus forwards the call to the main part of the target bay and returns the
   result.

MCP tools are named `<bay-id>/<function>`, for example
`dev.hangar.agents/session.setStatus`.

## 6. Status bar

Agents fill the status bar with structured segments; Hangar renders them
uniformly.

| Field | Required | Meaning                                                   |
| ----- | -------- | --------------------------------------------------------- |
| key   | yes      | Unique name of the segment, for example worktree or quota |
| value | yes      | Value, for example path or remaining time                 |
| type  | yes      | text, path, bar or badge                                  |
| max   | for bar  | Maximum value for the fill level                          |

A segment with the same key overwrites the old one. Typical use: token
consumption and remaining quota per provider in the current time window.

## 7. Permissions

- Permissions attach to the combination of calling bay or session and target
  function
- Functions of the agent bay for the own session are always allowed in the MVP
- On the first access of one bay to another, Hangar asks by dialog; the decision
  is saved
- Settings page: view and revoke permissions per function
- Functions marked sensitive are never automatically released to agents through
  MCP; release selectable as once, per session or confirmation on every access

## 8. Quality and tests

| Level             | Tool                       | Goal                                                                       |
| ----------------- | -------------------------- | -------------------------------------------------------------------------- |
| Unit tests        | Vitest                     | At least 90 % line and branch coverage in packages/* and bays/*/src/main   |
| Integration tests | Vitest                     | Bus, permissions, MCP server and CLI together, real shell through node-pty |
| Component tests   | Vitest and Testing Library | UI of the shell and of the agent bay                                       |
| End-to-end tests  | Playwright for Electron    | At least one test per milestone                                            |

- Coverage thresholds are enforced in the Vitest configuration
- Worktree tests run against temporary repositories
- No any without a justifying comment
- lefthook runs lint, typecheck and affected tests before every commit
- GitHub Actions: lint, typecheck, tests and build on macOS, Windows and Linux
  on every push and pull request

## 9. Preparation for agentic coding

Hangar will later be developed further by agents. The repository must make that
possible without prior knowledge.

### Guidelines

- AGENTS.md in the root directory with purpose, flow of a call, rules and
  references; structure and commands are only in the README. CLAUDE.md includes
  AGENTS.md through `@AGENTS.md` and contains only Claude-specific parts
  (skills)
- Rules: test first, then code; no change without green tests; never lower
  coverage; decisions as ADRs; update documentation in the same commit
- Own CLAUDE.md in every package and every bay with purpose, interfaces and
  pitfalls

### Skills under .claude/skills/

| Skill              | Purpose                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------ |
| new-bay            | Create a new bay with manifest, UI, main part, tests and docs; uses `pnpm create:bay <id>` |
| add-bay-function   | Offer a function on a bay, register it in the bus, make it available through MCP, test it  |
| add-statusbar-type | Add a new rendering type for the status bar                                                |
| write-e2e-test     | Write an E2E test for Electron with Playwright                                             |
| release            | Raise the version, write the changelog, build packages                                     |

### Documentation

- README.md: purpose, installation, starting development
- docs/architecture.md: packages, data flows, flow of a call
- docs/bay-development.md: guide for bay developers with SDK reference
- docs/mcp.md: all MCP tools with parameters and examples
- docs/adr/: starting with Electron, monorepo and the bus-MCP approach
- TSDoc on all public interfaces of the SDK, API reference generated from it
- CHANGELOG.md following Keep a Changelog

## 10. Milestones

| No. | Milestone                                                           | Done when                                                                                 |
| --- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | Repository, tools, CI, CLAUDE.md, skills scaffold                   | pnpm lint, typecheck, test run in CI on all three platforms                               |
| 2   | Electron shell with sidebar, theme and a test bay                   | E2E test: app starts, bay appears in the sidebar and can be opened                        |
| 3   | Agent bay: add project, session with worktree and shell             | E2E test: add project, start session, run a command in the shell                          |
| 4   | Save and restore sessions                                           | E2E test: restart restores session with worktree and scrollback                           |
| 5   | Bus, permissions and MCP server                                     | Integration test: MCP call with token changes description and status                      |
| 6   | hangar CLI, MCP configuration and Claude Code hooks in the worktree | Integration test: CLI commands in a shell change the status                               |
| 7   | Status bar, notifications, badges, tray                             | E2E test: status waiting produces notification and badge; status bar shows all four types |
| 8   | Documentation, flesh out skills, build packages                     | electron-builder produces packages for all three platforms; docs/STATUS.md exists         |

## 11. Out of scope

These items are not built. The architecture must allow them later without a
rebuild.

- Further bays: browser (full-featured, controllable through MCP), password
  manager (functions sensitive), RSS
- Handovers between agents with feedback and summary of all sessions
- Central scheduler for cron jobs of bays
- Registry for downloading bays (own repository)
- Hangar Relay: connecting several Hangar instances through a relay server
- Shared view, templates per project (start commands; environment variables for
  new sessions already exist), warning on file conflicts, automatic worktree
  setup, command palette, terminal search, phone view

### Updates in the MVP

The MVP contains the auto-update for Hangar and version fields in the bay
manifest; registry and relay follow later.

- Hangar updates itself through electron-updater with GitHub Releases: download
  in the background, installation on the next restart, channels stable and beta.
- Packages are signed, on macOS additionally notarized. Precondition: Apple
  Developer account.
- The bay manifest contains version and minHangarVersion. Hangar does not load a
  bay whose minimum version is not met, and reports that in the UI.
- Bay updates through a registry are not part of the MVP.
