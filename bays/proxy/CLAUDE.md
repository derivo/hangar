# bays/proxy – Proxy (`dev.hangar.proxy`)

Purpose: runs mitmproxy (`mitmdump`) as a local intercepting proxy for watched
agent sessions and shows their traffic per project and session (ADR 0049,
steps in `docs/roadmap.md`, "Proxy bay"). Built so far: step 2, the engine.
Sessions do not go through it yet (step 3), flows are not stored (step 4), the
UI shows only the engine state (step 5).

## Layout

- `manifest.json` – id, `proxy.status`, settings `mitmdumpPath`, `upstreamCaFile`.
- `src/addon/hangar_proxy.py` – the mitmdump addon; `pnpm build` copies it to
  `dist/addon/`. `pnpm lint` compiles it (`scripts/check-python.mjs`).
- `src/main/engine.ts` – finds and starts `mitmdump`, version check, restart
  with backoff 1 s, 5 s, 30 s and the same listeners, stop. Interface `Engine`;
  tests use a fake process (`engine.test.ts`) or a real mitmdump
  (`engine.integration.test.ts`).
- `src/main/protocol.ts` – JSON lines to and from the addon, request ids, 5 s
  per command, bounded queue (1 000 lines, 8 MB), counted warnings.
- `src/main/ca.ts` – CA folder (0700, key files 0600), `upstream.pem` (system
  roots plus `upstreamCaFile`; macOS roots: `cert.pem`, keychain and Node's
  bundled roots, each once, minus roots the keychain denies), session bundles
  `bundles/<generation>/<session>-<hash>.pem`, `renew()`.
- `src/ui/` – status line of the engine.

## Functions

| Function       | Who       | Effect                                                          |
| -------------- | --------- | --------------------------------------------------------------- |
| `proxy.status` | bays only | `{ state, version, reason, listeners, warnings }` of the engine |

## Addon protocol

Commands (stdin, `{ id, op, … }`): `listen { port, password }`,
`unlisten { port }`, `capture { on }`, `ignore { hosts }` (regular expressions
of `host:port`). Each gets `{ type: 'reply', id, ok, error? }`; `listen`
answers after the listener is bound or failed.

Events (stdout): `hello { version }` at start, `flow.request`, `flow.response`
(headers redacted, body base64 up to 1 MB or `null` when streamed),
`stream.chunk`, `flow.done { bytesUp, bytesDown, closeCode? }`, `flow.error`,
`ws.message`, `ws.tooLarge`, `tunnel` (pass-through hosts, bytes only),
`tls.failed`, `dropped { count }`, `warning`. Types: `src/main/protocol.ts`.

## Pitfalls

- mitmproxy `>=12.3,<13` only: the WebSocket limit wraps the private
  `WebsocketLayer.relay_messages`. Another version fails with the reason.
- `mitmdump` starts with `server=false`: an empty `mode` is refused, and the
  default `regular` would bind port 8080. The first `listen` turns the server on.
- mitmdump's Python cannot read inside `app.asar`, and `asarUnpack` does not
  reach files mapped in from `bays/`: `installAddon()` copies the addon into
  the data folder (`addon/hangar_proxy.py`) at activation.
- stdout carries only the addon's JSON lines: the addon points mitmproxy's
  log and dumper to stderr and writes through a bounded queue, so a slow bay
  never blocks the proxy (extra lines are dropped and counted).
- When stdin ends (the bay is gone) the addon shuts mitmdump down.
- `unlisten` closes open connections of that listener through
  `proxyserver.connections`; removing the mode alone keeps them.
- Proxy credentials are checked per listener by the addon (plain HTTP per
  request, HTTPS at CONNECT), not by mitmproxy's `proxyauth`.
- macOS: Node's bundled roots ignore the keychain, so `distrustedRoots()` reads
  the user and admin trust settings (`security trust-settings-export`, parsed as
  a plist) and `systemRoots()` drops denied roots by SHA-1. As in trustd: admin
  settings of a certificate overrule its user settings; `DisableUserTrustSettings`
  in `/Library/Preferences/com.apple.security.plist` turns the user domain off;
  entries are converted as `copyTrustSettings` does (an unknown DER policy OID
  drops all settings of the certificate in that domain, an unresolved string OID
  means no policy, options are not copied, an entry with none of policy,
  application, host, allowed error, result and key usage is dropped); the first entry that applies to a TLS server check decides,
  `Unspecified` included (no application or host, key usage absent, any or the
  usage of the role, policy absent, unresolved or SSL, name absent or exactly
  `sslServer`). A self-signed root is checked as chain signer (SignCert, 8) and
  as leaf (0) and dropped if either is denied.
  Unreadable settings warn once and filter nothing.
- The engine starts with the first `listen`, not with Hangar.
- With a local server the bay runs there (`IN_SERVER`), like the agent bay.
- Windows: `curl.exe` (schannel) ignores the CA variables; only
  `curl.exe --cacert <ca-only file> --ssl-no-revoke …` works (ADR 0049, step 3).
- Codex hands MCP servers it starts only the variables in their `env_vars`, so
  those connect directly unless `env_vars` names `HTTPS_PROXY`, `https_proxy`,
  `HTTP_PROXY`, `http_proxy`, `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`.
