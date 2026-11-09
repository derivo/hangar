# ADR 0037 – Board bay: tasks per project for humans and agents

Status: accepted 2026-11-04. Extends [ADR 0016](0016-open-functions-and-session-end.md),
[ADR 0021](0021-password-bay.md) (`bayOnly`) and
[ADR 0036](0036-shells-survive-restart.md).

## Context

When several agents run in the same repository, a shared place for the work is
missing: what is open, who works on what, what is done. Requirements from the
person (2026-11-04): tasks belong to a project of the agent bay; agents may
create tasks themselves.

## Decision

- **New bay `dev.hangar.board`** ("Board") in `bays/board`, without host
  modules. Storage `<dataDir>/board.json`.
- **Task:** identifier, project, title (at most 200 characters), description (at
  most 4000), status `open` → `doing` → `done`, the session that took it, notes
  (at most 2000 characters per note), timestamps.
- **Functions for agents** (all `openToAgents`, only callers with a session of
  the agent bay): `task.list`, `task.add`, `task.claim`, `task.note`,
  `task.done`. An agent sees and changes only tasks of its session's project. A
  task that another session has taken cannot be taken, annotated or completed by
  it.
- **Project of the session:** The board bay asks the agent bay with
  `dev.hangar.agents/session.info` (`{ sessionId }` → project and name of the
  session); the list of projects for the UI comes from
  `dev.hangar.agents/project.list`. Both `bayOnly` (ADR 0021).
- **Session end:** When a session ends, its tasks in `doing` go back to `open`
  (ADR 0016).
- **UI:** choose a project, three columns "Open", "In progress", "Done"; create
  a task, back to "Open", complete, delete; notes and session visible. Without
  the agent bay it says that it is missing.
- **Location:** With a local server the bay runs there next to the agent bay
  (the server loads all bundled bays without a missing host module); the app
  then does not start it itself. The move between app and server
  (ADR 0036, point 8 and 4b) takes its data along like that of the agent bay.

## Consequences

- Agent bay: two new functions for bays only.
- `migrateToLocalServer`/`migrateFromLocalServer` take a list of bays.

## Alternatives

- **One list for all projects:** simpler, but every agent would see foreign
  tasks; rejected.
- **Project as the agent's argument:** no query to the agent bay needed, but an
  agent could name any project; rejected.
- **Release of a task by the agent (`task.release`):** the end of the session
  releases it, the UI resets it; possible later.

## Addendum (2026-11-04): agents of other instances

- The five `task.*` functions are `remote: true`. Like any remote function they
  run only if the workspace has them on its share list (ADR 0011).
- A remote caller has no session of the agent bay. It therefore names the
  project in the argument `project` (name). The board bay accepts it only if
  `project.list` reports it with `shared: true` – the same boundary as for
  handovers (ADR 0031). If two shared projects carry the same name, it rejects
  instead of choosing by the order in the tree. The rejection of "project as the
  agent's argument" above still applies for local sessions; for other instances
  the project's sharing limits what they can name.
- `project.list` returns `shared` for this.
- The holder of a task is `remote:<fingerprint>/<session>`. The relay does not
  transmit the caller's session; the task thus belongs to the instance. Such
  tasks are never released by the board on its own (no session end reaches it);
  the person reopens them.
