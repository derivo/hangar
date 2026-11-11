# ADR 0041 – Hangar sets up its server on a Linux machine over SSH

Status: accepted 2026-11-11. Extends [ADR 0019](0019-desktop-server-bridge.md)
(bridge, SSH tunnel), [ADR 0029](0029-hangar-server-in-operation.md) (server in
operation) and [ADR 0036](0036-shells-survive-restart.md) (runtime copy,
pairing without a code).

## Context

The person wants to work on projects that live on another machine: add the
project by its path in the agent bay, open a session and start Claude in its
terminal, shown in Hangar on the Mac. Claude should keep running when the Mac
sleeps or the connection drops, and the agent bay should work as locally
(worktrees, Git state, status bar, MCP).

All of this exists once a `hangar-server` runs on that machine (ADR 0018/0019):
the desktop reaches it through an SSH tunnel, shows its bays in the sidebar and
adds projects by path (`PathForm`). What is missing is getting the server there
and keeping it running and current. Today that means building a checkout with
node-pty on the machine and installing the systemd unit by hand
(`docker/server/hangar-server.service`), or running the Docker image.

Requirements from the person (2026-11-11):

- target machines run **Linux**;
- the agent client signs in with the person's **subscription** on that machine
  (it is their own machine), not only with an API key;
- the Linux runtime **ships inside the app**, no download.

## Decision

1. **Linux runtime as a package of the app.** CI builds
   `hangar-server-linux-x64.tar.gz` and `hangar-server-linux-arm64.tar.gz`: the
   official Node binary (the version of the Docker image), `hangar-server.mjs`,
   the CLI, the bundled bays and node-pty compiled for the architecture. The
   machine needs neither Node nor a compiler. Both packages go into the app's
   resources, so the server always matches the app's version and setup works
   offline. The build id is computed as for the local runtime (ADR 0036,
   point 1) over the package's content.
2. **Supported baseline: glibc of the build image.** node-pty is compiled in the
   Debian image of `docker/server/Dockerfile` (bookworm). The build reads the
   newest `GLIBC_`, `GLIBCXX_` and `CXXABI_` symbol versions that the Node binary
   or `pty.node` needs (`objdump -T`) and writes them to `requirements.json` in
   the package: measured glibc 2.34, libstdc++ `GLIBCXX_3.4.22`, `CXXABI_1.3.11`
   for x64 and arm64 (2026-11-11), so Debian 12, Ubuntu 22.04, RHEL 9 or newer.
   The limit is node-pty: on glibc 2.31 Node starts, `pty.node` does not load.
   Setup checks the machine's glibc (`getconf GNU_LIBC_VERSION`) before
   uploading and refuses older ones with a message naming both versions, musl
   systems (Alpine) too. After unpacking it starts a shell through node-pty with
   the package's Node; only then is the unit written, so a missing or too old
   libstdc++ shows its own error instead of a server that never starts.
3. **Explicit paths, no repository layout.** The package has a fixed layout
   (`node`, `server/hangar-server.mjs`, `bin/` for the CLI, `bays/`). The unit
   passes `--bays` and `--cli` explicitly, as the local server does (ADR 0036,
   point 1); the defaults of `apps/server/src/options.ts` assume the
   repository and are not used.
4. **Setup over SSH from "Add server".** Besides "connect to a running server"
   the dialog offers "set up on this machine" for an address `[user@]host`. The
   app uses the same `ssh` options as the tunnel (`BatchMode=yes`, so key or
   agent authentication as configured in `~/.ssh/config`; no password prompt):
   1. `uname -sm` and the glibc check decide the package; anything other than
      Linux x86_64 or aarch64 with a sufficient glibc is refused with a message
      naming what was found.
   2. `systemctl --user` must be available; otherwise the app stops with a
      message (no fallback to `nohup`: nothing would restart the server).
   3. The package streams over the SSH connection and is unpacked into
      `~/.local/share/hangar/runtime/<version>+<build id>`, written to a
      temporary folder first and renamed when complete. `~/.local/share/hangar`
      and everything below it are 0700.
   4. A systemd user unit `hangar-server.service` in `~/.config/systemd/user/`
      starts the server with absolute paths (systemd expands no `~`; the unit
      uses `%h`): `--data %h/.local/share/hangar/data --listen 127.0.0.1:<port>
--root %h --bays … --cli …`, `Restart=always`, `UMask=0077` (sessions,
      scrollback and environment are written with default modes, as in the
      example unit of ADR 0029), output appended to `<data>/server.log`
      (`StandardOutput=append:`), then `systemctl --user enable --now`.
5. **The server runs as the person's own user**, not as a separate `hangar`
   user like the example unit of ADR 0029. Projects are under the home folder
   (`--root %h`, as for the local server), and the agent client finds the login
   the person made there. A systemd user service does not read the login
   shell's profile, and sessions on Linux start interactive shells without
   login (`bays/agents/src/main/pty.ts`); the unit therefore takes `PATH` from
   the person's login shell at setup (written to an `EnvironmentFile` next to
   the unit), and setup checks that `git` is found with it. Agent clients are
   not checked: which one runs is the person's choice in the terminal.
