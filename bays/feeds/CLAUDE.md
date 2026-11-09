# bays/feeds – Feeds (`dev.hangar.feeds`)

RSS and Atom subscriptions; their entries as one history, newest last, like a
chat (ADR 0040). The person and agents subscribe.

## Structure

- `manifest.json` – three `feed.*` functions (not sensitive, not
  `openToAgents`: the first agent call asks).
- `src/main/feeds.ts` – `Feeds`: subscriptions and entries in
  `<dataDir>/feeds.json`; `add`, `remove` (with its entries), `ingest` (only
  unseen entries, oldest first, at most `settings.maxItems` kept), `failed`,
  `configure` (stores the settings, trims the history at once). Errors
  `Unknown feed`, `Feed already exists`.
- `src/main/index.ts` – bus functions (zod; `feed.add` only http(s), no local
  or private host), UI
  channels `state` (feeds, items, `settings: { intervalMinutes, maxItems }`),
  `add` (German/English errors from `messages.ts`), `settings` (whole numbers,
  1–1440 minutes and 100–10000 entries, else a German/English error), `remove`,
  `fetch` (only subscribed URLs, 20 s timeout, at most 5 MB, `HTTP <status>`
  or `Feed too large` on failure),
  `ingest` (lengths bounded), `failed`; event `state`.
- `src/ui/parse.ts` – `parseFeed(xml, base)` with `DOMParser`: RSS 2.0, RSS 1.0
  (RDF), Atom; HTML in titles and summaries becomes plain text, summaries at
  most 500 characters, only http(s) links, relative ones resolved.
- `src/ui/App.tsx` – form "Feed abonnieren", gear "Einstellungen" opening a
  modal `<dialog>` (`aria-modal`, form "Feed-Einstellungen" with fieldsets
  "Abruf" and "Verlauf"; Esc, "Abbrechen" and the backdrop close it, focus
  returns to the gear; main's error shows in its `role="alert"`),
  subscriptions with their error, history as `role="log"`; fetches at start,
  every `settings.intervalMinutes`, on
  "Aktualisieren" and at once for feeds never fetched (also from agents).

## Functions

| Function     | Effect                                                            |
| ------------ | ----------------------------------------------------------------- |
| `feed.list`  | subscriptions: `url`, `title`, `fetchedAt?`, `error?`             |
| `feed.add`   | subscribes to `url` (http/https, no local or private host)        |
| `feed.items` | entries newest last; `feedUrl?`, `since?` (ISO), `limit?` (1–500) |

## Pitfalls

- The UI fetches and parses; without a loaded view nothing arrives. The view
  loads at app start.
- With a local server the bay runs there (`IN_SERVER` in
  `apps/desktop/src/main/index.ts`), otherwise two instances with two
  `feeds.json` would run.
- Links open in the default browser (`target="_blank"`); the browser bay has no
  way to show a tab for another bay yet.
- No manifest `settings`: bays cannot write Hangar settings, so the bay keeps
  its own in `feeds.json` (ADR 0040). A `feeds.json` without `settings` gets
  the defaults (15 minutes, 1000 entries).
- `feeds.json` also holds `seen`: the ids of each feed's last fetch, so entries
  that dropped out of the 1000 do not return.
- An entry's identity is `guid`/`id`, else link, else title; a feed that changes
  them shows entries again.
