# Review: shortcuts in the sidebar (2026-11-01)

Codex (`codex exec -s read-only`) over the unsaved diff for ADR 0027.
3 findings, each checked against the code.

| #   | Finding                                                                                                                                                      | Verdict              | Consequence                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Windows network paths (`\\server\share\…`) were stored, but discarded when reading `settings.json`; the shortcut never appeared.                             | confirmed            | `isAbsolute` takes `path.posix` and `path.win32`; test in `shortcuts.test.ts` red before.                                       |
| 2   | Under Linux `shell.openPath` (→ `xdg-open`) does not start executable files (ELF, AppImage).                                                                 | confirmed, not fixed | Limit in ADR 0027 under "Consequences"; programs via their `.desktop` file. Hangar does not run files itself. Not run on Linux. |
| 3   | An answer for a plus modal that had been closed in the meantime closed a newly opened one and discarded its input (also applies to add bay and file dialog). | confirmed            | Counter per open in `BayPicker`; test "does not let a late answer close a picker opened again" red before.                      |

Codex found no way to bypass the URL scheme and no IPC access from bays.
Not checked by Codex: rendered UI (for that `e2e/shortcuts.spec.ts` with axe
light/dark).
