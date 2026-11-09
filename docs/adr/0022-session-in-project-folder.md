# ADR 0022 – Sessions in the project folder instead of their own worktree

Status: accepted. Changes the specification (§ Agent bay: "New session").

## Context

Today every session creates a Git worktree with its own branch under
`<dataDir>/worktrees/<project>-<short>`, that is, in Hangar's data folder
(`~/Library/Application Support/Hangar/…`). The shell starts there. For short
tasks, builds or tools that expect the real project folder (local
configuration, `node_modules`, running dev servers) this is impractical: the
person lands in an unfamiliar path and has to change directory first.

Requirement from the person (2026-10-30): first a choice per session; changed
the same day: "New session" always starts in the project folder, without a
second button.

## Decision

- **Always in the project folder:** "New session in …" in the project tree and
  "New session" in the project overview start the shell in the project folder.
  `session.create` from the UI takes only the project ID; the main part always
  creates with `place: 'project'`. Worktree sessions are no longer created;
  existing ones keep running, start again in their worktree after a restart and
  remove it on close as before.
- **In the project folder:** The shell starts in `project.path`. Hangar creates
  no worktree and no branch; `worktreePath` of the session is `project.path`,
  `branch` stays empty, new field `place: 'project'`.
- **Closing:** A session in the project folder removes nothing except shell,
  token and entry. Rebuilding after a restart also starts it in the project
  folder, if it still exists.
- **Several sessions in the project folder** are allowed; they share files and
  branch. The session shows "Project folder" under "Branch". Without a
  description it is named after the first eight characters of its ID, so that
  several sessions of a project stay distinguishable.
- **MCP configuration and hooks** are written by Hangar as in the worktree
  (`.mcp.json`, `.claude/settings.local.json`, entered in `.git/info/exclude`);
  they contain only variables, no tokens, and therefore fit several sessions at
  once. Hangar does not remove them on close, because in the project folder
  they may also belong to the person.

## Limits

- If `.mcp.json` or `.claude/settings.local.json` are versioned in the
  repository, `git status` shows Hangar's addition as a change; `info/exclude`
  only affects unversioned files.
- No isolation: agents in several sessions in the project folder can overwrite
  each other's files.

## Alternatives

- **Choice per session** (second button "⌂"): implemented for one day, rejected
  by the person.
- **Worktrees in the project** (`<project>/.hangar/worktrees/…`) or **next to
  the project**: shorter paths, but still a different folder than the project;
  not chosen by the person.
