# Review: browser bay page errors, find in page, open outside (2026-11-12)

Reviewer: Codex (read-only, `codex exec -s read-only`), three rounds before the
commit. Scope: ADR 0042 – `apps/desktop/src/main/browser-tabs.ts`,
`bays/browser/src/main/index.ts`, `bays/browser/src/ui/{App,ErrorsPanel,FindBar}.tsx`,
the SDK types and their tests.

## Findings

1. **[P1] Electron's `findNext` was used the wrong way round** (round 1).
   `findNext: true` starts a new search, `false` continues it
   (`electron.d.ts`, `FindInPageOptions`). Fixed: `BayBrowser.find` takes
   `{ forward, next }` and passes `findNext: !next`. Test:
   `browser-tabs.test.ts` "finds, reports the final result with the tab and
   stops".
2. **[P2] Errors of the old page reached the new page's list** (round 1). The
   list was cleared on `did-start-navigation`, while the old page still showed
   and logged. Fixed: errors and status reset on `did-navigate`; the main
   document's status comes from there. Test: "starts over when the page
   navigates to another document …".
3. **[P2] Find bar keys only in the field** (round 1). Esc and Cmd/Ctrl+G did
   nothing on its buttons. Fixed: the handler sits on the bar. Test:
   `App.test.tsx` "takes Esc and Cmd/Ctrl+G on its buttons too".
4. **[P2] Closing the find bar lost the focus** (round 1). Fixed: closing gives
   the page the focus (`BayBrowser.focus`, UI channel `tab.focus`). Test:
   "closes with Esc and the close button, stops the search and gives the page
   the focus".
5. **[P2] A failed load kept the previous page's errors and status** (round 2).
   Electron 45 shows its error page without `did-navigate`. Fixed:
   `did-fail-load` of the main frame resets errors and status first. Test:
   "replaces the errors and status of the previous page by a failed load".
6. **[P2] Enter on a focused find bar button always searched forward**
   (round 2). The bar's handler prevented the button's click. Fixed: Enter
   steps only in the field. Test: "leaves Enter on its buttons to the buttons".

7. **[P2] The reset of fix 5 also hit loads refused before navigating**
   (round 3). An invalid URL (`https://example.test:99999/`) fails with
   `ERR_INVALID_URL` without a navigation; the shown page's errors and status
   were wiped. Fixed: `did-fail-load` resets only after `did-start-navigation`
   of the main frame. Test: same unit test, plus `browser.spec.ts` "real tabs":
   the HTTP 500 page navigated to a closed port has only
   `ERR_CONNECTION_REFUSED` and no status (real Electron emits the start first).

Round 3 found nothing else in fix 6.

## Verification

`pnpm lint`, `pnpm typecheck`, `pnpm test` (100 files, 1467 passed, 2 skipped;
coverage 98.96 % lines, 97.28 % branches), `pnpm docs:api` exit 0.
`playwright test e2e/browser.spec.ts`: 4 passed after the round 3 fix. The full
`pnpm test:e2e` ran after the round 1 fixes: 64 passed, 2 skipped.

## ADR 0043: trusting a certificate (2026-11-13)

Reviewer: Codex (read-only), one round on the change, one on the fixes.

8. **[P1] The click could trust another certificate than the one shown.** The
   UI sent only the tab id; an agent navigating the tab to another refused
   host in between got that certificate trusted. Fixed:
   `trustCertificate(id, fingerprint)` with the fingerprint the UI shows; a
   different one fails and trusts nothing. Round 2: the same certificate on
   another host (a shared dev certificate) still passed; the call now takes
   `{ host, fingerprint }` and checks both. Test: `browser-tabs.test.ts` "trusts
   only the certificate the person saw" (red without the host check).
9. **[P2] Overlapping navigations kept the old certificate and error.** A
   navigation started before the failed load stopped brings no new
   `did-start-loading`. Fixed: the certificate is dropped on
   `did-start-navigation` of the main frame, the error on `did-navigate`. Test:
   "drops the certificate when another navigation starts, the error when a page
   commits".

## Second reviewer: OpenCode (2026-11-13)

OpenCode 2.2.5 with `opencode/deepseek-v4.1-flash-free`, agent `plan`
(read-only), on the whole change. Codex round 3 on fixes 8 and 9 found nothing.

10. **[P2] Entries had no size limit.** A page logging huge messages filled
    state, IPC and `tabs.json`. Fixed: message and source capped at 2,000
    characters. Test: "caps the text of an entry".
11. **[P3] `status: -1` for pages without HTTP** (`about:blank`). Fixed: only
    codes above 0. Test: "has no status for a page without HTTP …".
12. **[P3] The find result of the old page stayed after navigating.** Fixed:
    `did-navigate` clears `find`. Same test.
13. **[P3] The find bar came back when switching back to its tab**, taking the
    focus from the page. Fixed: another tab closes it for good. Test:
    `App.test.tsx` "closes and stops when another tab is selected".
14. **[P3] An aborted navigation left `navigating` set**, so a later load
    refused before navigating wiped the shown page's errors (the case of fix 7).
    Fixed: `ERR_ABORTED` ends `navigating` when it is that navigation's
    address (redirects followed); a later navigation keeps its flag. Tests: "ends
    the navigation an abort ended …", "keeps the next navigation when the aborted
    one reports late".
15. **[P3] Unhandled rejections in the UI** when an agent closed the tab during
    `errors`, `find` or `stopFind`. Fixed: ignored there. Test: "stays quiet
    when the tab is gone during a call" (red without the fix).
16. **[P3] Docs differed from the code:** CHANGELOG signature of
    `trustCertificate`, `find?` and `status` without HTTP in `docs/mcp.md`, and
    ADR 0043 now says the "agents never trust" promise is the browser bay's, not
    a host guarantee.

Codex on fixes 10–16:

17. **[P2] Fix 14 listened to the wrong event.** Electron reports a cancelled
    load as `did-fail-provisional-load`, not `did-fail-load`; `navigating`
    stayed set. Fixed: that event ends the running navigation, only for
    `ERR_ABORTED` – the full E2E showed that real failures such as
    `ERR_CONNECTION_REFUSED` arrive there too, before `did-fail-load`. The
    tests now emit it, the refusal case included.
18. **[P3] The find result stayed when a started navigation failed** (error
    page without `did-navigate`). Fixed: the failed-navigation reset clears
    `find`. Test: "forgets the find result when a started navigation fails".

Codex on fix 17:

19. **[P2] Navigations without commit still left `navigating` set.** Electron
    45 emits `did-fail-provisional-load` only for committed error pages; an
    abort before commit or an HTTP 204 answer emits nothing, so a later invalid
    URL wiped the shown page's errors, status and find result. Fixed: replaces
    fix 17 – `did-stop-loading` ends the navigation (loading stops after every
    navigation, an overlapping one keeps it loading); the address tracking is
    gone. Test: "ends a navigation that never commits (HTTP 204, abort) …" (red
    before the fix).

Codex on fix 19: nothing found (source check of Electron 45.1 and Chromium 156).
