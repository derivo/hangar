# Operating the Hangar server

Hangar without a UI, permanently on a Linux machine: set up from the app under
your own user, as a container or as a systemd service
([ADR 0029](adr/0029-hangar-server-in-operation.md),
[ADR 0041](adr/0041-remote-linux-server.md)). What the
server can do is described in [ADR 0018](adr/0018-headless-server.md),
the connection to the desktop in [ADR 0019](adr/0019-desktop-server-bridge.md).

The server is a workbench, not a vault: agents have a shell there and can do
anything the service user can. Own machine or own VM, own user.

## From the app, under your own user

The quickest way for your own machine: the app copies its server there and runs
it as a systemd user service of your user, so agents see your login, your
tools and your Claude subscription login (ADR 0041).

Preconditions on the machine: Linux on x86_64 or aarch64 with glibc 2.34 or
newer (Debian 12, Ubuntu 22.04, RHEL 9 and later; not Alpine), systemd user
services (`systemctl --user` works in an SSH login), `git`. No Node needed: the
package brings its own. On this Mac, `ssh user@host` must work without a
password prompt (key or agent).

In the app: plus in the sidebar → "Connect to server" → tick "Set up Hangar
there (Linux)", name, address `user@host` (or a host from `~/.ssh/config`)
without a port → "Set up". The app checks the machine, uploads the package
(about 46 MB, only for a new build), checks that the server can start
terminals there, installs the unit and pairs. A refusal names what is missing.

On the machine afterwards:

| Path                                               | Content                          |
| -------------------------------------------------- | -------------------------------- |
| `~/.local/share/hangar/runtime/<version>+<build>/` | Node, server, CLI, bays          |
| `~/.local/share/hangar/data/`                      | sessions, settings, `server.log` |
| `~/.local/share/hangar/server.env`                 | `PATH` of your login shell       |
| `~/.config/systemd/user/hangar-server.service`     | the unit                         |

All of it is private to your user (folders 0700, files 0600). Projects are any
Git folders under your home (`--root %h`); add them in the agent bay by path.

**Lingering.** Without it, systemd stops your user services when your last
login there ends. The dialog says so after the setup; on the machine run
`loginctl enable-linger <user>` (with `sudo`, depending on the system).

**New version.** When this app ships another build than the unit starts, the
server's name in the sidebar says "new version ready" and a hint above its bays
offers "Restart server". The app reads the build over SSH, so this works even
when the server rejects a newer app. "Restart server …" in the server's menu
(right click) does the same at any time: it uploads this app's build if
needed, restarts the unit and connects again. Sessions come back as after any
restart; programs running in their shells end. Older runtimes are deleted once
the new one runs. If the server does not start, the message shows the last
lines of `server.log`.

**Removing.** "Remove server …" in the server's menu asks whether to only
remove the pairing or also stop and uninstall the server there (unit and
runtimes). The data folder stays unless you tick "Also delete the data on the
machine".

Log: `~/.local/share/hangar/data/server.log` on the machine;
`systemctl --user status hangar-server` shows the service.

## As a container

Build the image in the repository (it builds server, CLI and agent bay first):

```bash
pnpm image:server
```

Bring it to the server, for example `docker save hangar-server | ssh server docker load`.
There, next to [docker/server/compose.yaml](../docker/server/compose.yaml):

1. Create `server.env` from
   [server.env.example](../docker/server/server.env.example) and fill it in
   (API key, Git identity), permissions `600`.
2. Folder `ssh/` with the deploy keys and a `config` (see below), owner
   uid 1000.
3. `docker compose up -d`.

The container listens only on `127.0.0.1:7420` of the machine
(`network_mode: host`, Linux only), restarts on a crash and on a reboot of the
machine (`restart: always`) and reports its state through
`docker inspect --format '{{.State.Health.Status}}'`.

Projects live in the volume `projects` (`/projects`); only paths below it can be
added in the agent bay. Clone a repository:

```bash
docker compose exec server git clone git@github.com:org/repo.git /projects/repo
```

Agent tools such as Claude Code are not in the image. A custom image adds them:

