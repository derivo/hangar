# ADR 0019 – Bridge between desktop and server

Status: accepted, implemented in phases 10 and 11.

## Context

The server from ADR 0018 has no interface. The desktop app should show its bays
as if they ran locally (phase 10, [concept-server.md](../concept-server.md)). The
server listens only on loopback; the desktop reaches it through an SSH tunnel.

## Decision

- **Transport:** JSON over WebSocket at `/connect` on the same port as `/health`.
  Server with the `ws` package, desktop with Node's built-in WebSocket client.
  Protocol and client live in `packages/bridge` (without Electron).
- **Version:** `hello` carries `version`; the server accepts the current and the
  previous one, otherwise `error` with
  `Protocol version <v> not supported (server speaks <aktuell>)`.
- **Server key:** Ed25519 in `<data>/identity.json` (mode 0600), generated on the
  first start. Fingerprint `SHA256:<base64>` as with OpenSSH; the server writes
  it to the log on start.
- **Proof before secret:** In `hello` the client sends a random nonce, the server
  signs `hangar-bridge-v1:` + nonce (`welcome`). Only when the signature and – if
  known – the fingerprint match does the client send its token or the pairing
  code. A server with a different key thus gets neither. This does not protect
  against someone who reads along or relays the connection to the real server:
  The SSH tunnel (or a private network) does that; the bridge itself does not
  encrypt.
- **Pairing with a code:** On start the server writes a one-time code
  (`XXXX-XXXX`, without 0/O/1/I) to the log. The desktop shows the fingerprint,
  the person confirms it and enters the code (`pair`). The server issues a token,
  stores only its SHA-256 in `<data>/clients.json` (0600) and writes a new code to
  the log. Whoever reaches only the port gets no further without the code.
