# Review 2026-11-01 – completeness of the tests, edge cases, multi-clicks

Static review of the test suite (81 test files) by Codex
(`codex exec -s read-only`) and own check. No tests were run; the chaos
findings are derived from the code and not yet reproduced.

## Multi-click on the same button

| Severity | Location                                                                  | Guard?                 | Finding (checked)                                                                                                                                                      |
| -------- | ------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| high     | `apps/desktop/src/main/host.ts:355` `addBay`                              | no                     | `runtimes` is set only after `await activate`: a second click starts the bay again; if the second start fails, `bus.unregisterBay` removes the functions of the first. |
| high     | `bays/browser/src/ui/App.tsx:69` `submit`                                 | no                     | In new-tab mode every running submit opens its own tab.                                                                                                                |
| medium   | `apps/desktop/src/renderer/Sidebar.tsx:443` pairing "Next"/"Pair"         | lifecycle only         | Several probes (one connection each), only the last is aborted on close; "Pair" calls `pair` in parallel with the same probe (`connections.ts:146`).                   |
| medium   | `apps/desktop/src/renderer/Jobs.tsx:44` `act`                             | partly (`job.running`) | A second "Remove" shows `Unknown job "…"` (`scheduler.ts:179`).                                                                                                        |
| medium   | `apps/desktop/src/renderer/Permissions.tsx:32` set/revoke                 | no                     | Multiple IPC calls, answers in the wrong order, rejections without display.                                                                                            |
| medium   | `bays/browser/src/ui/App.tsx:126` close tab                               | no, no catch           | A second close rejects with `Unknown tab`, unhandled.                                                                                                                  |
| medium   | `bays/agents/src/ui/App.tsx:178` add project                              | `run` without key      | Several folder dialogs in a row.                                                                                                                                       |
| medium   | `bays/agents/src/ui/ProjectPane.tsx:33` refresh                           | mounted only           | An older Git answer can overwrite the newer one.                                                                                                                       |
| medium   | `apps/desktop/src/renderer/Sidebar.tsx:123`, `:312` shortcut, file choice | no                     | Web page opens twice on double-click; file dialog is requested several times.                                                                                          |
| low      | `bays/agents/src/ui/App.tsx:100` `pending`                                | yes                    | Unit test only for double-click on New session/close (`App.test.tsx:170`); no E2E, no 5×, no release after an error.                                                   |
| low      | `apps/desktop/src/main/host.ts:669` undock                                | yes                    | A second open focuses the existing window; untested.                                                                                                                   |

## Gaps outside the multi-clicks

- No E2E error gate: `pageerror`/`unhandledrejection` of the pages are not
  collected in `e2e/helpers.ts`; unhandled rejections go unnoticed.
- `host.ts`, `browser-tabs.ts`, `main/index.ts` and the preloads have no unit
  tests and lie outside the coverage gate (`vitest.config.ts:12`). Rejection of
  foreign senders (`bay:invoke`, `bay:window.*`, `bay:browser.show`) is not
  checked.
- Real browser tabs: crash, load error, 30 s limit, forbidden redirect only
  tested against a fake.
- `prompter.test.ts:73` never aborts the signal; only the handover is checked.
- Forms: pairing without whitespace-only per field, error texts only as a
  substring; job form without an empty cron with a valid command and without an
  empty command via Enter; settings and permissions do not show rejected calls.
- Website field of the shortcuts: complete (matrix, Enter, exact texts).

## Implementation (ADR 0028)

Every finding fixed with a test that was red before, exceptions below.

- E2E error gate: `e2e/helpers.ts` auto fixture `noPageErrors` (`pageerror` and
  `page.pageErrors()` for errors before listening). Probe with
  `Promise.reject` and with a bay that throws on load: both red. Full suite
  afterwards without a hidden error.
- `addBay`: red only with a slow start (`e2e/fixtures/slow`, 500 ms) – the
  agent bay starts too fast for the race. Error as predicted:
  `Start failed: Function is already registered`. Now a second call waits for
  the same start (`Host.adding`).
- Locks until the answer: browser bay (per tab or new tab, close per tab), plus
  modal (per open), server pairing, jobs and permissions (per action and job or
  rule), "Add project"; errors as a message. Newer answers win in the project
  overview and permissions.
- Newly found by `e2e/chaos.spec.ts`: a double-click on "New session" created
  two sessions, a five-fold click three; "Run now" ran five times, "Delete"
  reported `Unknown job`. The answer comes before the second click, a lock until
  the answer does not help. Follow-up clicks of a multi-click
  (`event.detail > 1`) are ignored for buttons that create, run, open and
  delete (ADR 0028).
- The full E2E suite found an error of its own: the jobs lock applied per job
  instead of per action, "Delete" during "Run now" on a server did nothing
  (`server.spec.ts`). Now per action; unit test for it.

