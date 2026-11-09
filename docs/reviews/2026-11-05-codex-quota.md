# Review Codex limit from older logs (2026-11-05)

Reviewer: Codex (`codex exec -s read-only`), diff before the commit. Scope:
`readCodexQuota` in `bays/agents/src/main/quota.ts` walks the logs of the two
newest day folders newest first and takes the first 5-hour limit; before, a
newer log without a limit (`codex exec`) made the Codex segment disappear.

## Findings

1. **[P2] Expired limit from an older log.** Codex: an older log may carry a
   limit whose reset has passed; the footer then shows 100 % free. **Not
   adopted:** after the reset the 5-hour window is free, so 100 % is true; the
   footer has counted a past reset as free since ADR 0024. The newest log
   could carry an expired limit before this change too.
2. **[P2] Unbounded reading per minute.** Every log is read (up to 1 MB each)
   until one has a limit; without a hit, every minute. **Adopted:** at most
   five logs per refresh (`ponytail:` comment names the ceiling).

## E2E retries in CI

Change: `apps/desktop/playwright.config.ts` retries twice when `CI` is set,
after run 41932094202 failed two terminal waits that had passed before.

Codex: no findings (retry isolation, LaunchAgent cleanup, trace config, CI
detection checked statically; E2E not run).

## Board: form for a new task in the column "Open"

Change: `bays/board/src/ui/App.tsx` renders the form at the top of the column
"Open", fields one below the other, primary button; `styles.css` drops the
three-column form; `e2e/a11y.spec.ts` checks the board with axe.

Codex: no findings (static review; browser and E2E not run in its sandbox).

### Second version: composer like a list's "Add a card"

The first version still looked out of place. Now a quiet button "Add a task"
at the end of the column "Open" opens a card form (title, optional
description, primary button, "Cancel", Esc). Codex, two findings, both
adopted:

