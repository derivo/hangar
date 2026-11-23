# Review: traffic bay plan (2026-11-23)

Reviewer: Codex (`codex exec -s read-only`), on PR #40 at `80fc1b5` (ADR 0049, the
"Traffic bay" section of the roadmap, `docs/mockups/traffic-bay.html` (now `proxy-bay.html`)). A first run on
`c0d84a2` was stopped before it finished, because the grouping by project and a gap found
meanwhile were not yet in the PR.

## Context

After this review the bay was renamed to "Proxy" (`dev.hangar.proxy`, ADR
[0049-proxy-bay.md](../adr/0049-proxy-bay.md), mockup `docs/mockups/proxy-bay.html`); the
record keeps the old name.

Plan only, no product code. Codex was asked to check the plan against the code and the
mitmproxy 12.3.1 sources, not against itself. Every finding was checked here against the
named file or the installed mitmproxy 12.3.1 package before it was adopted.

## Findings

All 20 confirmed and adopted. "Checked" names what was looked at.

| #   | Sev.   | Finding                                                                                     | Checked                                                                                            | Change                                                                                                     |
| --- | ------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | high   | ADR let shells start without proxy when `mitmdump` is missing, roadmap blocked them         | ADR text, both places                                                                              | Watched sessions always block on any failure; unwatched ones are untouched                                 |
| 2   | high   | Agent bay restores shells in `activate` before a traffic bay exists                         | `bays/agents/src/main/index.ts` (`provideFunctions` then `restore`), `bay-loader.ts` sorts by name | New step 1: host activates bays in `uses` order; cold-start test                                           |
| 3   | high   | Without `hostModules` the bay would run in app and local server                             | `IN_SERVER` in `apps/desktop/src/main/index.ts`, `startable()` in `host.ts`                        | Traffic joins `IN_SERVER`, data move, Linux package and Dockerfile                                         |
| 4   | high   | Addon outside `dist/` is not shipped; bays sit in `app.asar`                                | `scripts/create-bay.mjs` filter `dist/**`, `local-server.ts` path `app.asar/bays`                  | Addon built to `dist/addon/`, `asarUnpack`, packaged smoke test                                            |
| 5   | high   | `regular@<port>` binds all interfaces                                                       | mitmproxy `options.py`: `listen_host` default `""`                                                 | `listen_host=127.0.0.1`, `regular@127.0.0.1:<port>`, no default listener, bound addresses tested           |
| 6   | high   | Inherited lower-case `https_proxy`/`no_proxy` survive                                       | `environment()` merges `process.env` and session values                                            | Proxy variables in both cases, applied last; spike and unit test with `no_proxy=*`                         |
| 7   | high   | No command channel or bind confirmation; `isPortFree` only probes                           | `bays/agents/src/main/ports.ts` closes the probe socket                                            | JSON lines both ways with request id, `reply` after bind, timeouts                                         |
| 8   | high   | Memory limits do not bound the Python process                                               | mitmproxy `proxy/layers/websocket.py` appends to `flow.websocket.messages`                         | Streaming set in `responseheaders`/`requestheaders`, unknown length, messages cleared, bounded queues      |
| 9   | medium | `proxyauth` cannot tie a password to a port                                                 | mitmproxy `addons/proxyauth.py`: validator `(username, password)` only                             | Addon checks credentials per listener (`client_conn.proxy_mode`)                                           |
| 10  | medium | Port lifecycle on restart undefined                                                         | `types.ts`: "A restarted shell is no end"                                                          | `proxy.env` idempotent per session, port kept over restarts, no reuse for 60 s                             |
| 11  | medium | Renewing the CA file does not reload mitmproxy                                              | design                                                                                             | Ordered renewal: block answers, write atomically, restart engine                                           |
| 12  | medium | Bundle replaces inherited trust, no Windows                                                 | design; user chose Windows in scope                                                                | Bundle per session with inherited certificates, Windows via `tls.getCACertificates('system')`, upstream CA |
| 13  | medium | URL secrets not redacted; "Copy as curl" promised too much; upstream headers must stay      | design                                                                                             | Redact serialized copy only, query and user info included, body warnings; test upstream gets original      |
| 14  | medium | `ignore_hosts` takes regular expressions and yields no flow rows                            | mitmproxy `addons/next_layer.py`: `re.compile(x, re.IGNORECASE)`                                   | Escaped and anchored entries, `tunnel` rows from connection hooks                                          |
| 15  | medium | `proxy.status` not in `uses`; no API to open another bay filtered                           | `bay-runtime.ts` `call` checks `uses`                                                              | `proxy.status` in `uses`; link from the agent bay dropped (user decision)                                  |
| 16  | medium | Status light, agent and active watching have no source                                      | `session.info` returns `projectId`, `project`, `name` only                                         | `session.info` gains `color`, `status`, `agent`, `watchActive` (user decision)                             |
| 17  | medium | Local HTTPS test server is in `NO_PROXY`                                                    | design                                                                                             | Test host `traffic-test.invalid` outside `NO_PROXY`, test CA as upstream CA, MCP stays direct              |
| 18  | medium | Rules not specified; settings are only text or check box                                    | `packages/sdk/src/manifest.ts` `SettingSchema`                                                     | Rule format `class host[/path-prefix]`, first match, validated text settings, defaults listed              |
| 19  | medium | "Pause" has no defined behaviour                                                            | design                                                                                             | Pause stops recording, traffic goes on, marker row (user decision); test                                   |
| 20  | medium | Mockup: selecting re-renders rows and drops focus; lights only by color; panel not labelled | mockup script                                                                                      | Rows built once, one button per row, status text for screen readers, `aria-labelledby`                     |