Not implemented (stays open): unit tests for `host.ts`, `browser-tabs.ts`,
preloads; real browser tabs (crash, 30 s); `prompter.test.ts:73`;
form gaps in pairing and the job form (done, see addendum); server pairing in
E2E under multi-click (unit test only).

## Codex review of the implementation

6 findings, none high:

1. Browser key `submit` blocked navigation in other tabs – confirmed,
   red test, key per tab.
2. Lock in the plus modal survived closing and opening – confirmed, red test,
   lock per open.
3. Error gate did not see errors before listening – confirmed,
   `page.pageErrors()`, probe red.
4. `removeBay` during the start is undone by the start – confirmed,
   but not reachable through the UI (context menu only for running bays);
   left open.
5. Permissions test did not check the order of the answers – confirmed, test
   replaced; red without the comparison.
6. Tab close test does not simulate a following tab – confirmed; jsdom cannot
   do that, the test name now says what it checks. The E2E multi-click does not
   cover it (no browser tab in the chaos test).

## Addendum: form gaps and unstable browser test

- Job form: an empty schedule and one consisting only of spaces reported
  "Invalid schedule “”"; now "Schedule is missing" (`jobs.test.ts` red before).
  E2E `jobs.spec.ts`: empty schedule by click, command of only spaces by Enter,
  schedule of only spaces by Enter; every case changes the message.
- Pairing: name, address and code of only spaces (`Sidebar.test.tsx`). The
  code already trimmed; a counter-check without `trim` makes the three cases
  red.
- `browser.spec.ts`: cause of the one-time failure see `docs/STATUS.md`.
- Codex review of the addendum, 3 findings, all confirmed and fixed: an E2E
  check passed with the message of the incident; the browser test used a
  second, unchecked read; empty schedule was missing in E2E.

Still open: unit tests for `host.ts` (hence also `removeBay` during the start,
not reachable through the UI), `browser-tabs.ts`, preloads;
real browser tabs; `prompter.test.ts:73`.

## Addendum 2: main process, preloads, real browser tabs

All open points done.

- `host.test.ts`: Electron as a fake, real `BayRuntime` with test bays in the
  temporary folder (start, gate per bay, errors on start and stop). Start,
  sidebar, window and tray, bay window, IPC including rejection of foreign
  senders (`bay:invoke`, `bay:window.*`, `bay:browser.show`, `bay:server`),
  placement check, notifications, badges, shortcuts, server bays,
  permissions, jobs, `stop`. `removeBay` during the start: red before, now
  `removeBay` waits for the running start.
- `browser-tabs.test.ts`: address check, partitions without permissions, load
  error, 30 s limit (fake timers), crash, blocked navigation and redirect,
  popups as tabs, placement including zoom, takeover by another view.
- `preload.test.ts`: every method of both preloads with channel, arguments and
  return value; every channel must be registered in `host.ts`/`index.ts` with
  the matching kind (`handle`/`on`). Counter-check: a typo in the channel and
  `send` instead of `invoke` turn red.
- `prompter.test.ts`: the fake behaves like Electron (abort closes with
  `cancelId`); the test really aborts. Counter-check: wrong `cancelId` and
  missing `signal` turn red.
- The coverage gate now covers `apps/desktop/src/main` (without `index.ts`,
  wiring only) and `apps/desktop/src/preload`; thresholds unchanged.
- E2E `browser.spec.ts` with real tabs: connection refused
  (`ERR_CONNECTION_REFUSED`, also in the bay), redirect to `file:`, links to
  `file:` and `blob:`, popup with `openerId`, crash via
  `forcefullyCrashRenderer` and reload, 30 s limit. Counter-check without the
  `allowedUrl` block: red only with the `blob:` link – Chromium already blocks
  `file:` itself.

Newly found:

- The E2E test found an unhandled rejection: the browser bay recreated a tab
  via `ResizeObserver` that the main process had already closed
  ("Unknown tab"). The bay now ignores exactly this error; others stay loud
  (test checks both). Along the way: `vi.fn` attaches a handler of its own to
  every returned promise, a rejection through `vi.fn` never counts as
  unhandled – the test therefore uses a plain function.
- The full E2E suite found two jobs in 1 of 10 runs after a five-fold click on
  "Add job": submit buttons were not covered in ADR 0028. Now also "Open"
  (browser bay) and "Next"/"Pair", each with a test that was red before.
  Chaos spec afterwards 40/40 in 10 repetitions.

Codex review of this addendum, 4 findings, all confirmed and fixed:

1. Shortcut test hung on macOS (under Linux `getFileIcon`) – platform set in
   the test.
2. Real bug: if a second view took over a tab, closing the first hid it (the
   `destroyed` listener did not check where the tab is shown). Red test, fixed.
3. Abort test without a parent window: under macOS `signal` has no effect there
   (`electron.d.ts`). Test with a window, own test without a window.
4. Preload tests did not check the return value – added, counter-check red.
