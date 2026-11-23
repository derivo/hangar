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
  5 s per command. Both queues are bounded (1 000 lines); the addon drops
  events beyond that and reports the count.
- **Listeners only on loopback.** `mitmdump` starts with `--set
listen_host=127.0.0.1` and without a default listener; each session gets
  `regular@127.0.0.1:<port>`. The integration test checks the bound addresses.
- **Start order.** The server activates bays in alphabetical order, and the
  agent bay restores shells in `activate` right after offering its functions
  (`bays/agents/src/main/index.ts`), before a proxy bay would exist. The
  host therefore activates bays in the order of their `uses`: a bay whose
  `uses` names a bay that runs in the same process is activated after it
  (cycles: alphabetical as today, with a warning). A missing bay stays an
  error of the call.

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
  case: `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` (each
  `http://127.0.0.1:<port>`), `NO_PROXY=localhost,127.0.0.1,::1` (Hangar's own
  MCP server stays direct). CA variables: `NODE_EXTRA_CA_CERTS`,
  `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`,
  `CODEX_CA_CERTIFICATE`, `GIT_SSL_CAINFO`, each pointing to a bundle of the
  session (see "Trust"). Inherited values of these names are not lost: they
  go into that bundle.
- **Proxy credentials.** mitmproxy's `proxyauth` has one validator for all
  listeners, so it cannot tie a password to a port. The addon checks the
  `Proxy-Authorization` of each request against the password of the listener
  it arrived on (`client_conn.proxy_mode`) and answers 407 otherwise. Whether
  both agents send credentials from `HTTPS_PROXY` is checked in step 0; if one
  does not, ports run without credentials and the threat model names that.

### Trust

- **CA per installation, never in a system trust store.** The bay creates the
  CA in `<dataDir>/ca/` (folder 0700). mitmproxy's `mitmproxy-ca.pem` holds
  certificate and key (0600); sessions only get `mitmproxy-ca-cert.pem`.
- **Bundle per session** in `<dataDir>/bundles/<session>.pem`: the system roots
  plus inherited extra certificates (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`
  etc. of the merged environment) plus the CA. System roots: macOS
  `/etc/ssl/cert.pem`, Linux `/etc/ssl/certs/ca-certificates.crt` or
  `/etc/pki/tls/certs/ca-bundle.crt`, Windows the certificate store `ROOT`
  exported via `tls.getCACertificates('system')` (Node 22.15+). Without any
  source the start fails with the reason.
- **Upstream trust is separate.** mitmproxy verifies servers against the
  system roots plus the setting `upstreamCaFile` (for company CAs); never
  `ssl_insecure`.
- **Renewing the CA** is ordered: block new `proxy.env` answers, write the new
  CA and bundles atomically, restart the engine with its listeners, then
  answer again. Running shells keep the old bundle and fail TLS until they are
  restarted; the UI says so.

### Capture

- **Streaming stays live.** In `responseheaders` the addon sets
  `flow.response.stream` to a function for `text/event-stream`, bodies above
  1 MB and bodies of unknown length; requests above 1 MB likewise with
  `flow.request.stream`. The function forwards chunks to the bay up to the
  body limit and passes all data on. WebSocket messages are forwarded from
  `websocket_message` and then removed from `flow.websocket.messages`, so
  mitmproxy does not keep a second history.
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
  this host". The bay escapes the host and anchors it (`^host:443$`) for
  `ignore_hosts`, which takes regular expressions; it applies from the next
  connection. The addon reports passed connections as `tunnel` rows from its
  connection hooks (host, bytes, duration, no content).

### Sorting by project

- Every flow carries its session id (from its listener). The bay maps it to
  project, name, tab color, status, agent and whether watching is active
  through `dev.hangar.agents/session.info`, extended by `color`, `status`,
  `agent` and `watchActive` (the shell runs with the proxy variables), and
  `dev.hangar.agents/project.list` (order of the projects). Both are
  `bayOnly` and in its `uses`. It asks at `proxy.env` and when the UI asks for
  its state, at most every 5 s per session; an ended session keeps the last
  values. The UI groups sessions under their project.

### Functions for agents

- An agent reads the traffic of its own session, for example to check which
  requests a tool sent or why one failed. Two MCP tools, like those of the
  browser bay:
  - `flow.list({ since?, classes?, text?, limit? })`: newest first, at most
    200, each `{ id, time, method, url, status, class, bytesUp, bytesDown,
durationMs, error? }`.
  - `flow.get({ id })`: one flow with redacted headers, bodies up to 100 000
    characters per direction (`truncated`), stream events or WebSocket
    messages up to the same limit.
- **Own session only.** The bay takes the session from the caller
  (`caller.kind === 'session'`, or `local-server` with its `sessionId`, as the
  browser bay does for its partitions); a flow of another session is
  `Unknown flow`. A caller without a session gets `No session`; the functions
  are not `remote`.
- **Permission as usual** (ADR 0006): neither `sensitive` nor `openToAgents`;
  the person releases them per session or permanently.
- Same redaction as in the UI. The bodies are the session's own traffic,
  including what other programs of its shell sent (for example a `curl` with a
  token in the body); the description of the tools says so.

### Out of scope

- **No link from the agent bay** to a filtered proxy bay: bays cannot open
  another bay with arguments (`packages/sdk/src/types.ts`); counters and
  filters are in the proxy bay.
- **Export as HAR** (UI only), redacted as stored, to a file the person picks.

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
  A native engine in Node can replace mitmproxy later behind the same
  protocol.
- Host change: activation order by `uses` (affects all bays, own test).
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