1. **[P2] A late answer cleared a new draft.** Submit, cancel before the
   answer, open again and type: the answer emptied the new draft. Answers of a
   closed draft are now ignored (test "keeps a new draft when the answer for a
   cancelled one comes late").
2. **[P2] Label in name (WCAG 2.5.3).** The placeholders "What needs doing?"
   and "Details (optional)" were the only visible text, the accessible names
   "Title" and "Description". The placeholders now start with the name.

## Agent bay: output lost when attaching again

Change: `session.data` carries `end`, `session.snapshot` returns scrollback and
`end`, `TerminalRegistry` keeps early output newer than the snapshot; older
servers fall back to `session.buffer`. Found through CI run 42062340811
(`local-server.spec.ts:130`).

Codex: no findings (static review of counter vs trimmed scrollback, restarts,
restored sessions, several terminals of one session, old and new UI against
old and new server, the E2E helper).

## Local server: runtime copy per build

Change: the runtime copy is named `<version>+<build id>` (SHA-256 of size and
mtime of `app.asar`), so a new build of the same version reaches the server on
restart; the hint compares the running copy with this app's build and names
plain versions when they differ. Found on 2026-11-07: an installed new build of
0.1.0 kept running the first copy, also after a restart.

Codex: no findings (isolated checks of the legacy folder `0.1.0`, build change,
kept/restart, cleanup, `serverUiRoots`, version regex, way back and hint; the
packaged E2E only statically). Open in its sandbox: mtime stability across
installs. Checked by hand: `ditto` from `release/` to `/Applications` and into
the runtime copy keeps size and mtime of `app.asar`.

### Follow-up: the build id from the code signature

The packaged E2E (`local-server.spec.ts`, "a server from an older copy …")
failed after the commit: the copy after the restart had another build id than
the first one, of the same app. Inside Electron `fs.statSync` on `app.asar`
returns the stat of a virtual folder, not of the file, so size and time were
not stable. The id now hashes `Contents/_CodeSignature/CodeResources`, which
signing writes anew per build and which lists the hashes of all resources.

Codex on that, one finding, adopted:

1. **[P2] Unsigned builds kept the old copy.** Without `CodeResources` every
   build of a version had the same name again; CI builds unsigned packages.
   The id now also hashes `Info.plist` (its `ElectronAsarIntegrity` is the
   hash of `app.asar`, present without a signature), `server/hangar-server.mjs`
   and `cli/hangar.mjs` (test "tells builds apart without a signature too").

Codex re-review of the fix: no findings. Packaged E2E (`HANGAR_E2E_EXECUTABLE`,
`e2e/local-server.spec.ts`): 6 passed without retries.

Two notes of that review, judged: the same content gives the same id (kept on
purpose: the same content is the same build); `CodeResources` does not cover
the main executable, and Electron lies in `Electron Framework.framework`. The
id now also hashes the framework's `Info.plist`, which carries the Electron
version (test "tells builds apart without a signature too"). Codex on that: no
findings. Packaged E2E again 6 passed without retries.

## Local server: visible restart

Change: while `Host.restartOnce` runs, `SidebarLocalServer.restarting` is set
and the hint shows "Local server is starting …" (`role="status"`) instead of
its button. Before, the old server stayed connected while the copy was made,
the hint did not change, and the restart was clicked twice. Found on
2026-11-07.

Codex: no findings (static: state transitions, menu restart, failed restart,
cancelled dialog, reconnect before the restart resolves, `role="status"`;
its Vitest run failed on `EPERM` in its sandbox). Its note that the tests do
not assert `restarting` for every transition: not adopted; a cancelled dialog
never sets it and `finally` clears it on failure, both one line each.
Locally: 1304 tests passed, `e2e/a11y.spec.ts` and `e2e/local-server.spec.ts`
9 passed, 1 skipped.

## Agent bay: fixed tree header and counts

Change: `.tree-header` and `.tree-foot` in `bays/agents/src/ui/styles.css`
are `position: sticky`; the projects scroll between them. Codex, one finding,
adopted:

1. **[P2] Focus hidden under the sticky parts (WCAG 2.4.11).** Reproduced in
   E2E: on the sixth Tab a button lay under the counts. `nav.tree` now has
   `scroll-padding-block`; the test tabs forward and back through six
   projects and checks every focused button lies between header and counts.

## Browser bay: page zoom

Change: `BrowserTabs` handles the zoom keys of a page (Cmd/Ctrl +, =, -, 0)
in `before-input-event`, `BrowserTab.zoom` names the zoom in percent (absent
at 100 %), `BayBrowser.resetZoom(id)` sets it back; the browser bay shows
"110 %" next to the address, a click resets. Codex, two findings:

1. **[P2] Extra modifiers were taken as zoom.** Cmd+Ctrl+= zoomed, Cmd+Alt+0
   reset. **Adopted:** only Cmd (Ctrl off macOS) alone, Shift allowed (it
   types "+" on some layouts); test in `browser-tabs.test.ts`. Re-review: no
   findings.
2. **[P3] Electron cases without tests.** **Adopted in part:** the E2E now
   navigates to another host (100 %) and back (110 % again), so zoom per host
   and the update after navigation are covered. Not adopted: same host in two
   tabs (`changed` lists every tab with its current zoom, nothing to couple),
   numpad and layouts (the key values are the same), tab switching (derived
   from the state the test already checks).

Playwright's CDP keys do not reach `before-input-event`; the E2E sends native
events with `sendInputEvent`. A real key press through the app menu is not
covered by a test.

## README: pitch, screenshot, how it works

Change: README with pitch, screenshot (light and dark, rendered by
`apps/desktop/e2e/readme-screenshots.spec.ts`, skipped without
`HANGAR_SCREENSHOTS=1`), "Why", features with board, password bay and local
server, status, "How it works", "For AI agents"; sessions described as shells
in the project folder (ADR 0022). Proposal from a study of ten trending
GitHub READMEs; commands and repository layout stay in the README
(`AGENTS.md`).

Codex fact-check, six findings, all adopted as more precise wording: the
local server only runs in the installed app (off in `pnpm dev`); a bay's main
part is not limited to the SDK; workspaces share session metadata and
function calls, no project files; not every call needs a grant by the person;
handovers still get a worktree; the MCP server, not the bus, maps the token.
The screenshots show no personal data (temporary repositories under `/tmp`,
prompt `$`).

## Windows relay flakes (2026-11-08)

Change: `RelayClient` publishes its own member list changes (`addMember`,
`removeMember`, `renew`) one after another and computes each change from the
list the previous one left; a renewal at the same time as a member change no
longer drafts the same version (run 42005154571, `workspaces.test.ts`). The
test "answers at most 10 calls …" uses a 1000 ms call timeout, which also
bounds its relay requests while pairing (`client.test.ts`).

Codex review (read-only, static): no findings. Requests stay bounded by their
timeout, so a hanging request does not block the queue for longer; a failed
change rejects its caller without blocking the next.

## Quota footer: weekly limit (2026-11-09)

Change: the footer of the agent bay also shows the weekly limit after the
5-hour part ("7d", share free, reset with date and time, own `role="meter"`).
Claude reports `rate_limits.seven_day` through `hangar statusline` as `week`,
Codex is read from `rate_limits.secondary` (10080 min). ADR 0024 addendum.

Codex review, one finding, adopted: P2, a `seven_day` without `five_hour`
(window not started or just reset) was dropped. `hangar statusline` now
reports it with 0 % used for 5 hours (`cli.test.ts`, red first).
