# ADR 0031 – Handovers between agents

Status: accepted (Phase 17; concept: [concept.md](../concept.md) "Coordination and summary", [concept-relay.md](../concept-relay.md) "Handovers")

## Context

An agent should hand work over to another: first within one instance, then to
another instance in the workspace. The concept names two ways: write the task
into a running shell or open a new session.

## Decision

- **Always a new session, never input into a running shell.** Text in a shell is
  a command; a handover – even more so a remote one – would otherwise run
  commands at the recipient. The new session has its own worktree.
- **`dev.hangar.agents/handover.create`** with `task` (1–2000 characters),
  optional `context` (up to 4000), `project` (name), `branch` and `remote`. Not
  sensitive, `remote: true`. Locally the new session's worktree starts on
  `branch` (the sender's branch stays untouched); without `project` in the
  sender's project. Response `{ sessionId }`.
- **Remotely only text and Git references.** Calls from other instances go only
  into projects with "Share in workspaces" and only if the function is on the
  workspace's share list (bus, ADR 0011). `branch` and `remote` are shown,
  never fetched: no `git fetch` with a foreign address. `remote` only
  `https://`, `ssh://` or `git@` (`file://` would read local repositories,
  `ext::` runs commands); `branch` only from `A-Z a-z 0-9 . _ / -`, without a
  leading `-` and without `..` – a safe subset, valid names with `+` or umlauts
  do not work. Task and context without control characters except line break
  and tab (they end up in the terminal); `hangar handover` additionally strips
  them. At most five open sessions from remote handovers; sharing and cap apply
  when the handover's turn comes.
- **Display and reading.** The target session shows "Handover from …" above the
  terminal with task, branch and context; a remote one with the note "text
  only". The agent in it reads it with `handover.get` or `hangar handover`.
- **Sender:** locally the description of the sending session (otherwise branch
  or project), remotely name of the instance and workspace (unknown: the first
  16 characters of the fingerprint).

## Consequences

- No feedback to the sender and no waiting for the result (concept); no arrow or
  history in the sidebar. Both need a phase of their own.
- A remote handover to a specific member is chosen by the agent through the
  function in the bus
  (`remote.<name>-<fingerprint>.dev.hangar.agents/handover.create`).

## Addendum (2026-11-04): ambiguous project names

If two projects (for other instances: two shared ones) carry the same name,
`handover.create` rejects with `Project name is ambiguous` instead of taking the
first by the order in the tree. A local session that names its own project's
name means its own. Same rule as for the board (ADR 0037, addendum).
