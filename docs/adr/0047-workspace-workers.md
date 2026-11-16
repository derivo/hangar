# ADR 0047 – Workers: Hangar servers that work the person's board

Status: proposed 2026-11-16. Builds on [ADR 0046](0046-workspace-inbox-and-activity-log.md)
(inbox, trust, log), [ADR 0037](0037-board-bay.md) (board over workspaces),
[ADR 0018](0018-headless-server.md) and [ADR 0041](0041-remote-linux-server.md)
(server on Linux machines).

## Context

The person wants to run AI agents on several virtual machines (for example
three), connect them to the relay and let them work the tasks the person gives
them. Most parts exist: a Hangar server without a UI on a Linux machine, set up
from the app; workspaces on the server; a board whose `task.*` functions other
instances call; claiming a task locks it for one holder. Missing are a loop that
starts an agent for a task, a way back for the result, and a rule that a worker
takes work only from its owner.

## Decision

- **A worker is a Hangar server** (ADR 0018, 0041) that is a member of the
  person's workspace and trusts exactly one member, its owner, with "accept
  automatically" (ADR 0046). It never takes work from other members.
- **The owner's board is the queue.** The owner shares the project and the
  `task.*` functions with the workspace. A worker takes only open tasks whose
  origin is the owner's instance (tasks created there, by the person or the
  owner's agents); tasks other members created are skipped. For this the board
  stores the creator of every task (`origin`, from ADR 0046).
- **Worker setting per project on the server** (agent bay, `worker` in the
  project): owner fingerprint, agent command, maximum parallel tasks (default
  1), time limit (default 60 minutes, as jobs).
- **The loop**, in the agent bay of the server: when a slot is free, on the
  owner's board state and at the latest every 5 minutes:
  1. `task.claim` the oldest matching open task (the board's lock prevents two
     workers from taking it);
  2. open a new session in its own worktree on branch `hangar/task-<id>` from
     the freshly fetched default branch (a worktree per task, so parallel slots
     never share a working tree);
  3. run the agent command non-interactively in it (for example
     `claude -p "$(hangar task)"`), `hangar task` printing the task with its
     origin;
  4. exit code 0: push the branch, `task.note` with branch and the last lines of
     the output, `task.done`; otherwise `task.note` with the error and
     `task.release`;
  5. the session stays for the person to inspect, until closed or after 7 days.
- **Results come through Git**, not the relay: the worker pushes branches to
  the project's remote with a credential that can push branches but not the
  default branch (deploy key or token, held in the password bay, ADR 0021). The
  person reviews and merges; a worker never merges.
- **Visible to the person:** the worker's sessions are shared in the workspace
  (status live), the board shows the holder `remote:<fingerprint>/…` and the
  notes, the activity log (ADR 0046) lists every claim, note and completion.
- **Running reliably:**
  - _The queue must be reachable:_ the owner's board runs in the owner's local
    server (ADR 0036), which outlives the closed app; workers wait while the
    owner is offline and retry with backoff (30 s up to 10 min).
  - _Lease instead of forever:_ a claim carries a lease of the time limit plus
    10 minutes; the worker renews it every minute (`task.note` is not used for
    this, a new `task.renew`). An expired lease makes the task open again, so a
    worker machine that dies does not hold work forever.
  - _Restart of a worker:_ on start it lists its own claimed tasks; one whose
    session still runs is resumed, any other is released with a note.
  - _Connection lost during a run:_ the run goes on; note, done and release are
    kept in a local outbox (`<data>/worker-outbox.json`) and sent once the relay
    is back, in order, each once (idempotent by task id and step).
  - _Cancelled by the owner:_ if the owner reopens, edits or deletes a claimed
    task, the worker stops the run (SIGTERM, after 10 s SIGKILL), keeps the
    branch unpushed and notes "cancelled".
  - _Limits of the provider:_ an agent exit that reports a usage limit (the
    quota read of ADR 0024 or a known exit message) releases the task and
    pauses the worker until the reported reset.
  - _Branch exists already_ (a task run twice): `hangar/task-<id>-<n>`; pushing
    never forces.
  - _Health:_ the worker publishes its state in the workspace (idle, busy with
    task, paused until, error, version); the owner sees it next to the board.
    Different protocol versions refuse with a clear message (as the bridge).
  - _Disk:_ worktrees of done tasks are removed after 7 days or when free space
    drops below 2 GB, oldest first; output logs per task stay 30 days.
- **Credentials for the agent** come from the password bay as environment
  variables (for example `ANTHROPIC_API_KEY`), never from files in the project.

## Corrections from the design review (Codex, 2026-11-16)

