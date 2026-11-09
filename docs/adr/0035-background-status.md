# ADR 0035 – Status "waiting on background"

Status: accepted (basis: [ADR 0005](0005-sessions-and-worktrees.md),
[ADR 0008](0008-cli-and-hooks.md))

## Context

If an agent waits in the background, for example for CI, its response ends: the
`Stop` hook reported `done`, and after about 60 seconds the notification
`idle_prompt` set "waiting for input". Both are wrong: the agent continues by
itself as soon as the background task is finished.

Measured with `claude -p` and logging hooks (2026-11-02): The `Stop` hook gets
`background_tasks`, in it per running task
`{ id, type: "shell", status: "running", … }`. When it is finished, Claude Code
continues with a `UserPromptSubmit` (`<task-notification>`); the next `Stop` has
an empty `background_tasks`.

## Decision

- New status `background` ("waiting on background", short "background").
- The `Stop` hook calls `hangar --quiet status done --hook`. With `--hook` the
  CLI reads the hook's input from stdin; if a task is running in
  `background_tasks` (`status: "running"`), it reports `background` instead of
  `done`. Unreadable input results in `done`.
- `UserPromptSubmit` on continuing sets `working` as before.
- No notification, no badge, the heuristic does not change `background`.
- Light: dashed ring in the color of "working"; the shape distinguishes the
  status, not only the color (WCAG 1.4.1).
- `idle_prompt` no longer sets a status (ADR 0008, addendum).

## Consequences

- If the person quits Claude Code while a background task is running,
  `background` stays until the shell reports another status (as `done` did
  before).
- An older Hangar instance in the same workspace does not know `background` and
  omits this session in "Other instances" (`remoteProjects` checks the status).
- Background agents (instead of Bash) and interactive sessions are not
  measured; according to the docs Claude Code also lists them in
  `background_tasks`.
