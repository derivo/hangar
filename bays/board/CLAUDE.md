# bays/board – Board (`dev.hangar.board`)

Tasks per project of the agent bay in three columns: open, in progress, done
(ADR 0037). The person and agents share them.

## Structure

- `manifest.json` – five `task.*` functions (`openToAgents`, `remote`), `uses`
  `dev.hangar.agents/session.info` and `project.list` (both `bayOnly`).
- `src/main/board.ts` – `Board`: tasks in `<dataDir>/board.json`; `add`,
  `claim`, `note`, `done`, `reopen`, `remove`, `sessionEnded` (tasks in
  progress of the session back to open). Errors `Unknown task`, `Task is done`,
  `Task is taken by session X`.
- `src/main/index.ts` – bus functions (zod, no control characters; title 200,
  description 4000, note 2000), project and name via `session.info`. Only
  agent sessions of the agent bay and other instances may call. Other
  instances name `project` (name of a shared project from
  `project.list`, `shared: true`); otherwise `No such shared project`, with two shared
  projects of the same name `Project name is ambiguous`. UI channels `state`,
  `projects` (`null` if the agent bay does not answer), `add`, `reopen`,
  `done`, `remove`; event `state`.
- `src/ui/` – project choice (in `localStorage`), three columns with cards;
  "Add a task" at the end of the column "Open" opens the form "New task"
  as a card (focus on the title, Esc or "Cancel" closes it, it stays open
  after adding). Asks `projects` anew every 3 s (the view loads at
  app start and gets no visibility event), never two questions at once.

## Functions

| Function     | Effect                                            |
| ------------ | ------------------------------------------------- |
| `task.list`  | tasks of the session's project, `status?` filters |
| `task.add`   | new open task (`title`, `description?`)           |
| `task.claim` | takes an open task for the session                |
| `task.note`  | note on a task that no other session has          |
| `task.done`  | done, `note?`; not for tasks of another session   |

## Pitfalls

- With a local server the board runs there (`IN_SERVER` in
  `apps/desktop/src/main/index.ts`), otherwise it would not see the sessions.
- `session.info` and `project.list` are in `uses` and are not sensitive:
  no permission dialog (ADR 0032, addendum); `e2e/secrets-board.spec.ts` checks
  that none opens. A block in the settings still applies (then
  "The agent bay is missing").
- Failed actions appear as a message above the columns; if the
  project query fails (connection to the server gone), the next round asks again.
- Other instances (ADR 0037, addendum): the holder is
  `remote:<fingerprint>/<session>`, name `<fingerprint, 16 characters> (<workspace>)`.
  The relay carries no session, so a task practically belongs to the
  instance. `session.info` does not know these holders; they therefore are never
  freed automatically – the person reopens them in the UI.
  Integration test over a real relay: `apps/relay/src/board.integration.test.ts`.
- A double click on add, done, reopen, delete takes effect once
  (ADR 0028, `e2e/chaos.spec.ts`).