- **Afterwards:** `auth` with token; a wrong token closes the connection
  (`Invalid token`). `invoke` (a bay's UI channel) works only after `pair` or
  `auth`, otherwise `Not paired`. A bay's `ctx.ui.send` goes as `event` to all
  paired desktops.
- **Forwarding in the main process (part 10b):** The bay's preload stays
  unchanged; the main process forwards `bay:invoke` of a remote bay over the
  connection. The token stays out of the bay view.
- **Desktop (part 10b):** `ServerConnections` from `@hangar/bridge` keeps the
  paired servers in `<userData>/servers.json` (0600, with token) and connects on
  start. A server bay is called `remote:<server-id>:<bay-id>`, has the partition
  `persist:bay:<schlüssel>` (separate from the same bay locally) and its
  interface from the local bundle with the same id and version; otherwise it
  appears as an error in the group.
- **SSH tunnel (part 10c):** An address `[benutzer@]host:port` starts
  `ssh -T -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15
-o RemoteCommand=none -o ControlMaster=no -o ControlPath=none
-L 127.0.0.1:<frei>:127.0.0.1:<port> -- [benutzer@]host cat`; the connection then
  goes to the free local port. The tunnel lives as long as the connection. `cat`
  on the server reads the standard input of ssh, a pipe of the desktop app: If
  the app dies, even hard, `cat` ends and with it ssh. With `-N`, ssh remained
  after a crash. `RemoteCommand`, `ControlMaster` and `ControlPath` from the
  person's ssh config are overridden: a custom command does not get along with
  `cat`, a shared master connection would own the forwarding and outlive the app.
  `servers.json` stores `ssh: { user, host, port }` instead of `url`. Host and
  user must not begin with `-` (otherwise ssh reads them as an option). Only
  `127.0.0.1`, `::1` and `localhost` connect without a tunnel.
- **Reconnecting:** If a connection breaks or an attempt fails that repeating can
  help, the desktop reconnects after 1, 2, 4 … at most 30 s; after a connection
  the sequence begins anew. Not on `Invalid token`, wrong signature, different
  fingerprint or foreign protocol version (re-pairing needed), not after
  disconnecting, removing or quitting. Other errors, also a missing `ssh` or a
  rejected host key, are retried: They can be fixed while the app runs, and the
  pause stays at 30 s.
- **Permission dialog over the bridge (part 11b):** The server's prompter asks
  the paired desktop that connected last: `ask { id, request }` from the server,
  `answer { id, decision }` back. The desktop shows its permission dialog with
  "On the server "<name>":" before the text; the answer applies in the server's
  bus and is stored there. Only the desktop that was asked can answer, and only
  with a choice that the dialog offers for this question. Without a paired
  desktop, without an answer within 5 minutes or if it disconnects meanwhile, the
  prompter throws: The call fails without the bus storing anything (a `deny`
  would be stored permanently). Rules in `permissions.json` still apply first. An
  older desktop does not know `ask`; the server gives up after the time limit.
  The desktop shows one question at a time per connection, accepts at most 10
  open ones (further ones stay without an answer), only in the form that the bus
  asks, and only with a rising id (the server counts up; so the lock against
  repetition needs no storage), and closes the dialog when the connection ends or
  the server sends `withdraw { id }` after its time limit; questions that arrive
  before the answer is set up wait. The server also holds at most 10 open
  questions; further ones fail immediately without anything being stored.
- **Notifications and badges (part 11c):** A bay's `ctx.notify` and
  `ctx.setBadge` on the server go as `notify { bay, notification }` and
  `badge { bay, count }` to every paired desktop with an open connection. If none
  is connected, the server keeps the last 50 notifications in memory and gives
  them to the next desktop after `auth` or `pair`, once; every desktop then also
  gets all current badges. A restart of the server loses the collected ones. The
  desktop shows them like its own (a click opens the server bay), the badge on
  the server bay in the sidebar and in the total on the app icon. It accepts only
  bays of the server, at most 60 notifications per minute and connection, titles
  up to 200 and text up to 1000 characters, badges up to 9999.
- **Jobs of the server (part 11d, protocol version 2):** The desktop asks for the
  scheduler's jobs with `jobs` and sends `job { action, job }` with `pause`,
  `resume`, `run` or `remove`; only when paired. If jobs or their results change,
  the server sends `jobs` without content, and the desktop reloads the list. The
  settings show under "Jobs" one group per machine: "On this computer" and for
  each connected server "On the server "<name>"". A server with version 1 would
  close the connection on `jobs` ("Unknown message"); hence version 2: Such a
  server rejects the new desktop already at `hello` with a clear message, a new
  server continues to accept desktops with version 1.
- **Language:** `auth` and `pair` optionally carry `locale` (the desktop's
  language); a server without the field does not check it, so no new version. The
  server adopts the language of the desktop that connected last (as with `ask`),
  writes it to `<data>/desktop-locale` and takes it at the next start, so that
  notifications without a connected desktop are also created in it. Unknown
  values do not count; `HANGAR_LOCALE` fixes it. Bays learn of the change via
  `ctx.onLocaleChange`. The desktop applies its language only at the next start
  and then reconnects – that is enough as a switch. The desktop shows a server's
  notifications with "<server name>: " before the title.

## Alternatives

- **SSH access is enough for pairing:** every process on the server could fetch a
  token; rejected.
- **Build WebSocket ourselves:** more code, error-prone; rejected.
- **Preload speaks WebSocket:** the token would sit in the renderer; rejected.
- **Send the token before the key proof:** a substituted server would receive it;
  rejected.

## Consequences

- SSH without prompts: key (or agent) and host key must work beforehand in the
  terminal; an unknown host key is rejected, not accepted.
- The tunnel needs a shell with `cat` on the server; a key that allows only
  forwarding (`restrict,port-forwarding` without a command) is not enough.
- `StdinNull yes` in the ssh config would make `cat` end immediately. The desktop
  reads `ssh -V` before each tunnel and passes `-o StdinNull=no` from OpenSSH 8.7
  on; older versions (Windows 10 has 8.1) reject the option, but then cannot have it
  in their config either. An ssh whose version it cannot read gets no override.
- If another process keeps a connection over the local port open, ssh lives on
  after a crash of the app as long as that connection.
- The forwarded port lies on the desktop's loopback; other users of this machine
  reach it, but need a token or pairing code.
- The pairing code is in the server's log; whoever can read the log can pair.
  That is the service user, so the owner anyway.
- Attempts with a wrong code are not limited; with 32⁸ possible codes and a new
  code per start, guessing over the loopback port is not practical.
- Removing paired desktops works on the server so far only via `clients.json`;
  "Remove server" in the desktop deletes only its entry in `servers.json`.