Codex marked as correct: several `--mode` listeners and changing them at run time,
`client_conn.proxy_mode`, `response.stream` as a function, `websocket_message`,
`ignore_hosts` for TLS pass-through. Unverifiable until step 0: whether both agents send
proxy credentials.

## Decisions by the person

Asked before the rework: link from the agent bay (dropped), pause (stops recording),
platforms (Windows included), `session.info` (extended).

## Verification

- Mockup, own script with Playwright and `@axe-core/playwright` (WCAG 2.2 AA tags): 0
  violations light and dark, project groups open and collapsed; click keeps focus on the
  selected row, ↓ moves it, one tab stop in the table, panel labelled by the active tab,
  "Pause" turns into "Fortsetzen"; 640 × 430 viewport (200 % of 1280 × 860) without
  horizontal page scroll. The last check failed first (the screen-reader text escaped the
  scrolling table); fixed by positioning the scroll containers.
- `prettier --check` on the changed files.

## Second round

On `4fd1177` (after the rename to "Proxy" and the agent functions `flow.list`/`flow.get`).
15 findings, all confirmed and adopted; checked against the code and the installed
mitmproxy 12.3.1 package.

| #   | Sev.   | Finding                                                                                     | Checked                                                                                  | Change                                                                                        |
| --- | ------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | high   | First-round 2 still open: agent and proxy bay name each other, `uses` order falls back      | plan text; `bays/agents/src/main/index.ts` restores in `activate`                        | Step 1 is now `ctx.onBaysStarted`; the agent bay restores there                               |
| 2   | high   | Per-request credential check breaks HTTPS inside an authenticated CONNECT; URLs lacked them | mitmproxy `addons/proxyauth.py` keeps `authenticated` per client connection              | Check at `http_connect`, then per connection; credentials in the URLs; header removed         |
| 3   | high   | Flows keyed only by session id; same id from another bay or origin                          | `bays/browser/src/main/index.ts` partitions by `bayId` and `sessionId`                   | Key by origin and session; only `dev.hangar.agents` callers; negative tests                   |
| 4   | high   | "Per session" release does not exist for non-sensitive functions                            | `packages/bus/src/bus.ts` `authorize`: non-sensitive answers become permanent allow/deny | `flow.list`/`flow.get` are `sensitive`; bus test over two sessions                            |
| 5   | high   | Dumper and log write to the same stdout, unredacted                                         | mitmproxy `addons/dumper.py` writes to `sys.stdout`, option `flow_detail`                | `flow_detail=0`, `termlog_verbosity=error`, log to stderr; test: stdout only JSON lines       |
| 6   | high   | Fragmented WebSocket messages buffer before the hook; queues not bounded by bytes           | design                                                                                   | 16 MB limit with error row, queues 8 MB, spike point                                          |
| 7   | medium | Connection hooks give no byte counts for passed hosts                                       | mitmproxy `options.py` `show_ignored_hosts`, `next_layer.py`                             | `show_ignored_hosts=true`, bytes from `tcp_message`, test with known sizes                    |
| 8   | medium | Pass-through only for port 443                                                              | design                                                                                   | `passThrough({ host, port })`, anchored `host:port`, 8443 test                                |
| 9   | medium | Without engine a watched session can neither start nor be switched off                      | plan text                                                                                | Only switching on is disabled; test switching off                                             |
| 10  | medium | Upstream trust uses certifi; the trusted-CA option replaces it                              | mitmproxy `net/tls.py` loads `certifi.where()` by default                                | `upstream.pem` from system roots plus `upstreamCaFile`; public and company CA tested together |
| 11  | medium | Rewriting the bundle in place mixes old and new trust                                       | design                                                                                   | Bundle generations, never rewritten; effects per shell state specified                        |
| 12  | medium | MCP contract of `flow.list`/`flow.get` not specified                                        | plan text                                                                                | Schemas, ISO 8601, exclusive `since`, nullable fields, limit per direction                    |
| 13  | medium | Mockup still promised full redaction                                                        | mockup                                                                                   | "Copy as curl (headers redacted)", body warning at detail, copy and export                    |
| 14  | medium | Performance criterion not measurable from a trace                                           | design                                                                                   | Scroll run with frame timing, 95th percentile below 25 ms on CI macOS                         |
| 15  | low    | HAR export both out of scope and planned                                                    | plan text                                                                                | Moved into the decision                                                                       |

