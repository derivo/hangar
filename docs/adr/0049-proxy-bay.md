# ADR 0049 – Proxy bay: watch what agent sessions send and receive

Status: proposed 2026-11-23, revised after the Codex review
([reviews/2026-11-23-traffic-bay-plan.md](../reviews/2026-11-23-traffic-bay-plan.md)).
Builds on [ADR 0004](0004-bay-runtime.md) (bay runtime),
[ADR 0021](0021-password-bay.md) (a bay hands values to the agent bay at shell
start), [ADR 0032](0032-manifest-permissions.md) (`uses`),
[ADR 0036](0036-shells-survive-restart.md) (agent bay in the local server) and
[ADR 0037](0037-board-bay.md) (`session.info`, `project.list`). UI mockup:
[mockups/proxy-bay.html](../mockups/proxy-bay.html). Plan:
[roadmap.md – Proxy bay](../roadmap.md#proxy-bay).

## Context

The person wants to see everything an agent session sends and receives over the
network: model API calls, telemetry, MCP servers, package registries, sorted by
the projects of the agent bay. Today a session shell inherits the environment
and talks to the internet directly; Hangar sees only the calls that reach its
own bus.

A manual test on 2026-11-23 with mitmproxy 12.3.1 on `127.0.0.1` showed that
both agents can be watched without changing them:

- `claude -p` with `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS` (CA of mitmproxy):
  `POST api.anthropic.com/v1/messages`, `event_logging`, `metrics`, Datadog,
  `mcp-proxy.anthropic.com`, `api.githubcopilot.com/mcp/`, npm registry – all
  decrypted, exit code 0.
- `codex exec` with `HTTPS_PROXY`, `SSL_CERT_FILE` and `CODEX_CA_CERTIFICATE`:
  `chatgpt.com/backend-api/codex/responses`, `analytics-events`, plugins, MCP –
  decrypted, exit code 0. Which of the two CA variables Codex needs is open.
- Not checked: whether any connection bypasses the proxy.

The captured file held access tokens in plain text.

## Decision

### Bay and engine

- **New bay `dev.hangar.proxy`** ("Proxy" in both languages, so it is unmistakable). Its main part
  runs a local intercepting proxy, its UI lists the flows per project and
  session. It has no `hostModules`. Like the agent bay it belongs to the local
  server (ADR 0036): it joins `IN_SERVER` in `apps/desktop/src/main/index.ts`,
  so the desktop does not start a second engine, store and CA, and it joins
  the data move to and back from the server. ADR 0041 machines ship it too
  (`docker/linux-server/Dockerfile`, `scripts/linux-server-package.mjs`).
- **Engine: mitmproxy, not an own TLS interceptor.** The bay starts `mitmdump`
  as a child process with an addon shipped in the bay. The build copies it to
  `dist/addon/hangar_proxy.py`; `electron-builder.yml` unpacks it from
  `app.asar` (`asarUnpack`), because an external Python cannot read inside the
  archive. mitmproxy is not bundled: the bay looks for `mitmdump` on `PATH` or
  in the setting `mitmdumpPath`.
- **Control protocol in both directions.** Events from the addon arrive as
  JSON lines on stdout (`flow.request`, `flow.response`, `flow.error`,
  `stream.chunk`, `ws.message`, `tunnel`, `tls.failed`, `reply`). Commands go
  as JSON lines on stdin with a request id (`listen`, `unlisten`, `rules`,
  `capture`, `ignore`); the addon answers each with `reply` (`ok` or `error`,
  for `listen` after the listener is bound or failed). The bay waits at most
  5 s per command. Both queues are bounded by lines (1 000) and bytes
  (8 MB); the addon drops events beyond that and reports the count. stdout
  carries only these lines: `mitmdump` runs with `flow_detail=0` and
  `termlog_verbosity=error`, and the addon sends mitmproxy's own log to
  stderr, so neither unredacted flow dumps nor log text reach the bay.
- **Listeners only on loopback.** `mitmdump` starts with `--set
listen_host=127.0.0.1` and without a default listener; each session gets
  `regular@127.0.0.1:<port>`. The integration test checks the bound addresses.
- **Start order.** The server activates bays in alphabetical order, and the
  agent bay restores shells in `activate` right after offering its functions
  (`bays/agents/src/main/index.ts`), before a proxy bay would exist. Ordering
  by `uses` does not help: agent bay and proxy bay name each other. Instead
  the SDK gets `ctx.onBaysStarted(listener)`, called once after every bay of
  the process has finished `activate`; the agent bay moves `restore()` there.
  A bay that is missing then stays an error of the call.

### Sessions

- **Opt-in per session**, default for new sessions from the project, default
  off. Only the agent bay switches it; the proxy bay shows the state.
- **Hand-over at shell start like passwords (ADR 0021).** If `watchTraffic` is
  on, the agent bay calls `dev.hangar.proxy/proxy.env({ sessionId, inherited })` (`inherited`: the CA variables of the merged environment)
  (`bayOnly`, in its `uses`) before `spawnShell`, also for restored sessions.
  The shell starts only with an answer. A missing proxy bay, a missing
  `mitmdump`, a failed engine or a timeout write `Shell not started: <reason>`
  and report `session.exit` -1. A watched session never runs unwatched;
  unwatched sessions are not affected by any of this.
- **One port per session, stable.** `proxy.env` is idempotent: the first call
  binds a port (bind confirmed by `reply`, not by `isPortFree`, which only
  probes), later calls of the same session return the same port and
  variables. Restarting the shell keeps the port, so jobs started with the old
  environment keep working. `onAgentSessionEnded` unbinds it; open
  connections are closed and their flows stay with the old session. A port
  freed this way is not reused for 60 s.
- **Environment.** The agent bay applies the answer after merging process and
  session environment, so it wins over both. Variables, in upper and lower
  case: `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` (each the URL of the session's
  port, with credentials, see below), `NO_PROXY=localhost,127.0.0.1,::1` (Hangar's own
  MCP server stays direct). CA variables: `NODE_EXTRA_CA_CERTS`,
  `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`,
  `CODEX_CA_CERTIFICATE`, `GIT_SSL_CAINFO`, each pointing to a bundle of the
  session (see "Trust"). Inherited values of these names are not lost: they
  go into that bundle.
- **Proxy credentials.** Each port has a random password; the proxy URLs
  then read `http://hangar:<password>@127.0.0.1:<port>`. mitmproxy's
  `proxyauth` has one validator for all listeners, so the addon checks
  instead: plain HTTP requests by their `Proxy-Authorization`, HTTPS once at
  `http_connect`, after which the client connection counts as authenticated
  (requests inside the tunnel carry no such header), each against the
  password of the listener (`client_conn.proxy_mode`); otherwise 407. It
  removes `Proxy-Authorization` before forwarding. Whether both agents send
  credentials from `HTTPS_PROXY` is checked in step 0; if one does not, ports
  run without credentials and the threat model names that.

### Trust

- **CA per installation, never in a system trust store.** The bay creates the
  CA in `<dataDir>/ca/` (folder 0700). mitmproxy's `mitmproxy-ca.pem` holds
  certificate and key (0600); sessions only get `mitmproxy-ca-cert.pem`.
- **Bundle per session, CA generation and content** in
  `<dataDir>/bundles/<generation>/<session>-<hash>.pem` (`hash`: first 16 hex
  digits of SHA-256 over the bundle), never rewritten in place: the system roots
  plus inherited extra certificates (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`
  etc. of the merged environment) plus the CA. System roots: macOS
  `/etc/ssl/cert.pem`, Linux `/etc/ssl/certs/ca-certificates.crt` or
  `/etc/pki/tls/certs/ca-bundle.crt`, Windows the certificate store `ROOT`
  exported via `tls.getCACertificates('system')` (Node 22.15+). Without any
  source the start fails with the reason. A repeated `proxy.env` keeps port
  and credentials but builds the bundle again from the given `inherited`: when
  a shell restarts with other certificate variables (`session.env` changes
  restart the shell), it gets a new path; the old file stays unchanged.
- **Upstream trust is separate.** mitmproxy 12.3.1 uses certifi by default,
  and `ssl_verify_upstream_trusted_ca` replaces that default instead of adding
  to it. The bay therefore writes `<dataDir>/upstream.pem` from the system
  roots (as above) plus the setting `upstreamCaFile` (for company CAs) and
  passes it as `ssl_verify_upstream_trusted_ca`; never `ssl_insecure`.
- **Renewing the CA** is ordered: block new `proxy.env` answers, create the
  new CA and a new bundle generation, restart the engine with its listeners,
  clear the cached `proxy.env` answers, then answer again. Effects: a shell
  restarted afterwards gets the new generation and works; a running shell
  keeps pointing to the old generation, so its processes, old and new, fail
  TLS until the shell is restarted; the UI names these sessions. Old
  generations are removed when no session uses them.

### Capture

- **Streaming stays live.** In `responseheaders` the addon sets
  `flow.response.stream` to a function for `text/event-stream`, bodies above
  1 MB and bodies of unknown length; requests above 1 MB likewise with
  `flow.request.stream`. The function forwards chunks to the bay up to the
  body limit and passes all data on. WebSocket messages are forwarded from
  `websocket_message` and then removed from `flow.websocket.messages`, so
  mitmproxy does not keep a second history. mitmproxy 12.3.1 collects the
  fragments of an unfinished message in `WebsocketConnection.frame_buf`
  (`proxy/layers/websocket.py`) before that hook and has no size option, so no
  hook sees them. The addon therefore wraps `WebsocketLayer._handle_event`:
  after each received event it sums `frame_buf` of both sides; above 16 MB it
  closes both sides with code 1009 (message too big), drops the buffer and
  sends a `ws.tooLarge` row. The wrapper touches a private API: the bay
  supports mitmproxy `>=12.3,<13` only, the addon reports
  `mitmproxy.version.VERSION` at start and the engine refuses other versions
  with the reason (`proxy.status` `failed`). Step 0 proves the abort without a
  final fragment.
- **Storage: memory only, redacted copies.** Flows live in a ring buffer
  (default 5 000 flows or 200 MB). Only the serialized copy for Hangar is
  redacted; the request upstream keeps its headers. Redacted: values of
  `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`,
  `x-api-key`, of headers matching `/token|secret|key|auth/i`, of query
  parameters matching the same pattern, and user info in URLs; shown as
  `•••• (n chars)`. Bodies are kept up to 1 MB per direction (`truncated`);
  they may contain secrets, which the UI states at the detail view, at "Copy
  as curl" and at the export.
- **Pause stops recording, not traffic.** While paused, requests of watched
  sessions pass as usual but are neither stored nor counted; the addon stops
  sending events (`capture false`). Resuming inserts a row "Paused from … to
  …".
- **Classification** by rules `class host[/path-prefix]`, one per line,
  first match wins, host exact or `*.domain`; defaults in the plan. Settings
  of the SDK are text or check box only (`packages/sdk/src/manifest.ts`), so
  numbers and rules are text settings validated by the bay; an invalid line
  is named in the UI and the default applies.
- **Pass-through hosts** (pinning): a `tls.failed` row offers "Pass through
  this host" with host and port of the failed connection. The bay escapes and
  anchors both (`^host:port$`) for `ignore_hosts`, which takes regular
  expressions; it applies from the next connection. With
  `show_ignored_hosts=true` mitmproxy keeps a TCP flow for passed
  connections; the addon counts bytes in `tcp_message`, then drops the
  message, and reports a `tunnel` row (host, port, bytes each way, duration,
  no content).

### Sorting by project

- Every flow carries its session id (from its listener). The bay maps it to
  project, name, tab color, status, agent and whether watching is active
  through `dev.hangar.agents/session.info`, extended by `color`, `status`,
  `agent` and `watchActive` (the shell runs with the proxy variables), and
  `dev.hangar.agents/project.list` (order of the projects). Both are
  `bayOnly` and in its `uses`. It asks at `proxy.env` and when the UI asks for
  its state, at most every 5 s per session; an ended session keeps the last
  values. The UI groups sessions under their project.

### Export

- **HAR 1.2 from the UI**, redacted as stored, to a file the person picks,
  with the warning about bodies. Agents cannot export.

### Functions for agents

- An agent reads the traffic of its own session, for example to check which
  requests a tool sent or why one failed. Two MCP tools, like those of the
  browser bay:
  - `flow.list({ since?, classes?, text?, limit? })` → `{ flows, more }`:
    newest first; `since` an ISO 8601 time, only flows started after it
    (exclusive); `limit` 1–200, default 50; `more` true if older ones match.
    Each flow `{ id, time (ISO 8601, start), method, url, status (number |
null while open or failed), class, bytesUp, bytesDown, durationMs (number
| null while open), state ('open' | 'done' | 'failed' | 'tunnel'), error
(string | null) }`.
  - `flow.get({ id })` → the same fields plus `requestHeaders`,
    `responseHeaders` (redacted, `[name, value][]` in wire order, repeated
    names kept), `requestBody`, `responseBody` (`{ encoding: 'utf8' |
'base64', data } | null`: `utf8` when the bytes decode as UTF-8, otherwise
    `base64`; `null` if none), `messages` (`{ time, direction: 'up' | 'down',
kind: 'sse' | 'ws-text' | 'ws-binary', encoding: 'utf8' | 'base64', data }[]`;
    `up` is client to server; `ws-binary` always `base64`) and `truncated`
    (`{ up: boolean, down: boolean }`). The 100 000 characters of `data` count
    per direction across body and messages together.
- **Own session only.** Flows are keyed by origin and session: the agent
  bay's `proxy.env` call fixes the key (`dev.hangar.agents` of this process,
  or `local-server:dev.hangar.agents` on the desktop side) for its session id.
  A caller is accepted only as `{ kind: 'session', bayId:
'dev.hangar.agents', sessionId }` (or the `local-server` form with the same
  bay), as the browser bay builds its partitions from `bayId` and
  `sessionId`; the same session id from another bay or origin gets nothing.
  A flow of another session is `Unknown flow`; a caller without a session
  gets `No session`; the functions are not `remote`.
- **Permission per session** (ADR 0006): both are `sensitive`, because only
  sensitive functions can be released for one session
  (`packages/bus/src/bus.ts`, `authorize`); a non-sensitive release would
  hold for every session of the agent bay. Not `openToAgents`.
- Same redaction as in the UI. The bodies are the session's own traffic,
  including what other programs of its shell sent (for example a `curl` with a
  token in the body); the description of the tools says so.

### Out of scope

- **No link from the agent bay** to a filtered proxy bay: bays cannot open
  another bay with arguments (`packages/sdk/src/types.ts`); counters and
  filters are in the proxy bay.

## Threat model (short)

- Whoever holds the CA key can read the traffic of every process that trusts
  the CA. Only watched session shells trust it; the key lies in the bay's data
  folder, readable by the user account – agents run as that account without a
  sandbox (bay ideas 2) and could read it anyway.
- Without proxy credentials any local process can use a session's port; its
  traffic would show as that session's and be intercepted the same way.
  Listening only on `127.0.0.1` limits this to the own machine.
- Tools that ignore proxy variables bypass the bay; step 0 measures the
  agents, the UI says "Only traffic that uses the proxy is shown".
- An agent with released `flow.get` reads bodies of everything its shell
  sent, also of programs it did not start itself in that shell.
- Captured bodies can contain secrets the redaction misses. They stay in
  memory; detail view, copy and export warn.

## Consequences

- A watched session depends on a running `mitmdump`. If it crashes, the bay
  restarts it (backoff 1 s, 5 s, 30 s) with the same ports and reports the
  outage; meanwhile requests of watched sessions fail instead of going out
  unwatched.
- Python dependency for those who use the bay; on Windows `mitmdump.exe`.
- The WebSocket limit wraps a private mitmproxy method: the bay supports
  mitmproxy `>=12.3,<13`; a new major version needs the spike point again.
  A native engine in Node can replace mitmproxy later behind the same
  protocol.
- Host change: SDK event `ctx.onBaysStarted`, called once after every bay of
  the process has finished `activate` (own test); the agent bay moves
  `restore()` there.
- Two new MCP tools (`dev.hangar.proxy/flow.list`, `flow.get`), documented in
  `docs/mcp.md`.
- Agent bay change: `session.info` gains four fields, `watchTraffic` on
  projects and sessions.

## Rejected

- **Own interceptor in Node** (for example `http-mitm-proxy` with
  `node-forge`): TLS interception, HTTP/2 and WebSockets are security-relevant
  and mature in mitmproxy.
- **Proxy in front of the whole app or the system** (system proxy, PAC): would
  capture the person's own traffic and needs the CA in the system trust store.
- **Packet capture** (`pcap`, Network Extension): sees only encrypted TLS and
  needs elevated rights.
- **Reading agent logs** instead of a proxy: incomplete, different per agent,
  no telemetry.
- **A function of the agent bay to switch watching from the proxy bay**:
  one place to switch is enough.
