# ADR 0049 – Traffic bay: watch what agent sessions send and receive

Status: proposed 2026-11-23. Builds on [ADR 0004](0004-bay-runtime.md) (bay
runtime), [ADR 0021](0021-password-bay.md) (a bay hands values to the agent bay
at shell start), [ADR 0032](0032-manifest-permissions.md) (`uses`) and
[ADR 0036](0036-shells-survive-restart.md) (agent bay in the local server).
UI mockup: [mockups/traffic-bay.html](../mockups/traffic-bay.html). Plan:
[roadmap.md – Traffic bay](../roadmap.md#traffic-bay).

## Context

The person wants to see everything an agent session sends and receives over the
network: model API calls, telemetry, MCP servers, package registries. Today a
session shell inherits the environment and talks to the internet directly;
Hangar sees only the calls that reach its own bus.

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

- **New bay `dev.hangar.traffic`** ("Traffic" / "Datenverkehr"). Its main part
  runs a local intercepting proxy, its UI lists the flows per session. It has
  no `hostModules`, so it loads in the desktop app and in a server alike; with
  the local server (ADR 0036) it runs in the server next to the shells.
- **Engine: mitmproxy, not an own TLS interceptor.** The bay starts `mitmdump`
  as a child process with an addon shipped in the bay
  (`bays/traffic/addon/hangar_traffic.py`). The addon writes one JSON line per
  event to stdout (`flow.request`, `flow.response`, `flow.error`,
  `stream.chunk`, `ws.message`, `tls.failed`); the main part parses and stores
  them. mitmproxy is not bundled: the bay looks for `mitmdump` on `PATH` or in
  the setting `mitmdumpPath`. Without it the bay shows how to install it
  (`uv tool install mitmproxy`, `brew install mitmproxy`) and the agent bay
  starts shells without a proxy.
- **Opt-in per session.** A session is watched only if "Watch traffic" is on
  for it (default for new sessions from the project, default off). It takes
  effect at the next shell start, like environment variables.
- **Hand-over at shell start like passwords (ADR 0021).** The agent bay calls
  `dev.hangar.traffic/proxy.env` (`bayOnly`, in `uses`) with the session id
  before `spawnShell` and mixes the answer into the environment:
  `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` (each `http://127.0.0.1:<port>`),
  `NO_PROXY=localhost,127.0.0.1,::1` (Hangar's own MCP server stays direct),
  `NODE_EXTRA_CA_CERTS=<ca.pem>`, and a combined bundle (system roots plus the
  CA) in `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE` and
  `CODEX_CA_CERTIFICATE`. If the call fails, the shell does not start and the
  terminal names the reason (same path as a failing `secret.resolve`); a
  watched session never silently runs unwatched.
- **One port per watched session.** The bay gives each watched session its own
  listen port on `127.0.0.1` and maps flows to the session by that port
  (`client_conn.proxy_mode` in the addon). A single `mitmdump` serves all
  ports; ports are added and removed at run time. Each port also requires
  proxy credentials (`http://hangar:<random>@127.0.0.1:<port>`) if step 0
  shows that both agents send them; otherwise ports stay without credentials
  and the threat model below names that. `onAgentSessionEnded` frees the port.
- **CA per installation, never in a system trust store.** The bay creates the
  CA in `<dataDir>/ca/` (folder 0700, key 0600) on first use. Only session
  environments trust it; Hangar never adds it to the keychain or
  `/etc/ssl`. "Renew CA" in the UI replaces it; watched shells need a restart.
- **Upstream TLS stays verified.** The bay never sets `ssl_insecure`. A client
  that rejects the CA (certificate pinning) appears as a `tls.failed` row with
  "Pass through this host"; passed hosts are tunneled without content
  (`ignore_hosts`) and marked as such.
- **Streaming stays live.** Responses with `text/event-stream` and bodies above
  1 MB are streamed through (`flow.response.stream` as a function that also
  forwards the chunks to the bay), so an agent does not wait for a buffered
  answer. WebSocket messages come through `websocket_message`.
- **Storage: memory only, redacted.** Flows are kept in a ring buffer in
  memory (default 5 000 flows or 200 MB, setting `maxFlows`/`maxMegabytes`),
  never written to disk except by an explicit export. The values of
  `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `x-api-key`
  and headers matching `/token|secret|key/i` are replaced by `•••• (n chars)`
  in the addon, before they reach Hangar. Bodies are kept up to 1 MB per
  direction (`truncated` marks the rest).
- **Classification by host**, editable in the settings: "Model API"
  (`api.anthropic.com/v1/messages`, `chatgpt.com/backend-api/codex/responses`,
  `api.openai.com`), "Telemetry" (`event_logging`, `metrics`,
  `analytics-events`, `datadoghq.com`, `sentry.io`), "MCP" (paths ending in
  `/mcp` or `/mcp/`, `mcp-proxy.anthropic.com`), "Packages"
  (`registry.npmjs.org`, `pypi.org`), otherwise "Other".
- **No functions for agents in this step.** The bay offers only `bayOnly`
  functions (`proxy.env`, `proxy.status`); the flows are for the person. A
  later `traffic.list` for an agent's own session needs its own decision.
- **Export as HAR** (UI only), redacted as stored, to a file the person picks.

## Threat model (short)

- Whoever holds the CA key can read the traffic of every process that trusts
  the CA. Only watched session shells trust it; the key lies in the bay's data
  folder, readable by the user account – agents run as that account without a
  sandbox (bay ideas 2) and could read it anyway.
- Any local process can connect to a session's port; without proxy
  credentials it would show up as that session's traffic and get the same
  interception. Listening only on `127.0.0.1` limits this to the own machine.
- Captured bodies can contain secrets the header redaction misses (tokens in
  JSON bodies, prompts with passwords). They stay in memory; the export warns.

## Consequences

- A watched session depends on a running `mitmdump`. If it crashes, the bay
  restarts it (backoff 1 s, 5 s, 30 s) and reports the outage in the UI;
  meanwhile requests of watched sessions fail instead of going out unwatched.
- Python dependency for those who use the bay. A native engine in Node can
  replace mitmproxy later behind the same JSON-lines interface.
- Tools that ignore proxy variables bypass the bay. The UI says so ("Only
  traffic that uses the proxy is shown"); step 0 measures the agents.
- On a remote Linux server (ADR 0041) `mitmdump` must be installed there.

## Rejected

- **Own interceptor in Node** (for example `http-mitm-proxy` with
  `node-forge`): TLS interception, HTTP/2 and WebSockets are security-relevant
  and mature in mitmproxy; own code first only if the Python dependency proves
  to be a problem.
- **Proxy in front of the whole app or the system** (system proxy, PAC): would
  capture the person's own traffic and needs the CA in the system trust store.
- **Packet capture** (`pcap`, Network Extension): sees only encrypted TLS and
  needs elevated rights.
- **Reading agent logs** instead of a proxy: incomplete, different per agent,
  no telemetry.
