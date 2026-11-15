# ADR 0045 – Agent bay: the logo of the AI agent running in a session

Status: accepted 2026-11-15.

## Context

The person runs different AI agents in the sessions of the agent bay (Claude
Code, Codex, OpenCode) and could not see in the project tree which one runs
where. Request (2026-11-15): show the icon of the active AI at the right of the
session entry, with the logos from the makers.

## Decision

- **Detection from the process table.** On every tick (5 s) the manager reads
  `ps -A -o pid=,ppid=,args=` once for all running shells (`listProcesses` in
  `bays/agents/src/main/agents.ts`). Among the descendants of each shell
  (`PtyProcess.pid`) the one closest to the shell decides: the base name of the
  program, or of the script when the program is `node`, `bun` or `deno`
  (Codex is a Node script), without `.js`, `.mjs`, `.cjs` or `.exe`. Known are
  `claude`, `codex` and `opencode`. Only a change emits a new state; reads do
  not overlap; an unreadable table changes nothing.
- **`SessionView.agent`** (`'claude' | 'codex' | 'opencode'`, absent when none
  runs). Not persisted; it goes when the shell ends or restarts.
- **UI:** `ProjectTree` shows the logo in a third grid column of the session
  entry, 16 × 16 px, as `role="img"` named "Claude Code aktiv" ("… running"),
  also as tooltip.
- **Logos:** the makers' files, unchanged (the OpenAI mark without its size and
  class attributes), in `bays/agents/src/ui/logos/`
  (sources and trademark note in its `README.md`): the Claude spark from
  Anthropic's press kit, the OpenAI mark from developers.openai.com (it uses
  `currentColor`, so it follows the theme), OpenCode's light and dark mark from
  opencode.ai/brand, switched by the color scheme. They are inlined (`?raw`)
  so `currentColor` works; they are files of the repository, not page content.

## Alternatives

- **Foreground process name of the pty (`node-pty` `process`):** Codex shows
  as `node`; would need the command line anyway.
- **Hooks of the agents** (`hangar status` from Claude Code hooks): only Claude
  Code has them set up by Hangar; Codex and OpenCode would need their own.
- **Text badges instead of logos:** no trademark question, but the person asked
  for the logos.

## Consequences

- Windows has no `ps`: no logo there. The server image installs `procps` for it;
  a Linux machine set up with ADR 0041 needs `ps` (package `procps`); without it no logo shows.
- An agent started with `exec` replaces the shell; the shell's own command line
  counts first, so agents it starts do not take its place.
- A path with spaces in front of the agent is not recognised (the command line
  is split at spaces).
- The logos are trademarks of their owners; they only identify the program
  running. If a maker objects, `logos/` and `AGENTS` in `ProjectTree.tsx` are the
  only places to change.
