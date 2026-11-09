# Hangar – Concept (working title)

> Original concept document. For the scope of the MVP,
> [specification-mvp.md](specification-mvp.md) is authoritative; where the two
> contradict each other, the specification applies.

## Task for the executing agent

This document is a complete specification. Build the MVP of Hangar from it,
from start to finish, without asking questions.

1. Read the whole document before you write any code.
2. The scope is only the MVP section. Everything under "Later" and "Ideas for
   later" is not built, but the architecture must not block it.
3. Work through the MVP milestones in order. A milestone is only done when its
   tests are green and the quality rules are met.
4. Commit after each milestone with a meaningful message (Conventional
   Commits).
5. Where the document leaves something open, make a reasonable decision and
   record it as an ADR in docs/adr/.
6. At the end, pnpm install, pnpm lint, pnpm typecheck, pnpm test,
   pnpm test:e2e and pnpm build must all run without errors.
7. Finish with a short summary in docs/STATUS.md: what was built, known gaps,
   next steps.

## Basic idea

Hangar is a desktop application that serves as a shell for several standalone
applications. Each application runs in its own tab, called a bay. The trigger
is that Supacode switched from the open-source model to a license – the agent
manager is meant to replace it, but is only one of many possible bays.

## Technology

- Electron, so that it runs across platforms
- Each bay runs in its own WebContentsView (isolation, crash protection)
- Sidebar on the left with the bays

## First bay: agent manager

- Replacement for Supacode
- Projects are added once as a folder
- Each agent session works in its own Git worktree
- Terminals via node-pty, rendering with xterm.js

### Layout and behaviour

- Based on the layout of Supacode or Parallel Code
- Left sidebar as a tree: projects, below them the sessions indented with a
  short description
- The agent sets the description itself via MCP, can be overwritten manually
- Status display per session: working, waiting for input, done; "waiting for
  input" triggers a notification
- Each tab is a plain shell in the worktree, no built-in agent
- Environment variables configurable per tab

### Integration with agents

- Hangar injects environment variables such as HANGAR_SESSION_ID, MCP address
  and token into every shell
- Hangar places an MCP configuration for Claude Code in the worktree
- A Hangar CLI reports the status back via Claude Code hooks (e.g. Stop,
  Notification)
- Fallback without hooks: heuristic based on inactivity of the output

### Voice input and Git

- No voice feature of its own: the voice input of Claude Code (hold the space
  bar) must simply work
- For this, Hangar needs the microphone permission on macOS, which the shells
  inherit
- xterm.js passes held keys through to the shell unchanged; no Hangar shortcuts
  on the space bar
- Git handling (merge, pull requests) is done by Claude Code itself, e.g. via
  the gh CLI

### Coordination and summary

- MCP functions of the agent manager: list sessions, hand over a task, query
  status
- Handovers between agents, e.g. from Claude Code to Codex: Hangar writes the
  task as input into the target shell or opens a new session
- The recipient reports the result back to the sender automatically; the sender
  can wait for it
- Handovers are visible in Hangar (arrow in the sidebar or history)
- The summary of all sessions is based on reports that the agents send
  themselves via MCP; no AI evaluation of the terminal output of its own

## Further features

- Restore sessions: after a restart, all shells open in the right worktree,
  including history
- Split view: two or four sessions side by side
- Templates per project: environment variables and start commands as a preset
- Port management: dev servers in different worktrees get their own ports
- Warning when several agents work on the same files

### Status bar

- Fixed status bar at the bottom of every session, similar to Parallel Code
- Shows token usage and remaining quota in the current time window per
  provider (e.g. Claude, Codex), as far as the agent provides it
- Agents can design the status bar themselves via MCP and fill it with their
  own segments, similar to how GSD brings its own status line
- Fallback: Hangar reads local usage data of the agent

Segments of the status bar are sent as structured data:

| Field | Required | Meaning                                            |
| ----- | -------- | -------------------------------------------------- |
| key   | yes      | Unique name of the segment, e.g. worktree or quota |
| value | yes      | The value, e.g. the path or the remaining time     |
| type  | yes      | Display: text, path, bar or badge                  |
| max   | only bar | Maximum value or percentage for the fill level     |

## Ideas for later

- Automatic setup of new worktrees (e.g. copy .env, install dependencies)
- Command palette with Cmd+K to jump between sessions and bays
- Phone view to see status on the go and reply briefly

## Hangar Relay (after the MVP)

Inspired by buzz.xyz: several Hangar instances work together via a relay
server.

- An optional relay server connects the buses of several Hangar instances, also
  across people
- Shared workspaces in which agents of different machines report status,
  summaries and results
- Handovers work across clients, e.g. from your own laptop to an agent at a
  colleague's
