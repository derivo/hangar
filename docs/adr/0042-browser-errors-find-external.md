# ADR 0042 – Browser bay: page errors, find in page, open outside

Status: accepted 2026-11-12. Extends [ADR 0015](0015-browser-bay.md).

## Context

The browser bay opens the pages an agent needs, mostly dev servers and
documentation. The person found errors hard to see: a failed load
(`ERR_CERT_AUTHORITY_INVALID`) showed only as a small grey status line, the page
area stayed empty. A page that answers with HTTP 500 or 404 showed no error at
all, because `did-fail-load` reports only network errors. Errors in the page
console and failed requests were not visible to the person nor to the agent.
Requirements from the person (2026-11-12): errors clearly visible and usable by
the agent, open the page in the system browser, find text in the page. No search
engine in the address bar.

## Decision

- **The host collects page errors per tab** (`BayBrowser.errors(id)`), at most
  the last 200 entries, cleared when another document replaces the page
  (`did-navigate`; not at the start of the navigation, while the old page still
  shows and may still log) or a started navigation fails (Electron shows its
  error page without `did-navigate`; a load refused before navigating, such as an
  invalid URL, keeps the list):
  - `load`: the main frame failed to load (`did-fail-load`) or answered with
    HTTP 400 or higher,
  - `console`: console messages of level `error` and `warning`, uncaught
    exceptions included,
  - `request`: other requests of the page with HTTP 400 or higher, or a network
    error (aborted requests excluded), seen through `session.webRequest` of the
    tab's partition.
- **`BrowserTab` gains `status`** (HTTP status of the main document, from
  `did-navigate`) and
  **`errors`** (number of entries of level `error`, absent at 0). `tab.open` and
  `tab.navigate` return both, so an agent notices a broken page without another
  call.
- **New function `page.errors`** `{ id, since? }` → `{ errors }`: the entries of
  one of the caller's tabs, with `since` (milliseconds since the epoch) only the
  newer ones. Not sensitive and open to agents like the other functions
  (ADR 0016): it reads only the caller's tabs.
- **UI:** a failed load hides the page and shows an error page in its place
  (code, address, "Reload", "Open in browser"). A tab with errors gets a red
  count in the tab bar; a button in the toolbar opens a panel below the page with
  the entries; warnings are hidden until switched on.
- **Open in the system browser:** a toolbar button calls `window.open(url)` in
  the bay UI. The host already hands `http`/`https` links of bay UIs to
  `shell.openExternal`; no new host interface.
- **Find in page:** `BayBrowser.find(id, text, { forward, next })` and
  `stopFind(id)` wrap `findInPage` (`next` maps to Electron's `findNext: false`,
  which continues the running search; `true` starts a new one); the result (`find: { active, matches }`)
  arrives with the tab. Cmd+F (Ctrl+F elsewhere) in the page is taken by the host:
  it focuses the bay UI and calls the listeners of `onFindRequest`, so the bay
  opens its find bar. Closing the bar gives the page the focus back
  (`BayBrowser.focus(id)`). No function for agents: `page.text` covers that.

## Alternatives

- **Error panel only in DevTools:** the person sees it, the agent does not.
- **A full CDP connection (`webContents.debugger`) for errors:** more detail
  (stack traces), but a second channel next to the events Electron already gives;
  can follow if agents need it.
- **New host function `openExternal`:** duplicates what `window.open` in a bay
  UI already does.

## Consequences

- `BayBrowser` and `BrowserTab` grow; the fake in `bays/browser/src/main/test-ctx.ts`
  follows.
- A page that logs errors in a loop causes a state update per message; the list
  stays capped at 200 entries.
- Certificate errors still block the page; the person may trust a refused
  certificate per host since [ADR 0043](0043-browser-trust-certificate.md).
