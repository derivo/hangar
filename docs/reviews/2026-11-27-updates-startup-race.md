# Review: start status race in the update card (2026-11-27)

Reviewer: Codex (`codex exec -s read-only`), on the uncommitted changes of
`fix/updates-startup-race` against `origin/main`. Scope: bugs in the fix that keeps a
status event that arrives before the `getUpdate()` answer in `Updates.tsx` (the
follow-up to finding 1 of [2026-11-27-update-badge.md](2026-11-27-update-badge.md)).
Every finding was checked against the code before it was adopted; none was adopted.

| #   | Sev. | Finding                                                                                                                                                                                                | Checked                                                                                                                                                                                                                                                                                                                             | Change |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | low  | `current ?? s` keeps the state across effect runs: when the same `UpdateCheck` is re-rendered with a different `api`, the start value of the new API is dropped, and a late answer of the old one wins | Not adopted. Not reachable: the only `api` is `window.hangarShell` (`main.tsx`), passed unchanged through `App` and `Settings`; it never changes while the component is mounted. Leaving and reopening the settings unmounts the card and starts with fresh state (Codex confirmed that case passes). Same pattern as `Sidebar.tsx` | None   |

## Checked without finding

- The fix for an unchanged API is correct; the new unit test "keeps a status event that
  arrives before the answer for the start value" in `Updates.test.tsx` reproduces the
  race (a `ready` event before a late `idle` answer) and fails without the fix.
- CHANGELOG entry.
