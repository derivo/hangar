# ADR 0020 – Dev server in Docker

Status: accepted.

## Context

The bridge (ADR 0019) reaches a server through `ssh -L`. Tests use a fake
`ssh`; a real run so far needed its own server or manual work. Every developer
built their own environment, and results were not comparable.

## Decision

- `docker/dev-server/` contains an image (`node:24-bookworm`, OpenSSH server,
  node-pty for Linux) and `compose.yaml`. `hangar-server` listens inside the
  container on `127.0.0.1:7420`; only SSH is exposed, on `127.0.0.1:2299` of the
  machine (`HANGAR_DEV_SSH_PORT`).
- Server bundle, CLI and agent bay are mounted from the repository (read only),
  in the same folder structure as in the repository, not copied into the image.
  On every start `pnpm dev:server` recreates the container so that the server
  loads the new build.
- User `test`, key login only, local forwarding only. The public key comes
  through the environment (`HANGAR_DEV_KEY`).
- `pnpm dev:server` creates the key, the ssh config, `known_hosts` and an `ssh`
  wrapper in `.dev-server/` (ignored), builds, starts, and prints the address
  `hangar-dev:7420`, the fingerprint and the pairing code. The desktop app uses
  the wrapper through `HANGAR_SSH`. `~/.ssh` stays untouched.
- Data and projects live in volumes and survive restarts; a repository
  `/home/test/projects/demo` is created on the first start (`--root`).
- `pnpm test:ssh` starts the dev server and checks with a real `ssh`: pairing,
  a session of the agent bay with output from the container, the error message
  for a wrong user, no `ssh` left after the app is killed. Not part of
  `pnpm test`, because Docker is not a prerequisite; in CI a separate job on
  Ubuntu.

## Alternatives

- **Remote login from macOS:** macOS only, changes a security setting of the
  machine; rejected.
- **Shared test server:** state shared between people, needs accounts; rejected.
- **Image with built-in bundle:** every build rebuilds the image; rejected.

## Consequences

- For development only: fixed user, no systemd, no hardened image. A production
  image is a separate decision.
- The container's host key is accepted unchecked on every start (`ssh-keyscan`).
  Acceptable because it lives only on the machine's loopback; this does not
  hold for real servers.
- The container does not show network effects (latency, drops).
- The node-pty version in the image follows `bays/agents/package.json`, because
  `pnpm dev:server` passes it; a direct `docker compose up` takes the default
  from `compose.yaml`.