- Security: login, end-to-end encryption and the existing permission model for
  remote instances too; remote calls are blocked by default
- Architecture requirement for the MVP: the bus is built so that a remote
  transport can be added later

## Structure of a bay

- Manifest (name, icon, version, offered functions)
- Entry point for the UI
- Optionally a part in the main process (e.g. for terminals)

## Communication between bays

- Central message bus in the main process
- Each bay registers its functions on the bus
- Hangar provides all functions together as a local MCP server
- Agents in terminals connect to this MCP server and can thereby use other bays

## Identifiers and permissions

- Each bay has a unique identifier in reverse-domain style (e.g.
  dev.hangar.agents); the registry ensures uniqueness
- Each session gets a UUID and its own token
- On the first access of one bay to another, Hangar asks
- In the UI, permissions can be set in fine granularity per function, bound to
  bay identifier and session

## State and lifecycle

- Bays manage their state themselves; Hangar only provides a data folder of its
  own per bay
- Bays keep running in the background, also when switching tabs (including
  fetches)
- Central scheduler in the main process for cron jobs, also runs without a
  loaded bay UI
- Hangar keeps running in the background with a tray icon when the window is
  closed

## Notifications

- Bays can send central notifications via Hangar
- Output as a system message and as a badge on the bay in the sidebar

## Developing bays

- Free choice of web framework (React, Svelte, Vue etc.)
- Hangar provides a TypeScript SDK for bus, scheduler and notifications
- Shared theme as CSS variables (colours, fonts, dark mode) that every bay can
  adopt
- also store a blueprint

## Sensitive functions

- Bays can mark individual functions as sensitive
- Sensitive functions are never released automatically for agents via MCP
- Release selectable: once, per session or confirmation on every access

## Planned bays

- Agent manager: replacement for Supacode (see above)
- Browser: full Chromium browser with tabs, bookmarks and history; offers
  functions via MCP such as open page, screenshot and click, so that agents can
  e.g. check their dev server; extensions not supported for now
- Password: password manager of its own, which the browser accesses via the
  bus; functions are marked as sensitive
- RSS (idea): example of cyclic queries via the scheduler

## Registry (separate project)

- Library for downloading bays
- At first, all bays are developed only by the maintainer

## Open points

- Which further bays there should be
- Details on security, permissions and plugin API

## MVP

Goal of the first version: replace Supacode in everyday use.

1. Hangar shell: Electron, sidebar on the left, bays in their own
   WebContentsViews, theme with dark mode
2. Agent bay as the only bay: add projects, sessions as shells in their own
   worktrees, environment variables per tab, restore after restart
3. First MCP server with set description, report status and fill the status bar
4. System notification when an agent waits for input

Later: browser bay, password bay, handovers between agents, scheduler,
fine-grained permissions, registry.

## Project structure

Monorepo with pnpm workspaces and TypeScript; the registry will become a
repository of its own later.

```
hangar/
  apps/
    desktop/            Electron app
      src/main/         Main process: window, bay management, bus, MCP server, tray
      src/preload/      Bridge between bays and main process
      src/renderer/     Shell: sidebar on the left, bay container
  packages/
    sdk/                TypeScript SDK for bays (bus, notifications, status bar)
    bus/                Message bus and types of the bay functions
    mcp/                MCP server that bundles the bay functions
    theme/              CSS variables, dark mode
    cli/                hangar CLI for Claude Code hooks
  bays/
    agents/             Agent bay
      manifest.json     Identifier dev.hangar.agents, name, icon, functions
      src/main/         Shells (node-pty), worktrees, sessions
      src/ui/           UI with xterm.js
```

Tools: electron-vite for build and development, electron-builder for packages
on macOS, Windows and Linux, Vitest for tests.

## Architecture in detail

### Responsibilities of the packages

