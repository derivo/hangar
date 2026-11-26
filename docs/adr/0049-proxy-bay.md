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
  decrypted, exit code 0.

The spike of step 0 answered the open points; see "Spike results" below.

The captured file held access tokens in plain text.

## Spike results (step 0, 2026-11-23)

macOS, mitmproxy 12.3.1, `claude` 2.1.330, `codex` with its default plugins and
MCP servers. Throwaway scripts with a spike addon that already used the
protocol, credential check and WebSocket limit of this ADR.

| #   | Question                              | Command                                                                                                                                                                                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Listeners at run time, bind confirmed | `ctx.options.update(mode=…)`, then wait until `proxyserver.servers` holds the instance and `is_running` or `last_exception` is set, `lsof -iTCP -sTCP:LISTEN`                                                                               | Third listener added and removed; reply after bind with the bound address; `lsof` showed only `127.0.0.1:<port>`; after removal the port refused; a keep-alive connection on another listener kept working                                                                                                                                                                                                                                                                                                                                                                                        |
| 2   | Proxy credentials per listener        | raw requests; `claude -p`, `codex exec`, `git ls-remote`, `curl` with `http://hangar:<pw>@127.0.0.1:<port>`                                                                                                                                 | No or other listener's credentials: 407 (plain HTTP and CONNECT). CONNECT with credentials, then two requests in the tunnel: 200. Upstream never saw `Proxy-Authorization`. `claude`, `codex` and `curl` send credentials at once; `git` first without, then after the 407 (`anyauth`); with `GIT_HTTP_PROXY_AUTHMETHOD=basic` at once                                                                                                                                                                                                                                                            |
| 3   | Codex CA variable                     | `codex exec` once with only `SSL_CERT_FILE`, once with only `CODEX_CA_CERTIFICATE`, once with none                                                                                                                                          | Either variable alone works (exit 0, about 30 flows). Without one Codex hangs (killed after 60 s) and opens a direct connection from the `codex` process (`172.64.155.209:443`)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 4   | Bypass                                | `lsof -i -a -p <pids>` every 100 ms over the process tree, inherited `https_proxy=http://127.0.0.1:9` and `no_proxy=*` overridden                                                                                                           | `claude`: no connection outside the proxy except `127.0.0.1:7332` (in `NO_PROXY`); its MCP children went through it. `codex`: the MCP server it starts (`npx @playwright/mcp`, `node`) connected directly to `104.16.x.34:443` (npm registry) in every run. Cause: Codex (0.160.1) hands MCP servers it starts only the variables named in their `env_vars`; with `-c 'mcp_servers.playwright.env_vars=["HTTPS_PROXY","https_proxy",…,"NODE_EXTRA_CA_CERTS","SSL_CERT_FILE"]'` the npm registry went through the proxy, no direct connection (2 of 2 runs). The override held: no run used port 9 |
| 5   | Streaming, time to first token        | `claude -p … --output-format stream-json --include-partial-messages`, two runs each, first `text_delta`                                                                                                                                     | Through the proxy 7.76 s and 5.17 s, direct 7.44 s and 6.33 s: no delay measurable at this sample size                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | WebSocket                             | `codex exec`; own client sending 20 × 1 MB fragments without the final one, four times; 10 min of 1 KB messages                                                                                                                             | `codex/responses` arrives in `websocket_message` (21 messages). The limit must wrap `WebsocketLayer.relay_messages`, not `_handle_event` (reassigned per instance in `start`). Abort after 16.06 MB each time, close code 1009 seen by client and server, `ws.tooLarge` row. RSS 108, 113, 114, 120 MB after the four aborts (buffer freed, about 4 MB left each time, cause not checked). Soak with clearing: 263 100 messages of 1 KB in 10 min, RSS 80.0 MB at minute 0 and 81.5 MB at minute 9                                                                                                |
| 7   | Windows                               | GitHub Actions `windows-latest` (Windows Server 2025), mitmproxy 12.3.1 via `uv tool install`, Electron 45.1.0 as Node, points 1, 2 and 6 with the macOS script, `curl.exe` and `git` through the proxy (throwaway branch, run 45224374007) | Points 1, 2 and 6 as on macOS (after removal the port times out instead of refusing; `netstat` shows it closed). Node 24.22.1, `tls.getCACertificates('system')` returns 830 roots, the bundle has 1.5 MB. `curl.exe` (schannel) rejects CA files above 1 MB and checks revocation: only a CA-only file plus `--ssl-no-revoke` works. Git for Windows uses schannel and ignores `GIT_SSL_CAINFO` (`SEC_E_UNTRUSTED_ROOT`); with `http.sslBackend=openssl` set through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` it works. Not run: both agents (no login on the runner)          |

Changed in this ADR: the WebSocket wrapper targets `relay_messages`; the
listener reply waits for the server instance; `GIT_HTTP_PROXY_AUTHMETHOD=basic`
joins the variables, on Windows with the Git variant (curl.exe has none); the threat model names the Codex MCP bypass and its cause.

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
  `dist/addon/hangar_proxy.py`; at activation the bay copies it into its data
  folder (`addon/hangar_proxy.py`), because in the app it lies in `app.asar`,
  which an external Python cannot read (`asarUnpack` does not reach files that
  `electron-builder.yml` maps in from `bays/`). mitmproxy is not bundled: the bay looks for `mitmdump` on `PATH` or
  in the setting `mitmdumpPath`.
- **Control protocol in both directions.** Events from the addon arrive as
  JSON lines on stdout (`hello` with the version, `flow.request`,
  `flow.response`, `flow.done`, `flow.error`, `stream.chunk`, `ws.message`,
  `ws.tooLarge`, `tunnel`, `tls.failed`, `dropped`, `reply`). Commands go
  as JSON lines on stdin with a request id (`listen`, `unlisten`, `rules`,
  `capture`, `ignore`); the addon answers each with `reply` (`ok` or `error`,
  for `listen` after the listener is bound or failed: after
  `ctx.options.update(mode=…)` the addon waits until the server instance of the
  mode is running or has `last_exception`). The bay waits at most
  5 s per command. Both queues are bounded by lines (1 000) and bytes
  (8 MB); the addon drops events beyond that and reports the count. stdout
  carries only these lines: `mitmdump` runs with `flow_detail=0` and
  `termlog_verbosity=error`, and the addon sends mitmproxy's own log to
  stderr, so neither unredacted flow dumps nor log text reach the bay.
- **Listeners only on loopback.** `mitmdump` starts with `--set
listen_host=127.0.0.1` and without a default listener (`server=false` until
  the first `listen`: an empty `mode` is refused); each session gets
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
  and report `session.exit` -1. A watched session never starts without its
  proxy variables; unwatched sessions are not affected by any of this. What
  goes through the proxy is watched; a process that ignores the variables or
  falls back to a direct connection is not (see the threat model).
- **One port per session, stable.** `proxy.env` is idempotent: the first call
  binds a port (bind confirmed by `reply`, not by `isPortFree`, which only
  probes), later calls of the same session return the same port and
  variables. Restarting the shell keeps the port, so jobs started with the old
  environment keep working. `onAgentSessionEnded` unbinds it; open
  connections are closed: removing a listener in mitmproxy only closes its
  listening socket (`proxy/mode_servers.py`), so the addon closes the client
  connections of the removed one from `proxyserver.connections` (their
  `proxy_mode` names the port); connections of other listeners stay. Their
  flows stay with the old session. A port
  freed this way is not reused for 60 s.
- **Environment.** The agent bay applies the answer after merging process and
  session environment, so it wins over both. Variables, in upper and lower
  case: `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` (each the URL of the session's
  port, with credentials, see below), `NO_PROXY=localhost,127.0.0.1,::1` (Hangar's own
  MCP server stays direct). CA variables: `NODE_EXTRA_CA_CERTS`,
  `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`,
  `CODEX_CA_CERTIFICATE`, `GIT_SSL_CAINFO`, each pointing to a bundle of the
  session (see "Trust"), and `GIT_HTTP_PROXY_AUTHMETHOD=basic` so Git sends
  the credentials without a 407 first. On Windows additionally: Git's default
  backend schannel ignores `GIT_SSL_CAINFO`, so `proxy.env` also returns
  `gitConfig: [['http.sslBackend', 'openssl']]`; the agent bay, which alone
  knows the merged environment, appends it after existing
  `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` entries.
  `curl.exe` (schannel) ignores `CURL_CA_BUNDLE` and `SSL_CERT_FILE`, rejects
  CA files above 1 MB and checks revocation, which the CA cannot answer: no
  variable makes it work. `proxy.env` writes a CA-only file next to the bundle,
  and `bays/proxy/CLAUDE.md` names the call that worked in the spike:
  `curl.exe --cacert <ca-only file> --ssl-no-revoke …`. Without it its HTTPS
  requests fail, they do not bypass the proxy. Inherited values of these names are not lost: they
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
  `/etc/ssl/cert.pem` (if present) plus the keychain
  (`tls.getCACertificates('system')`, company CAs too) and Node's bundled
  Mozilla roots (`'bundled'`), each certificate once, because `cert.pem` alone
  can lack a chain's root (CI runners); a root the keychain trust settings deny
  for TLS is dropped from all three: `security trust-settings-export` for the
  user and the admin domain (the system domain is Apple's read-only root list),
  matched by SHA-1. As in trustd, a certificate's admin settings overrule its
  user settings (the user domain counts only without `DisableUserTrustSettings`),
  entries are converted as Security.framework's `copyTrustSettings` does (an
  unknown DER policy OID drops the certificate's settings in that domain, an
  unresolved string OID means no policy), and its first entry that applies to a
  TLS server check decides, `Unspecified` included (no application or host; key
  usage absent, any or that of the role: SignCert as chain signer, none as leaf;
  policy absent, unresolved or SSL, as data or string, the SSL server and client
  OIDs included; policy name absent or exactly `sslServer`). A self-signed root
  is dropped when either role is denied. Unreadable settings leave the roots unfiltered with one warning; Linux `/etc/ssl/certs/ca-certificates.crt` or
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
  keeps pointing to the old generation, so its proxied connections fail TLS
  until the shell is restarted; the UI names these sessions. A client may
  then fall back to a direct connection (Codex did without a trusted CA in
  step 0); that is not watched. Old
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
  hook sees them. The addon therefore wraps `WebsocketLayer.relay_messages`
  (not `_handle_event`, which `start` reassigns per instance): after each
  received event it sums `frame_buf` of both sides; above 16 MB it
  sends both sides close code 1009 (message too big), drops the buffer and
  sends a `ws.tooLarge` row; it closes the server after its close answer or
  end and the client after both, at the latest after 2 s (see `bays/proxy/CLAUDE.md`). That check sees only fragments: wsproto inflates
  `permessage-deflate` frames without a size bound (`wsproto/extensions.py`),
  so a few KB of compressed input can become one complete 32 MB message
  between two checks (reproduced in the Codex review of PR #41). The addon
  therefore removes `Sec-WebSocket-Extensions` from upgrade requests in
  `requestheaders`, so no compression is negotiated. The wrapper touches a private API: the bay
  supports mitmproxy `>=12.3,<13` only, the addon reports
  `mitmproxy.version.VERSION` at start and the engine refuses other versions
  with the reason (`proxy.status` `failed`). Step 0 showed the abort without a
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
- Tools that ignore proxy variables bypass the bay, the UI says "Only traffic
  that uses the proxy is shown". Step 0 found one: MCP servers that Codex
  starts itself get only the variables in their `env_vars` and so connect
  directly. Hangar does not change the Codex configuration in v1;
  `bays/proxy/CLAUDE.md` and the UI hint name the gap and the `env_vars`
  entries that close it. Codex without a trusted CA also opened a direct
  connection from its own process; whether it then reached the API directly
  was not checked. CA renewal and engine outage produce exactly that state,
  so their tests watch for direct connections.
- An agent with released `flow.get` reads bodies of everything its shell
  sent, also of programs it did not start itself in that shell.
- Captured bodies can contain secrets the redaction misses. They stay in
  memory; detail view, copy and export warn.

## Consequences

- A watched session depends on a running `mitmdump`. If it crashes, the bay
  restarts it (backoff 1 s, 5 s, 30 s) with the same ports and reports the
  outage; meanwhile proxied requests of watched sessions fail. A client
  that falls back to a direct connection then goes out unwatched (threat
  model).
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
