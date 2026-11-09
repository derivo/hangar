# @hangar/bridge

Protocol between desktop and Hangar server (ADR 0019) and the client for it.
No Electron: the client runs in the main process of the desktop app and in tests
under Node (built-in `WebSocket`).

## Interfaces

- `PROTOCOL_VERSION`, `SUPPORTED_VERSIONS`, types `ClientMessage`,
  `ServerMessage`, `BayInfo` (`protocol.ts`).
- `fingerprint(publicKey)` – `SHA256:<base64>` of the key (DER, SPKI).
- `connect({ url, fingerprint?, token?, timeoutMs?, locale? })` → `Connection` (`client.ts`): checks
  the signature of the nonce and the fingerprint, then `auth` with token. If the
  server closes earlier, stays silent (10 s) or sends no JSON, `connect` fails.
  `Connection`: `fingerprint`, `paired`, `bays`, `pair(code, name, locale?)` → token,
  `invoke(bay, channel, args)`, `onEvent`, `onAsk` (permission questions of the server,
  Phase 11b), `onNotify`, `badges` + `onBadge` (Phase 11c), `jobs()`,
  `job(action, id)`, `onJobs` (Phase 11d), `version` (from `welcome`), `offer(functions)`,
  `workspaces(action, args)` + `onWorkspaces` (protocol 4, ADR 0036 item 11),
  `onCall` (the handler gets an `AbortSignal`, aborted when the connection closes), `onSessionEnded`, `sessions` + `onSessions` (ADR 0036), `onClose`, `close()`.
- `parseAddress(address)` (`tunnel.ts`) – loopback (`127.0.0.1:port`,
  `ws://…/connect`) → `{ url }`, `[user@]host:port` → `{ ssh }`, otherwise
  `Invalid address: …`. `sshArgs(target, localPort)`, `openTunnel(target, ssh)`
  → `{ port, close }` (waits until the local port accepts; error
  `SSH failed: <last line of ssh>`).
- `ServerConnections(file, { name, locale? }, { changed, event, ask, notify, jobs }, ssh = 'ssh', retryMs = 1000)` – paired servers
  in `file` (0600): `list()` (with `badges` per bay, `sessions` of the server, `local: true` for the local server), `connectAll()`, `connect`, `disconnect`, `remove`,
  `probe(address)` → `{ id, fingerprint }`, `pair(probeId, name, code)`,
  `pairLocal(dataDir, name)` (server on the same machine, ADR 0036: code from `pair-code`, only with the fingerprint from `listen.json`; stored with `local`, the port comes from `listen.json` on every connect; already paired → the same ID and a new connection attempt if none is running),
  `cancel`, `invoke`, `jobs(id)`, `job(id, action, jobId)`, `workspaces(id, action, args)`, `offerAgain()`, `closeAll()`;
  `changed` after every status change and every badge change. After
  a drop or failed attempt reconnect after 1, 2, 4 … at most 30
  × `retryMs`; not on a rejected key or token (`FINAL`), except
  a local server with a foreign key (another process listens on the old port
  until `listen.json` names the new one). Listener `local`
  (`functions`, `call`, `sessionEnded`, `workspaces`): bays of the app for the local server;
  offered after every connect and with `offerAgain()`, only to servers with
  `local` and protocol ≥ 3.

## Pitfalls

- Token and code go out only after a verified signature; do not change this
  order.
- `locale` goes out with `auth` and `pair`; an optional field on existing
  messages needs no new protocol version (the server checks only required fields).
- Open requests are rejected with `Connection closed` on close.
- `PROTOCOL_VERSION` 2 since `jobs`/`job` (11d): a server with version 1 would close
  the connection on unknown messages. New messages from the desktop to the
  server need a new version; from the server to the desktop they do not (the client
  ignores unknown ones).
- `PROTOCOL_VERSION` 3 since `offer`/`reply` (ADR 0036). A server with version 2
  rejects the new app at `hello`; the local server keeps running in its version
  until its restart (step 4).
- `PROTOCOL_VERSION` 4 since `workspaces` (ADR 0036, item 11): as with 3, a server
  with version 3 rejects the new app at `hello` until it restarts.
- `call` of the server: the client checks only the shape (`id`, `target`, `caller` with
  `bayId`, optional `sessionId`); what may be called is checked by the host
  (only own bays, caller rebuilt field by field, never `kind` from the message).
- `notify`/`badge` before the end of `pair`/`auth` are held back by the client: Node
  delivers several messages of one packet in one task, `bays` is then still
  empty. Limits against a flooding server: 60 notifications per minute,
  title 200 and text 1000 characters, badge at most 9999, only bays of the server.
- Tested against the real server in `apps/server/src/bridge.test.ts` and
  `apps/server/src/connections.test.ts` (`startEchoServer` from `test-setup.ts`).
- Host and user without a leading `-` and `--` before the target: otherwise ssh reads
  them as an option (`-oProxyCommand=…`). Do not loosen.
- Tests use `fixtures/fake-ssh.mjs` instead of `ssh`: really forwards `-L`,
  ends with stdin like `cat` on the server, host `unreachable.invalid` fails
  like ssh. `fixtures/open-tunnel.mjs` opens a tunnel in its own process,
  so that tests can kill it hard.
- No `-N`: ssh ends with `cat` on the stdin pipe only if the app dies.
  stdin must remain a pipe (`stdio[0] = 'pipe'`). Do not remove `RemoteCommand=none`,
  `ControlMaster=no`, `ControlPath=none` (the person's ssh config);
  no `StdinNull=no` (OpenSSH < 8.7 rejects it).
- `ServerConnections` numbers connection attempts: disconnect, remove or
  `closeAll` while connecting wins, the late attempt closes.
- `onClose` of an old connection sets the status only if it is still the
  current one; otherwise a late close overwrites a new "connected".
