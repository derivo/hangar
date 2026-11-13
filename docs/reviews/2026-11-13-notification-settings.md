# Review: checking notifications in the settings (2026-11-13)

Reviewer: Codex (read-only, `codex exec -s read-only`) before the commit.
Scope: ADR 0044 – `apps/desktop/src/main/host.ts` (notifications),
`src/renderer/Notifications.tsx`, `src/shared.ts`, the preload and their tests.

## Findings

1. **[P2] Linux answered `unknown` although the notification was shown.**
   Electron's libnotify path emits `show` inside `show()`; the test's listeners
   came after it. Fixed: `showNotification` attaches the caller's listeners
   before `show()`. Test: `host.test.ts` "hears a show the system sends inside
   show() (Linux, Codex)".
2. **[P2] The open settings missed a refusal that came later.** The status was
   read only on mount and after a test. A first fix read it again on window
   focus; round 2 showed a refusal after the test answered `unknown` still went
   unseen. Fixed: the host sends `shell:notifications` whenever the system
   answers a notification, the section reads the status again. Tests:
   `host.test.ts` "remembers why the system refused …", `preload.test.ts`,
   `Notifications.test.tsx` "reads the status again when the host reports a
   change".
3. **[P3] "Turn on notifications in the system" did nothing while a test
   waited.** Both buttons shared one lock. Fixed: one lock per action. Test:
   "opens the system settings while a test still waits for its answer".
4. **[P3] Clicked notifications stayed in the host's set.** A click may end the
   native notification without `close`. Fixed: removed on `click` too. Test:
   "forgets notifications that were clicked or failed".

Codex round 3 on the round-2 fix found nothing.

## E2E

The full `pnpm test:e2e` failed in `workspaces.spec.ts` and `local-server.spec.ts`:
the answer paragraph had `role="status"` next to the workspaces section, so
`getByRole('status')` there matched two elements. Fixed: `aria-live="polite"`
without the role. Test: "announces the answer politely without a second status
role".

## Second reviewer: OpenCode (2026-11-13)

OpenCode 2.2.5 with `opencode/deepseek-v4.1-flash-free`, agent `plan`
(read-only).

5. **[P2] The macOS hint led nowhere when Hangar is missing from the list** –
   the case that started this. Fixed: the hint says macOS has not asked yet
   (send a test) and that unsigned development builds show no notifications.
6. **[P3] A refused test showed its reason twice**, once as "the last
   notification"; the unit test hid it with a status the host never returns.
   Fixed: after a refused test only the test's answer names the reason; the
   test now mocks the real status.
7. **[P3] A failed status read made the section vanish.** Fixed: heading and
   the error as an alert.
8. **[P3] No feedback for up to 10 s while the system had not answered.**
   Fixed: "Waiting for the system to answer …".
9. **[P3] Under `HANGAR_E2E` on a machine without libnotify** the status said
   unsupported while notifications were recorded. Fixed: supported there.
10. **[P3] `docs/STATUS.md` E2E row was stale.** Updated with the full run.

Codex on the OpenCode fixes:

11. **[P2] The duplicate suppression hid every later refusal** while the test's
    answer stayed `failed`. Fixed: hidden only when the reason is the test's
    own. Test: "shows a later refusal with another reason after a refused test".
12. **[P3] "Waiting …" stayed when the test call itself failed.** Fixed: cleared
    on failure.
13. **[P3] A status read error stayed after a read worked.** Fixed: its own
    state, cleared by the next good read. Test for both: "stops waiting when
    the test call fails, and drops a read error once a read works".

Codex on fixes 11–13:

14. **[P3] The read after a test bypassed the read error.** It went through
    the action's error instead, so an old read error stayed after it worked,
    and its own failure stayed after a later read worked. Fixed: one read for
    both paths. Test: "reads the status after a test like any other read" (red
    before the fix).

Codex on fix 14: nothing found.