```Dockerfile
FROM hangar-server
USER root
RUN npm install -g @anthropic-ai/claude-code
USER node
```

## As a systemd service

Precondition: Node 24, Git, a checkout of the repository under `/opt/hangar`
with `pnpm install` (node-pty for Linux) and the bundles of server, CLI and
agent bay:

```bash
pnpm --filter @hangar/server --filter @hangar/cli --filter @hangar/bay-agents build
```

Then user, key file and service:

```bash
sudo useradd --create-home hangar
sudo -u hangar mkdir /home/hangar/projects
sudo install -d -m 700 /etc/hangar
sudo install -m 600 docker/server/server.env.example /etc/hangar/server.env
sudo cp docker/server/hangar-server.service /etc/systemd/system/
sudo systemctl enable --now hangar-server
```

Then fill in `/etc/hangar/server.env` and run `sudo systemctl restart
hangar-server`. Data lives in `/var/lib/hangar`, projects under
`/home/hangar/projects`. Log: `journalctl -u hangar-server`.

## Pairing

Fingerprint and pairing code are in the log (`docker compose logs server`
or `journalctl -u hangar-server`):

```
fingerprint SHA256:…
pairing code XXXX-XXXX
```

In the desktop app: plus in the sidebar → "Connect to server", address
`benutzer@server:7420`. Hangar sets up the SSH tunnel itself; the key and the
host key of the server must work in a terminal beforehand.

## Git access with deploy keys

One key per repository, never the personal one. One entry per repository in
`~/.ssh/config` of the service user (container: `ssh/config`):

```
Host github-repo
  HostName github.com
  User git
  IdentityFile ~/.ssh/repo_deploy
  IdentitiesOnly yes
```

The clone is then `git@github-repo:org/repo.git`. Write permission for the
deploy key only if agents are to push. `known_hosts` belongs in the folder too.

## API keys

Agents on the server log in with an API key (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`); a subscription login applies only to clients on one's own
notebook, or on one's own machine with a server the app set up under one's own
user (ADR 0041). Keys are only in `server.env`, never in the image or in the
repository. Sessions and jobs inherit the environment of the service. Only if
Hangar itself runs inside a Claude Code session (`CLAUDECODE` set) does the
agent bay leave out `ANTHROPIC_*`, `CLAUDE_*` and `MCP_*`.

## Permissions

A connected desktop answers permission questions. Unattended jobs need rules set
beforehand in `permissions.json` in the data folder; without a rule and without
a desktop, a call fails.

## Backup and restore

Two folders are backed up:

- Data folder (`/data` or `/var/lib/hangar`): key and paired desktops,
  permissions, jobs, settings, sessions with scrollback.
- Projects (`/projects` or `/home/hangar/projects`) including worktrees.

Container, best with the service stopped:

```bash
docker compose stop server
umask 077
docker run --rm -v hangar_data:/data -v hangar_projects:/projects debian:bookworm tar czf - /data /projects > hangar-backup.tgz
docker compose start server
```

The archive contains the private key of the server, environment variables of the
sessions and their scrollback; `umask 077` keeps it readable only for your own
user. Restoring into empty volumes, also with the service stopped:

```bash
docker run --rm -i -v hangar_data:/data -v hangar_projects:/projects debian:bookworm tar xzf - -C / < hangar-backup.tgz
```

Under systemd, back up both folders with `tar` while the service is stopped. With
the data folder backed up, fingerprint and pairings stay the same; desktops
connect without pairing again.

## Restart and update

On shutdown (`SIGTERM`) the server closes sessions and bays. On start the agent
bay restores the sessions: scrollback stays, below it "Hangar restarted", then a
new shell in the same folder. Programs running in the shells end with the
restart.

Update of a server set up from the app: "Restart server" in the app (see
above). Update of a container or system service: build and transfer a new image, then `docker compose up -d`
(or update the checkout, `pnpm build`, `systemctl restart
hangar-server`). Desktop app and server must have the same bay version.

## Check

`curl -s http://127.0.0.1:7420/health` on the server shows version, bays, errors
on loading and jobs with their last run. In the repository, `pnpm test:container`
checks the image with Docker.
