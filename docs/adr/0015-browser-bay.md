# ADR 0015 – Browser bay and host capability `browser`

Status: accepted

## Context

The browser bay ([concept.md](../concept.md), "Planned bays") shows web pages in
tabs. Agents should open, read and click pages and take screenshots via MCP, for
example to check their dev server. Bay interfaces are sandboxed and have no
Node; the main part of a bay has no Electron (ADR 0004). So only the host can
show web pages.

## Decision

- **Host capability instead of `<webview>`:** A bay with
  `hostModules: ["browser"]` in the manifest receives `ctx.browser`. The host
  creates a separate `WebContentsView` per tab (sandbox, context isolation, no
  preload) and manages it. Without the entry there is neither `ctx.browser` nor
  `window.hangar.browser`. The Electron `<webview>` tag stays off, because
  Electron advises against it.
- **Division of tasks:** The main part opens, navigates, closes, reads tabs and
  runs scripts in them (`ctx.browser`). The interface only determines where a tab
  appears: `window.hangar.browser.show(tabId, rect)` places the tab's view over
  this area of the bay view or of the bay window the call comes from. A tab is
  visible in at most one place.
- **Storage per partition:** The host forms partitions only in the bay's
  namespace (`bay-browser:<bay-id>:<name>`, with `persist:` for persistent
  ones). It rejects all permission requests from web pages (camera, microphone,
  location, notifications). Only `http`, `https` and `about:blank` are loaded.
  `window.open` opens a new tab of the same partition.
- **In parallel:** A bay runs once, with any number of tabs at the same time
  inside it. The person's tabs live in a persistent partition and are reopened
  after a restart. Each agent session gets its own tabs in its own in-memory
  partition, without the person's logins and without those of other agents. An
  agent reaches only tabs it has opened itself via the bus. Its tabs appear in
  the tab bar, so that the person can watch.
- **Functions for agents:** `tab.open`, `tab.navigate`, `tab.list`, `tab.close`,
  `page.text`, `page.click`, `page.fill`, `page.screenshot`. A screenshot is
  saved as a PNG in the bay's data folder; the response gives the path instead of
  Base64. Loading waits at most 30 seconds.
- **Not sensitive:** The functions act only on own tabs in the own partition; the
  person sees everything in the tab bar.

## Alternatives

- **`<webview>` in the bay interface:** little host code, but Electron advises
  against it, and the interface would need `webviewTag`.
- **Playwright or CDP for agents:** more powerful, but a second browser next to
  the visible one, and the person would not see what the agent does.
- **Shared partition for person and agents:** convenient for logged-in pages, but
  every agent could read pages with the person's logins.
- **Screenshot as Base64 in the response:** an image of several megabytes in the
  agent's context.

## Consequences

- New interfaces in the SDK (`BayBrowser`, `HangarUiApi.browser`) and in the
  manifest (`hostModules`, brought forward from ADR 0012).
- Agents do not see pages for which the person is logged in. If an agent needs a
  login, it logs in itself in its tab.
- Bookmarks, history, downloads overview and separate windows for tabs follow
  later.
