# ADR 0024 – Quota bar: 5-hour quota of Claude and Codex

Status: accepted.

## Context

Anyone working in sessions with Claude Code and Codex wants to see how much of
the 5-hour quota of both providers is still free and when it resets, without
switching to a terminal.

- **Codex** writes the values into its session logs:
  `$CODEX_HOME/sessions/<year>/<month>/<day>/*.jsonl` (default `~/.codex`),
  lines with `rate_limits.primary` = `{ used_percent, window_minutes: 300,
resets_at }` (seconds since 1970).
- **Claude Code** stores the values nowhere. They appear only in the JSON that
  Claude Code passes to the `statusLine` command on stdin:
  `rate_limits.five_hour` = `{ used_percentage, resets_at }`.

Requirements from the person (2026-10-30): Claude through a switch in the
statusline; display as a footer across the full width of the agent bay.

## Decision

- **Switch in the statusline:** `writeAgentConfig` enters
  `statusLine: { type: "command",
command: "hangar statusline" }` into `.claude/settings.local.json` of every
  session. If a foreign `statusLine` is already there, it stays; that session
  then reports no quota.
- **`hangar statusline`** reads stdin, reports `rate_limits.five_hour` through
  `dev.hangar.agents/quota.report` (timeout 1 s, errors silent) and then calls
  the person's statusline with the same stdin: first `statusLine` from the
  project's `.claude/settings.json` (`workspace.project_dir`), otherwise from
  `$CLAUDE_CONFIG_DIR/settings.json` (default `~/.claude/settings.json`), run in
  the current folder (`workspace.current_dir`). It passes on its output
  unchanged. No loop: commands that start with `hangar ` are skipped, and the
  command runs with `HANGAR_STATUSLINE=1`; if that is set, `hangar statusline`
  calls nothing. Exit is always 0.
- **`quota.report`** (not sensitive, only from a session): `{ provider:
"claude", usedPercent, resetsAt }`. The bay keeps the last value per provider
  in memory, not in `state.json`.
- **Codex:** The main part reads at most once per minute the most recent log
  file (latest change in the two newest day folders, so that a session across
  midnight counts) and in it the last
  line with `rate_limits.primary` and `window_minutes: 300`.
- **Display:** Footer "Usage limits" below the project tree and fields, per
  provider with a value: name, "5h", scale (`role="meter"`, share free),
  "94% left", "resets 20:40". If `resetsAt` is in the past, the window counts as
  free (100 %); the footer recalculates every minute for this. Without values
  for both providers the footer is omitted.

## Limits

- Claude values exist only once Claude Code runs in a Hangar session, and they
  are as old as its last statusline output.
- Codex values are as old as the last log; Codex outside Hangar counts too,
  because it writes the same files.
- The weekly quota came later (addendum).
- On a Hangar server the bay reads the server's `~/.codex`.

## Addendum 2026-11-09: weekly quota

The person asked for the weekly quota as well, kept short. `hangar statusline`
also reports `rate_limits.seven_day` as `week` (`usedPercent`, `resetsAt`);
for Codex the bay takes `rate_limits.secondary` with `window_minutes: 10080`
from the same log line. The footer shows it after the 5-hour part without a
scale: "7d", "85 %", "Reset 10.11. 15:37" (date and time, since the reset
can be days away), as its own `role="meter"` ("Claude 7d"). A passed reset
counts as free, as for 5 hours. Without a weekly value nothing changes. If
Claude Code passes only `seven_day`, the 5-hour window has not started or just
reset, so it is reported as 0 % used.

## Alternatives

- **Anthropic usage API with Claude Code's token:** more precise and also
  without a running session, but Hangar would have to read Claude Code's
  credentials from the keychain; rejected.
- **Codex only:** no change to the statusline, but half of the display is
  missing; not chosen by the person.
