# ADR 0028 – Multiple clicks on the same button

Status: accepted.

## Context

Whoever presses a button several times in quick succession (double click out of
habit, impatience with a slow response) must not produce duplicate sessions,
tabs, job runs, connections or error messages. A review of the tests
(`docs/reviews/2026-11-01-tests-chaos.md`) found several buttons without
protection. Two cases differ:

- **Slow response:** The second activation arrives before the first has
  finished (start bay, check server, folder dialog).
- **Fast response:** A session is created within a few milliseconds; the second
  activation of a double click (100–200 ms later) comes afterwards and creates a
  second one. A lock until the response does not help here.

## Decision

- **Lock until the response:** Actions with a response from the main process run
  at most once at a time per key (agent bay `run(action, key)`, browser bay
  `run`, jobs and permissions per rule or job, plus modal and server pairing per
  dialog). Repetitions before that do nothing; after the response or an error
  the button is free again. Errors appear as a message, never as an unhandled
  rejection.
- **Follow-up clicks of a multi-click:** Buttons that create, run, open or
  delete something ignore clicks with `event.detail > 1` (second, third … click
  of a multi-click): New session (tree and project overview), Add field, Run
  now, delete job, close tab (browser), open shortcut. Keyboard (Enter, Space)
  has `detail` 0 and works every time.
- **Submit buttons of forms** the same: The button calls `preventDefault()` when
  `detail > 1`, so the click does not submit the form (create job, Open in the
  browser bay, Next/Pair when pairing a server – there the second click would
  otherwise hit "Pair" without a code). Enter in the field submits without a
  click.
- **Toggles** (color scheme, pause/resume, environment variables) stay without a
  follow-up click lock: every click is one step.
- **Main process:** `Host.addBay` waits for the same start on a second call
  during startup, instead of starting the bay a second time.
- **Verification:** unit tests per button with a delayed response and with a
  double click; `e2e/chaos.spec.ts` presses the buttons as a multi-click
  (`click({ clickCount: 5 })`). Every E2E test fails if a page throws an
  unhandled error (`e2e/helpers.ts`, fixture `noPageErrors`).

## Alternatives

- **Disable the button until the response (`disabled`):** takes the focus from
  the button and does not help with a fast response; rejected.
- **Time window (debounce) per button:** arbitrary duration, delays the first
  activation or swallows intended ones; `event.detail` uses the system's
  double-click time.

## Consequences

- A deliberate double click on "New session" creates one session, not two;
  whoever wants two clicks twice with a pause or uses the keyboard.
- New buttons of this kind need both kinds of protection and a test for it,
  submit buttons too. A form that closes after the response (project by path)
  is without: the second click then hits no button any more.
