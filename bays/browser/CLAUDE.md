# bays/browser – Browser (`dev.hangar.browser`)

Web pages in tabs, for the person and for agents (ADR 0015). The pages themselves
are shown by the host as a separate `WebContentsView` per tab (host module `browser`,
`hostModules` in the manifest); the bay controls them via `ctx.browser`.

## Structure

- `manifest.json` – id, `hostModules: ["browser"]`, functions (visible over bus and MCP).
- `src/main/` – runs in the main process (coverage gate 90 %).
  - `index.ts` – `activate(ctx)`: UI channels, bus functions, restoring the person's tabs.
  - `url.ts` – `normalizeUrl`: address bar input → URL (`localhost:5173` → `http://`, `example.com` → `https://`), only http, https, `about:blank`.
  - `test-ctx.ts` – fake context with an in-memory browser.
- `src/ui/` – React: tab bar (agent tabs with the label "Agent", red error count), back/forward/reload, address bar, page zoom ("110 %" next to the address when not 100 %, click resets), "Open in browser" (`window.open`, the host hands it to the system browser), page area. Texts in `messages.ts` (de/en).
  - Page errors (ADR 0042): a failed load replaces the page by an error page (reload, open in browser); HTTP 400+ of the page is named above it; "Errors (n)" opens `ErrorsPanel.tsx` below the page (warnings on request).
  - Certificate errors (ADR 0043): with `certificate` on the tab the error page shows host and fingerprint and "Trust this host" (UI channel `tab.trustCertificate`; no function for agents, by design).
  - `FindBar.tsx`: find in page, opened by Cmd/Ctrl+F in the bay or in the page (host event `find`); Enter/Cmd+G next, Shift previous, Esc closes.

## Tabs and partitions

- The person's tabs: partition `user`, persistent; their addresses are in `tabs.json` in the data folder and are reopened on start.
- Agent session: partition `session-<bay-id>-<session-id>` in memory; an agent sees and reaches only tabs of its partition. If a bay calls the functions: `bay-<bay-id>`.
- Callers of the local server (ADR 0036): `session-local-server:<bay-id>-<session-id>` or `bay-local-server:<bay-id>`. If the session ends in the server, the host reports it with `bayId` `local-server:<bay-id>`.
- A tab that a page opens via `window.open` belongs to the partition of the opening tab.
- The UI may operate and close every tab, including those of the agents.

## Functions

| Function          | Effect                                                                |
| ----------------- | --------------------------------------------------------------------- |
| `tab.open`        | `{ url }` → tab (`id`, `url`, `title`, `error` …) after loading       |
| `tab.navigate`    | `{ id, url }` → tab                                                   |
| `tab.list`        | own tabs                                                              |
| `tab.close`       | `{ id }` → `{ ok: true }`                                             |
| `page.text`       | `{ id }` → `{ text, truncated }` (at most 100 000 characters)         |
| `page.click`      | `{ id, selector }` → `{ ok: true }`                                   |
| `page.fill`       | `{ id, selector, value }` → `{ ok: true }` (fires `input`/`change`)   |
| `page.errors`     | `{ id, since? }` → `{ errors }` (ADR 0042, at most 200, oldest first) |
| `page.screenshot` | `{ id }` → `{ path }` (PNG under `screenshots/` in the data folder)   |

## UI channels (`window.hangar.invoke`)

`state`, `tab.open`, `tab.navigate`, `tab.back`, `tab.forward`, `tab.reload`,
`tab.resetZoom`, `tab.close`, `tab.errors`, `tab.find`, `tab.stopFind`, `tab.focus`, `tab.trustCertificate`. Events:
`state`, `find` (Cmd/Ctrl+F in a page, with the tab id). Placement: `window.hangar.browser.show(id, rect)`.

## Pitfalls

- All functions are `openToAgents` (ADR 0016): agents of any bay call them without asking. Therefore each may reach only tabs of the caller's partition (`tab()`).
- The tab view lies above the bay UI: whatever is in the page area (dialogs, menus) would be covered. Without a shown tab the UI calls `show(undefined)`.
- The host collects page errors per tab (`ctx.browser.errors`); the list starts over when another document replaces the page (`did-navigate`) or a load fails (`did-fail-load`, no `did-navigate` for Electron's error page), not when loading starts. Tabs carry `status` and `errors` (count of level `error`).
- If an agent session ends (`ctx.onAgentSessionEnded`), the bay closes its tabs. A restart of the shell does not end the session.
- Guide: `docs/bay-development.md`.