These override the decision above where they differ.

- **Claim per attempt.** `task.claim` changes a task only from `open` (also for
  the same holder) and returns a `claimId` together with the task's revision.
  `task.renew`, `task.release` and the new `task.finish` require both; a stale
  `claimId` or revision is rejected. Two slots of one worker therefore never run
  the same task, and a late message of an expired attempt changes nothing.
- **One atomic result call.** `task.finish({ claimId, outcome: "done" |
"released", note })` replaces the separate note and done/release; the outbox
  sends exactly this call, keyed by `claimId`. A rejection (stale attempt) is
  logged and dropped.
- **No push without a fresh lease.** The worker pushes only after a successful
  renew within the last 2 minutes; offline it keeps the branch local, so a task
  cancelled while it was offline never gets a pushed result.
- **Call path and rights.** A worker's agent bay calls the owner's board through
  a new manifest entry `uses: ["remote:dev.hangar.board/task.*"]`, resolved only
  to the owner from the worker setting by full fingerprint and workspace, never
  by name. Setting up the worker stores the grant on the worker side (no dialog
  on a headless server) and on the owner side the share list and the trust of
  ADR 0046.
- **Credentials on the server.** The password bay needs the desktop's keychain
  and does not run on the server. Workers read the agent's key and the Git
  credential from an environment file of the service (`EnvironmentFile=`, mode
  600, outside every project; the server removes the variables from the session
  environment except for the worker run). A server-side secret store is a later
  decision.
- **Persistent run record** `<data>/worker-runs.json` per attempt: `claimId`,
  task, session, process id, phase (`claimed`, `running`, `agentExited` with
  code, `pushed`, `finished`). After a restart: `running` without that process
  releases; `agentExited` continues with push and finish; `pushed` finishes. A
  restored shell is no proof of a running agent.

## Alternatives

- **A scheduled job per machine** (`claude -p "take the next task"` every few
  minutes): no lock handling, no branch per task, no rule about the origin; the
  agent itself decides what to take.
- **Handovers to the workers instead of a board:** the owner would have to pick
  a worker per task; no load sharing, no lock.
- **Workers connected to the owner's desktop directly:** needs the desktop
  online and reachable; the relay already solves that.

## Consequences

- Workers run with the owner's trust: an owner's task is carried out without a
  person on the machine. Tasks are text from the owner only; the inbox keeps
  everyone else out. A worker machine holds nothing but the project and its
  credential.
- Using subscriptions of AI providers on unattended machines may break their
  terms (several personal subscriptions for parallel automated work in
  particular). To be checked per provider before rollout; API keys or business
  plans are the intended way for automation.
- The board gains `origin` per task, `task.release` (ADR 0037 rejected it for
  local agents; it is only for remote holders) and `task.renew` with a lease;
  `docs/mcp.md` and the board's `CLAUDE.md` change.
- Windows workers are not planned (the agent bay finds no processes there, the
  server runs on Linux).

## Plan

Requires ADR 0046 steps 1–4. Each step: red test first, Codex review, record in
`docs/reviews/`.

1. **Board:** `origin` per task and note from the caller, claim only from
   `open` with `claimId` and revision, `task.renew`, `task.release`,
   `task.finish`, lease expiry, cancel signal when the owner changes a claimed
   task. Unit tests, integration test over a real relay.
2. **`hangar task`** in the CLI: prints the session's task with origin. CLI
   test.
3. **Worker setting** in the agent bay project (owner, command, slots, time
   limit), remote `uses` with grant provisioning, environment file for
   credentials; UI on the paired desktop. Unit and component tests.
4. **Loop** in the agent bay: claim, worktree on branch, run, push, note, done
   or release; time limit; slots; lease renewal; outbox; run record and restart
   recovery per phase; push only with a fresh lease;
   cancel; usage-limit pause; branch suffix; disk cleanup; health state. Unit
   tests per case with a fake board, a fake clock and a temporary repository
   (`mkdtemp`, rule 8).
5. **Integration test** in `apps/relay`: owner instance with board, two worker
   instances; four tasks, each done once, branches pushed to a temporary bare
   repository, a task of a third member skipped; chaos cases: relay restart
   during a run (outbox delivers), a worker killed (lease expires, the other
   takes the task), the owner cancels a running task.
6. **Container test:** worker in the server image with a stub agent command.
7. **Docs:** `docs/server-operations.md` (setting up a worker), `docs/mcp.md`,
   CHANGELOG, STATUS; this ADR to "accepted".
8. **Real run** as in the relay test plan: public relay, three worker machines,
   ten tasks, result branches reviewed by the person.