| Package        | Responsibility                                                             | Depends on                           |
| -------------- | -------------------------------------------------------------------------- | ------------------------------------ |
| apps/desktop   | Starts Electron, loads bays, holds bus, MCP server, tray and notifications | bus, mcp, theme                      |
| packages/bus   | Registers bay functions, forwards calls, checks permissions                | –                                    |
| packages/mcp   | Provides all bay functions as a local MCP server, checks session token     | bus                                  |
| packages/sdk   | API for bays: offer functions, call other bays, notifications, status bar  | bus (types only)                     |
| packages/theme | CSS variables for colours, fonts, spacing, dark mode                       | –                                    |
| packages/cli   | Command hangar for hooks: report status, set description                   | – (talks to the MCP server via HTTP) |
| bays/agents    | Projects, worktrees, shells, sessions, status bar                          | sdk, theme                           |

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
    { "name": "statusbar.set", "sensitive": false }
  ]
}
```

- ui runs in its own WebContentsView, main as an isolated part in the main
  process or as a utility process
- Each function becomes visible via MCP as `<bay-id>/<function>`, e.g.
  `dev.hangar.agents/session.setStatus`

### Flow of a call

1. The agent calls a function via the MCP server and sends its session token
   along
2. The MCP server maps the token to a session and bay
3. The bus checks the permission; on first access, Hangar asks
4. The bus forwards the call to the main part of the target bay and returns the
   result

### Environment of every shell

| Variable          | Content                                         |
| ----------------- | ----------------------------------------------- |
| HANGAR_SESSION_ID | UUID of the session                             |
| HANGAR_TOKEN      | Token for the MCP server                        |
| HANGAR_MCP_URL    | Local address of the MCP server                 |
| HANGAR_PROJECT    | Name of the project                             |
| HANGAR_PORT_BASE  | First free port for dev servers of this session |

In addition come the environment variables that were configured per tab.

### Data of the agent bay

- Projects: name, path to the repository, templates
- Sessions: UUID, project, worktree path, branch, description, status,
  environment variables, scrollback
- Stored in the bay's own data folder, so that sessions are restored after a
  restart

## Milestones for the MVP

1. Electron shell with sidebar and an empty bay
2. Agent bay: add project, start session with worktree and shell
3. Save and restore sessions
4. Bus and MCP server with the three functions of the agent bay
5. hangar CLI and Claude Code hooks for status and description
6. Status bar and system notifications
7. Packages for macOS, Windows and Linux

## Quality and tests

Hangar is later meant to be developed further by agents themselves. Tests are
therefore the safety net and mandatory for every change.

| Level             | Tool                     | Goal                                                                                                          |
| ----------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Unit tests        | Vitest                   | At least 90 % line and branch coverage in packages/* and in the main part of the bays                         |
| Integration tests | Vitest                   | Bus, permissions, MCP server and hangar CLI working together, including a real shell via node-pty             |
| End-to-end tests  | Playwright for Electron  | Every MVP milestone has at least one E2E test (add project, start session, restore, status bar, notification) |
| Component tests   | Vitest + Testing Library | UI of the shell and of the agent bay                                                                          |

- Coverage limits are enforced in the Vitest configuration; falling below them
  makes the build fail
- Git worktrees are tested against temporary repositories in tests, never
  against real projects
- TypeScript in strict mode, ESLint and Prettier, no any without a
  justification
- A pre-commit hook (lefthook or husky) runs lint, typecheck and affected tests
- GitHub Actions: lint, typecheck, tests and build on macOS, Windows and Linux
  on every push and pull request

## Preparation for agentic coding

The repository must be set up so that an agent without prior knowledge can
continue working safely.

### Guidelines

- CLAUDE.md in the root directory (and as AGENTS.md for other agents): project
  purpose, architecture in brief, important commands, rules
- Rules in it: write the test first, then the code; no change without green
  tests; never lower coverage; new decisions as ADR; update documentation in
  the same commit
- A CLAUDE.md of its own in every package and every bay with its purpose,
  interfaces and pitfalls

### Skills

Under .claude/skills/ one skill each with step-by-step instructions and a
checklist:

| Skill              | Purpose                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------- |
| new-bay            | Create a new bay with manifest, UI, main part, tests and documentation                    |
| add-bay-function   | Offer a new function on a bay, register it on the bus, make it available via MCP, test it |
| add-statusbar-type | Add a new display type for the status bar                                                 |
| write-e2e-test     | Write an E2E test for Electron with Playwright                                            |
| release            | Raise the version, write the changelog, build packages                                    |

In addition a generator script `pnpm create:bay <id>`, which the skill new-bay
uses.

### Documentation

- README.md: what Hangar is, installation, starting development
- docs/architecture.md: packages, data flows, flow of a call
- docs/bay-development.md: guide for bay developers with SDK reference
- docs/mcp.md: all MCP functions with parameters and examples
- docs/adr/: architecture decisions, starting with Electron, monorepo and the
  bus–MCP approach
- TSDoc on all public interfaces of the SDK; API reference generated from it
- CHANGELOG.md following Keep a Changelog

## Update routines

Each level updates itself independently and backward compatibly.

| Level    | Mechanism                                                                                                                    | Safeguard                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Hangar   | electron-updater via GitHub Releases, download in the background, installation on the next restart, channels stable and beta | Signed packages, notarized on macOS                                                   |
| Bays     | Version and minimum Hangar version in the manifest, updates later via the registry                                           | New functions or permissions trigger a new approval, old version is kept for rollback |
| Registry | Versioned interface, e.g. v1                                                                                                 | Signed packages with checksums                                                        |
| Relay    | Client and server negotiate the protocol version when connecting                                                             | Server always also supports the previous version                                      |
