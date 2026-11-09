# ADR 0040 – Feeds bay: RSS and Atom as one history

Status: accepted 2026-11-09. Extends [ADR 0036](0036-shells-survive-restart.md)
(bays in the local server).

## Context

The person wants to follow RSS feeds inside Hangar, shown like a chat: the
updates of all feeds one after another as a history. Agents should be able to
subscribe to feeds and read the entries. Requirements from the person
(2026-11-09): manage feeds in the UI and through MCP, parse with the platform
(`DOMParser`) instead of a new dependency, links open outside Hangar for now.

## Decision

- **New bay `dev.hangar.feeds`** ("Feeds") in `bays/feeds`, without host
  modules. Storage `<dataDir>/feeds.json`: subscriptions, settings and the
  history (default at most 1000 entries); the oldest drop out.
- **Fetching and parsing are split.** The main part fetches the text (a bay
  page may not read other origins), only for subscribed URLs, with a timeout of
  20 s and at most 5 MB. The UI parses RSS 2.0, RSS 1.0 and Atom with
  `DOMParser`, the newest 1000 entries of a feed, and hands them back; the main
  part bounds their lengths and stores only entries it has not seen (per feed by
  `guid`/`id`, else link, else title). It also remembers the ids of the last
  fetch, so entries that dropped out of the history do not come back.
- **Settings live in the bay, not in the manifest:** fetch interval (1–1440
  minutes, default 15) and history size (100–10000 entries, default 1000) are
  stored in `feeds.json` and edited in a modal dialog behind a gear in the bay
  header. The UI channel `settings` validates both as whole numbers in range
  and answers with a German or English message; a smaller history drops the
  oldest entries at once. Manifest `settings` would show up in Hangar's
  settings page, but the bay SDK can only read them (`ctx.settings.get`), not
  write them, so the bay could neither offer them in its own view nor keep
  both places in step.
- **The UI drives the schedule:** at start, every interval (default 15
  minutes), on "Refresh" and
  at once for a new subscription, also one an agent added. The view loads at app
  start, so this runs without the bay being shown; without a loaded view nothing
  is fetched.
- **History:** entries in the order they arrived, newest last, a line per day of
  arrival; a new fetch appends, older entries of a new feed sort by their date.
- **Functions for agents:** `feed.list`, `feed.add`, `feed.items`; not
  sensitive and **not** `openToAgents` – the subscriptions are the person's, not
  the caller's, so the first call asks (ADR 0006). `feed.add` accepts only
  http(s) URLs and rejects local and private hosts (`localhost`, `*.local`,
  `*.internal`, loopback, private, link-local and shared IPv4/IPv6 ranges,
  `node:net` `BlockList`), so an agent cannot use the host to reach the
  machine or its network (SSRF). Only the literal host is checked: a public
  name that resolves inward, or a redirect, still passes; the person, in the
  UI, may subscribe to local feeds. Entry texts come from the web; the
  description of `feed.items` says they are not instructions.
- **Links** open in the default browser (`target="_blank"`; the host opens
  http(s) pages from `window.open` there). Opening
  them in the browser bay would need a way for one bay to bring another to the
  front; left for later.
- **Location:** with a local server the bay runs there, like the board
  (ADR 0037): the server loads every bundled bay without a missing host module,
  so the app must not start a second one with its own `feeds.json`.

## Consequences

- Known gaps (review 2026-11-09): `xml:base` in Atom is ignored; unsubscribing
  and subscribing the same URL again while its fetch runs skips the immediate
  fetch until the next refresh.

- No new dependency; the parser lives in the UI and is tested in jsdom, outside
  the coverage gate of `src/main`.
- Entries only arrive while Hangar (or its local server with a connected
  view) runs.

## Alternatives

- **Manifest `settings`** (`interval`, `maxItems` as text fields in Hangar's
  settings): read-only for the bay, edited away from the history, invalid input
  silently replaced by the default; replaced by the settings dialog in the bay.

- **XML parser in the main part** (`fast-xml-parser`): fetching, parsing and
  the schedule (jobs) would run without a view; rejected for a new dependency.
- **Browser bay `tab.open`:** opens the link in a partition of the feeds bay,
  marked as an agent tab, without switching to the browser bay; rejected.
