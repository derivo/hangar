# @hangar/scheduler

Time-controlled jobs of the bays (ADR 0013): cron parser and `Scheduler`. No
Electron dependency, so that the same code can later run on a server.

## Interfaces

- `parseCron(expr)` – five fields, `*`, numbers, lists, ranges, steps;
  throws `Invalid schedule "<expr>": <field>: …`.
- `nextRun(cron, after)` – next match after `after` (ms) in local time,
  `undefined` if there is none (30 February).
- `new Scheduler({ file, now?, onChange? })` – `handle(bayId, handler)`,
  `unhandle(bayId)`, `add(bayId, { label, schedule, payload? })`,
  `list(bayId?)`, `remove(id)`, `setPaused(id, paused)`, `runNow(id)`,
  `tick()`, `start(intervalMs?)`, `stop()`.
- Types: `Job`, `JobRun`, `JobView`, `NewJob`, `JobHandler`.

## Pitfalls

- Jobs live in a JSON file (host: `<userData>/jobs.json`); a
  broken file starts empty.
- A job is due if a scheduled time lay between `since` (creation, last run, resume)
  and now; therefore after sleep exactly one catch-up run happens and after
  resuming nothing.
- A running job does not start again; `running` lives only in memory.
- Tests with time zones set `process.env.TZ` and restore it afterwards.
