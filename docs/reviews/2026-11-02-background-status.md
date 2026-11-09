# Review status "waiting for background" (2026-11-02)

Reviewer: Codex (`codex exec -s read-only`), diff before the commit. Task: new
status `background` from `background_tasks` of the `Stop` hook (ADR 0035);
reading stdin in the CLI, all places that enumerate statuses, docs.

## Findings

1. **[P2] stdin waits indefinitely for EOF.** If the input stays open,
   `hangar --quiet status done --hook` reaches neither `run()` nor its time
   limit. **Adopted:** `readInput` gives up after 1 s, the entry point closes
   stdin afterwards. Test "never hangs a Stop hook whose input stays open …"
   (real entry point, open stdin, exit 0 within 4 s).
2. **[P2] Read errors of stdin bypass `--quiet`.** Reading lay outside the
   error handling of `run()`. **Adopted:** `readInput` catches read errors
   and returns empty input (results in `done`). Test "reads the hook input, but
   gives up on an open or failing input".

No findings on status enumerations (UI, `share.ts`, server, theme,
notification, badge) and docs.

## Not checked

`hangar statusline` still reads stdin without a time limit (unchanged; Claude
Code closes the input there). Background agents and interactive sessions
are not measured (ADR 0035).