6. **Subscription login on one's own machine.** The decision of 2026-10-29
   (subscription only on one's own notebook, servers with an API key) is
   narrowed: a server set up this way runs on a machine of the person under
   their user, so they sign in once with the client's own login flow in a
   session, and all sessions use it. Servers operated for others or shared
   stay with API keys in `server.env` (ADR 0029). Hangar itself neither stores
   nor forwards any login.
7. **Lingering is checked, not set.** Without lingering systemd stops user
   services at logout. Whether a user may enable it for themselves depends on
   the machine's polkit policy, so the app does not try: it checks `loginctl
show-user --property=Linger` and, if off, shows `loginctl enable-linger` to
   copy (with `sudo` if the policy requires it). The server works without it as
   long as the person stays logged in.
8. **Pairing without a code, as for the local server.** The server already
   writes `listen.json` and `pair-code` into its data folder (ADR 0036, points
   3 and 4). The app reads both over SSH, checks the fingerprint against
   `listen.json`, pairs and stores the token as today in `servers.json`. After
   that the connection runs through the existing tunnel (ADR 0019, part 10c).
9. **Updates through SSH, not through the bridge.** The bridge knows only the
   protocol version, `/health` only the package version; neither tells the
   build. The app reads over SSH which runtime folder the unit starts
   (`<version>+<build id>`) and compares it with its own package. That also
   works when the protocols no longer match and the bridge cannot connect. On a
   difference the server group shows the hint "new version" with "Restart
   server" (same view as for the local server, including the live log, read
   over SSH from `server.log`). Restart uploads the new runtime, points the
   unit at it and restarts the service; sessions are restored as after any
   restart (`manager.restore()`). Runtimes the unit no longer starts are
   deleted after the restart succeeded.
10. **Removing** a server set up this way offers to also stop and disable the
    unit and delete the runtimes; the data folder (sessions, worktrees,
    settings) stays unless the person ticks it explicitly.

## Alternatives

- **SSH with tmux, no server on the machine.** Small change: the session's
  shell becomes `ssh host` into a `tmux` session, Claude survives a dropped
  connection. Rejected by the person: worktrees, Git state, status bar and MCP
  would be missing on the machine.
- **Download the package from GitHub Releases.** The app stays smaller, but the
  repository is private (a download needs authentication) and app and server
  versions can drift. Rejected for shipping it inside the app.
- **Docker on the machine.** The image exists (ADR 0029), but it needs Docker
  and root or the docker group there, and the agent client inside the container
  would not see the person's login and tools. Stays for operated servers.
- **Compile node-pty on the machine.** Needs Node, Python and a compiler there
  and fails differently per distribution. Rejected.
- **Install as a system service with its own user.** Safer separation, but
  needs root for setup and every update and does not see the person's login.
  Stays the documented way for operated servers (ADR 0029).

## Consequences

- The app grows by both Linux packages: 45.8 MB (arm64) and 46.1 MB (x64)
  compressed (2026-11-11). The local server's runtime copy (ADR 0036) copies the
  whole app and grows by the same; removing them from the copy would break the
  bundle's signature.
- macOS machines as targets are not covered (a later step could reuse the local
  runtime copy and a LaunchAgent).
- An agent on the machine can do everything the person's user can there; the
  sandbox is the machine, as stated in `concept-server.md`.
- Setup needs SSH with key or agent authentication; password-only hosts are
  refused like for the tunnel today.
- CI gets a Linux packaging job; the end-to-end test needs Docker (a container
  with `sshd` and systemd user services as the "Linux machine"), like
  `pnpm test:container` outside `pnpm test`.

## Implementation in steps

1. **Linux package:** CI builds both packages; a container test unpacks one
   into a plain image of the baseline without Node, starts the server with the
   explicit paths, checks `/health`, a session and a restored session after a
   restart. Measures the package size and the minimum glibc.
2. **Setup over SSH:** checks (system, architecture, glibc, `systemctl --user`,
   `git` on the `PATH`, lingering), upload, unit with modes, pairing; E2E against the SSH container including
   every refusal with its exact message.
   Done: the checks against the SSH container are `pnpm test:linux-setup`
   (Vitest, not Playwright); the desktop E2E covers the dialog with the
   probe refused on macOS. The server picks a free port (no `--listen`);
   the app stores the data folder and reads the port from `listen.json`
   over SSH before every connect.
3. **Update and restart:** build comparison over SSH, hint, restart view with
   the log, cleanup of
   old runtimes, removal with the unit.
   Done, with one change to point 9: there is no live log view during the
   restart. A server that is not connected has no bays in the sidebar, so no
   page could show it; a failed restart shows the last 20 lines of
   `server.log` (read over SSH) in its message instead. The hint stands in the
   server's name in the sidebar (also while the bridge rejects the app) and
   above a selected bay of the server; "Restart server …" is in the server's
   menu at any time. The comparison runs at app start and after every setup
   or restart.
4. **Docs:** `docs/server-operations.md` (setup from the app next to Docker and
   the system unit), STATUS and CHANGELOG. Done.
