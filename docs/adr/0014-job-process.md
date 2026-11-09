# ADR 0014 – Jobs of the agent bay as a separate process

Status: accepted. Changes the "Agent bay" section of
[ADR 0013](0013-scheduler.md).

## Context

According to ADR 0013, a job types its command into the visible shell of the
session and waits for a marker with `$?`. The codebase review of 2026-10-29
([findings 2 and 10](../reviews/2026-10-29-codebase.md)) shows the consequences:

- Unsent input at the prompt mixes with the command.
- If a program is running, for example an agent, it receives the command as
  input.
- If the marker never appears, the job counts as running forever.
- Under `cmd.exe` there is no `$?`; on Windows, jobs never finish.

## Decision

- **Own process per run:** A job starts the session's shell as its own child
  process without a terminal: in the session's worktree and with the same
  environment as its shell, that is with token, ports and session variables.
  Exit code and output come directly from the process; marker and `$?` are
  dropped.
- **Invocation per shell:** POSIX shells are started with their login arguments
  and `-c <command>`, so that the profile (`PATH`) applies as in the session.
  `cmd.exe` runs with `/d /s /c "<command>"`, PowerShell with
  `-NoProfile -Command <command>`.
- **Standard input is empty:** A command that reads gets end of file
  immediately and does not wait.
- **Time limit:** 60 minutes per run. After that, the process is terminated,
  under POSIX together with its process group, and the run counts as failed
  ("aborted after 60 minutes").
- **Independent of the session's shell:** A restart of the shell does not affect
  running jobs. If the session closes, its running jobs are terminated and its
  jobs deleted. To start, a job needs a session whose shell has been started
  once, because only then are there an environment and a token.
- **Visibility:** The result is shown in the settings under "Jobs" (exit code and
  last output line). Nothing appears in the session's terminal: Foreign output
  would overwrite a running program in the terminal.

## Alternatives

- **Keep typing into the shell, but only after checking the state:** Whether the
  prompt is empty and no program is running cannot be detected reliably through
  a PTY.
- **Own invisible PTY per run:** The command does not need a terminal, and color
  codes and progress bars would have to be filtered out again.
- **Output additionally into the session's terminal:** This is convenient, but
  destroys the display if a full-screen program is running there.

## Consequences

- Jobs work independently of what is currently running in the session, and with
  every supported shell. On Windows they are unchecked (no Windows run
  available).
- A job that needs interactive input fails instead of waiting.
- After a failed restoration, the session's jobs run only once its shell has been
  restarted.
- If the session's shell restarts while a job is running, the job keeps the old
  token; it is then invalid, and `hangar` commands in the job fail.
- Child processes that detach themselves from their process group survive the
  time limit under POSIX; on Windows only the shell is terminated.
