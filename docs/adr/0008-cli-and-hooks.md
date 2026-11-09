# ADR 0008 – CLI, shim and Claude Code hooks

Status: accepted

## Context

Agents should set the status, description and status bar of their session – via
MCP tools and via a command line that can also be called from hooks. Users
should neither have to install Node nor write configuration by hand for this.

## Decision

- **CLI without its own server.** `hangar` talks to the same MCP endpoint as the
  agents (`tools/call`, stateless, ADR 0007). One path, one permission check.
- **Shim instead of a separate Node installation.** On start, Hangar writes
  `<userData>/bin/hangar` (sh) or `hangar.cmd`, which start the bundled
  `hangar.mjs` with `ELECTRON_RUN_AS_NODE=1` and Hangar's own binary. The folder
  is at the front of the `PATH` of every session shell.
- **Configuration in the worktree.** On shell start, the agent bay writes
  `.mcp.json` (server `hangar`, URL and token as `${HANGAR_MCP_URL}` /
  `${HANGAR_TOKEN}`, no secrets on disk) and `.claude/settings.local.json` with
  hooks: `UserPromptSubmit` → `working`, `Notification` → `waiting`,
  `Stop` → `done`.
  Addendum 2026-11-02: `Notification` only with a matcher for notices that need
  the person (`permission_prompt`, `elicitation_dialog`,
  `elicitation_url_dialog`, `agent_needs_input`); otherwise `idle_prompt`
  reported "waiting for input" while the agent was waiting for CI in the
  background.
  Existing entries are kept; only hooks that begin with `hangar ` are replaced.
  Both files are added to `info/exclude`.
- **Hooks never block.** Hook commands run with `--quiet` (always exit 0).
  Without `--quiet`, errors end with exit 1, never with 2.

## Consequences

- No Node needed on the machine; the shim points to the installed app. After an
  update, Hangar rewrites it on the next start.
- Packaged, the CLI lives at `resources/cli/hangar.mjs` (electron-builder
  `extraResources`, M8).
- Git has no `info/exclude` per worktree; the entry lands in the repository's
  shared `info/exclude` (`--git-common-dir`) and also hides untracked files of
  this name in the main checkout. Tracked files are not affected.
- Other agents (Codex or similar) use `hangar` directly or `.mcp.json`; hooks
  exist only for Claude Code for now.