Verification of the mockup after round 2: axe 0 violations light and dark, groups open
and collapsed; focus, arrow keys, visible panel and 640 × 430 without horizontal scroll by
script; `prettier --check`.

## Third round

On `5cc531b`. A first run hung on standard input and was restarted with
`< /dev/null`. 4 findings, all confirmed and adopted.

| #   | Sev.   | Finding                                                                      | Checked                                                                                                | Change                                                                                                                     |
| --- | ------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | high   | Round 2 #6 still open: the 16 MB limit has no point where it can act         | mitmproxy `proxy/layers/websocket.py`: `frame_buf` grows before `WebsocketMessageHook`, no size option | Addon wraps `WebsocketLayer._handle_event`, closes with 1009 above 16 MB; mitmproxy `>=12.3,<13` only; spike without FIN   |
| 2   | medium | Fixed bundle path keeps old trust when a restart brings other certificates   | `bays/agents/src/main/sessions.ts`: an `env` change calls `restart`                                    | Bundle path carries a content hash; port and credentials stay; test that the old file is unchanged                         |
| 3   | medium | Round 2 #12 partly open: bodies and messages lack encoding and kind          | ADR text                                                                                               | `{ encoding, data }`, `direction: 'up' \| 'down'`, `kind`, headers as pairs, `truncated` typed; text and binary test cases |
| 4   | medium | "Consequences" still named activation order by `uses`, which the ADR rejects | ADR text, both places                                                                                  | Consequence is now `ctx.onBaysStarted` and the move of `restore()`                                                         |

The mockup did not change in this round.
