# Review: settings navigation, About, update check (2026-11-25)

Reviewer: Codex (`codex exec -s read-only`), on commit a65a53f of
`feat/settings-nav-about-update` (PR #47). Every finding was checked against the code
before it was adopted; all three held and were fixed.

| #   | Sev.   | Finding                                                                                                              | Checked                                                                                                                                                                                                                 | Change                                                                                                                                                                                                                                                                                                                         |
| --- | ------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | medium | A new check after `ready` loses the downloaded update: `checking`, then a failed check's `error`, overwrite `ready`  | Confirmed: `checkForUpdates()` allows a check in `ready`, and so do the 4-hour timer and a channel change; `installUpdate()` acts only in `ready`, so the install button goes away although the download is still there | No check while `ready` (option 1 below): `ready` joins the lock in `check()`, the check button is disabled in `ready`. Unit tests in `updates.test.ts` (manual check, channel change, timer, install still works) and `Updates.test.tsx` (red before the fix); the E2E step that presses the button moved to the `error` state |
| 2   | medium | The download lock only started with the first progress event; a channel change bypassed it                           | Confirmed: `available` (the download already runs) was not locked, and only `checkForUpdates()` checked the lock, not the timer or `startUpdates()`; a parallel check's events cleared the version of the download      | The lock moved into `check()`, which every entry point uses, and covers `checking`, `available` and `downloading`; the check button is also disabled in `available`. Unit tests in `updates.test.ts` (manual check, channel change, timer, version kept) and `Updates.test.tsx` (red before the fix)                           |
| 3   | low    | The E2E test of the settings navigation accepted a heading scrolled out of view above the scroll area (`top = -800`) | Confirmed: `top < 80 \|\| atEnd` had no lower bound                                                                                                                                                                     | The check is now `top > -1 && (top < 80 \|\| atEnd)` in `e2e/settings.spec.ts`                                                                                                                                                                                                                                                 |

## Decision (finding 1)

Options:

1. **No check while `ready`** – add `ready` to the lock in `check()` and disable the
   check button. A newer release published meanwhile is found after the next start,
   which installs the downloaded update anyway (`autoInstallOnAppQuit`).
2. **Keep the download apart from the last check** – remember the downloaded version
   and keep "Restart and install" (and `installUpdate()`) available while a later check
   runs or fails. Re-checking stays possible, but the status type and the UI must show
   two things at once (last check, pending install).

Chosen: option 1 – smallest change, and a pending install is the more useful state
than another check result.

## Test isolation

With the lock in `check()`, the module status of an earlier test could block the check
of the next one; `vitest.config.ts` shuffles the tests, so "handles a failed download"
failed in 4 of 15 runs. `updates.test.ts` now resets the status before each test
(0 failures in 20 runs).
