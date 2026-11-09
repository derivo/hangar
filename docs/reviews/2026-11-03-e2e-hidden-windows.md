# Review E2E windows invisible (2026-11-03)

Reviewer: Codex (`codex exec -s read-only`), diff before the commit. Scope:
under `HANGAR_E2E` the app opens its windows invisibly, without focus and
without a dock icon; `HANGAR_E2E_SHOW=1` shows them.

## Findings

1. **[P2] `showInactive()` makes windows visible.** `Host.show()` (click on a
   notification, `m7-notify.spec.ts`) showed the window, only without focus.
   **Adopted:** in test mode windows have opacity 0 and let mouse clicks
   through (`setIgnoreMouseEvents`); when shown they stay invisible.
   `isVisible()` stays correct, the E2E test unchanged. Test
   `host.test.ts` "keeps its windows off the screen …".
2. **[P2] A saved maximized window is shown by `maximize()`.** **Adopted** with
   the same change; the test starts maximized.
3. **[P2] Native dialogs (folder, prompts) still appear.** **Not adopted:**
   tests that trigger a dialog replace it (`mockFolderPicker`, `answerDialog`
   in `e2e/helpers.ts`); one without a mock would hang at the dialog and be
   noticed. The quiet depends on these mocks.

## Not checked

- Opacity and click pass-through do not exist under Linux; E2E runs only under
  macOS (`ci.yml`).
- The tray icon still appears in the menu bar during the test.
