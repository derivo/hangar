# ADR 0029 – Hangar server in operation

Status: accepted. Extends [ADR 0018](0018-headless-server.md) and
[ADR 0020](0020-dev-server-in-docker.md).

## Context

Since ADR 0018 `hangar-server` runs as a Node process, the dev server from
ADR 0020 only for development (fixed user, SSH in the container, bundles
mounted). For permanent operation, an image, a service example and a guide for
backup, Git access and API keys were missing
([concept-server.md](../concept-server.md), section "Betrieb").

## Decision

- **Image `docker/server/Dockerfile`:** `node:24-bookworm-slim` with Git,
  OpenSSH client and tini; node-pty is built in a separate stage so that
  compilers do not end up in the image. Server, CLI and agent bundle are copied
  in, not mounted. Build with `pnpm image:server`.
- **User `node` (uid 1000), no root.** `/data` (`--data`) and `/projects`
  (`--root`) belong to it; new named volumes inherit that.
- **Loopback only as before:** The server listens inside the container on
  `127.0.0.1:7420`. The example `docker/server/compose.yaml` uses
  `network_mode: host`, so that this is the machine's loopback and the desktop
  reaches it with `ssh -L` as without a container. No published port.
- **`HEALTHCHECK`** through `GET /health`; tini passes `SIGTERM` on to Node, the
  server then closes sessions and bays. On start the agent bay restores
  sessions including scrollback (`manager.restore()`), jobs are in `jobs.json`.
- **systemd without Docker:** `docker/server/hangar-server.service` with its own
  user `hangar`, `StateDirectory` as `--data`, `Restart=always`,
  `EnvironmentFile` for keys.
- **Secrets only through the service's environment** (`server.env`): the
  agents' API keys (a subscription login only works on one's own notebook) and
  the Git identity. Sessions and jobs of the agent bay inherit them;
  `ANTHROPIC_*`, `CLAUDE_*` and `MCP_*` are now left out by the agent bay only
  if Hangar itself runs in a Claude Code session (`CLAUDECODE` set). Before,
  they were always missing, a service API key never reached the agents. Git
  access through deploy keys per repository, mounted to `~/.ssh` of the service
  user, read only.
- **Backup:** the data folder (`--data`) and the projects (`--root`).
- **Verification:** `pnpm test:container` builds the image and checks with
  Docker: does not run as root, `healthy`, agent bay loaded, no response outside
  the loopback, pairing through `docker exec` instead of `ssh`
  (`docker/server/docker-ssh.mjs`), session and job run, after
  `docker restart` the session (scrollback, new shell) and the job result are
  back. Not part of `pnpm test` (Docker needed); in CI as a job on Ubuntu.

## Alternatives

- **Publish a port (`-p 127.0.0.1:7420:7420`):** The server inside the container
  would have to listen on all addresses, against ADR 0018; rejected.
- **SSH server in the production image (as in ADR 0020):** a second access next
  to the machine's SSH, own key management; rejected.
- **Build bundles in the image (`pnpm install` in the Dockerfile):** large
  context, slower build; rejected as long as built bundles from the repository
  suffice.

## Consequences

- `network_mode: host` exists only on Linux; on macOS and Windows the container
  serves only for testing (`pnpm test:container` reaches it through
  `docker exec`).
- Agent tools (Claude Code, Codex …) are not in the image; whoever needs them
  builds their own image `FROM hangar-server`.
- Linux is verified only through the container; the systemd unit only with
  `systemd-analyze verify`, not as a running service.
