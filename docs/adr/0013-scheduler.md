# ADR 0013 – Scheduler for jobs

Status: accepted. The "Agent bay" section is superseded by
[ADR 0014](0014-job-process.md).

## Context

Bays should run work at fixed times, for example tests every night in a session
of the agent bay, even if the bay's interface is not loaded. The same code should
later run on a server without Electron ([concept-server.md](../concept-server.md)).
Jobs run only while Hangar runs (also in the tray); an operating-system service
is not a goal.

## Decision

- **Own package without Electron:** `packages/scheduler` with a cron parser and
  `Scheduler`. The host creates it with `<userData>/jobs.json`, bays reach it
  through `ctx.jobs`.
- **Time expression:** Cron with five fields (minute, hour, day, month, weekday)
  with `*`, numbers, lists, ranges and steps; weekday 0–7 (0 and 7 = Sunday). If
  day and weekday are both restricted, one match is enough (like Vixie cron). No
  names (`MON`, `JAN`), no macros (`@daily`).
- **Own parser instead of a library:** about 80 lines, fully tested; a dependency
  for five fields is not worth it.
- **Time zone:** Expressions apply in the local time of the process. The next run
  is recomputed on every check, so a change of time zone (`TZ`) takes effect
  immediately.
- **Daylight saving time:** A time of day that does not exist because of the
  switch (02:30 in March) is skipped on that day. A duplicated time of day (02:30
  in October) runs only once: A run counts only if its local time of day is after
  that of the previous one.
- **Check instead of a timer per job:** Every 15 seconds the scheduler checks
  whether a due time has occurred for a job since its reference point (creation,
  last run, resume). After sleep, a missed run is made up exactly once, no matter
  how many due times lay in between.
- **One run at a time:** If a job is still running, it is not started again.
- **Handler per bay:** A bay registers a handler for all its jobs with
  `ctx.jobs.onRun`; jobs carry data (`payload`), not code. Jobs of a bay without
  a handler (not loaded, uninstalled) do not run, but stay stored and appear in
  the list as "Bay not loaded".
- **Result:** Time, duration, success and a short output (at most 500
  characters). The handler reports success with a text, failure with an
  exception.
- **Agent bay:** A job writes a command into a session's shell and, in a second
  line, `echo "<Marke>:$?"`, and waits for the marker. The result is the exit
  code with the last output line. If the session closes, its jobs are deleted.
  Agents create jobs of their session via `job.add` (sensitive) and read them
  with `job.list`.

## Alternatives

- **Library (`croner`, `cron-parser`):** more syntax and time zones per job, but
  one more dependency for a small part of it.
- **Timer until the next due time:** more accurate to the second, but
  `setTimeout` goes wrong across sleep and is limited to 24.8 days.
- **Make up every missed run:** after a week of vacation, seven nightly test runs
  right after one another, without use.
- **Operating-system service (launchd, Task Scheduler, systemd):** runs without
  Hangar, but three implementations and no access to sessions. For continuous
  operation the server is intended.

## Consequences

- Up to 15 seconds of delay compared to the due time.
- The agent bay's shell command requires a POSIX shell (`$?`). If the command
  reads from standard input, it consumes the line with the marker; the job then
  ends only when the session closes. Unchecked on Windows.
- If the operating system changes the time zone at runtime, Electron may keep the
  old zone until Hangar restarts.
