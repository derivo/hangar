# Development server for the bridge (ADR 0020): OpenSSH + hangar-server, not for production.
# The full bookworm image brings git, python3, make and g++ for node-pty.
FROM node:24-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server \
 && apt-get clean \
 && mkdir /run/sshd /etc/ssh/keys \
 && useradd -m -s /bin/bash test \
 && printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nAllowTcpForwarding local\nAuthorizedKeysFile /etc/ssh/keys/%%u\n' >> /etc/ssh/sshd_config

# node-pty built for Linux; the agent bay (mounted below /opt/hangar/bays) finds it here.
# Same version as bays/agents/package.json; `pnpm dev:server` passes it in.
ARG NODE_PTY_VERSION=1.1.0
WORKDIR /opt/hangar
RUN npm install --no-save --no-audit --no-fund node-pty@${NODE_PTY_VERSION}

COPY entrypoint.sh /usr/local/bin/hangar-dev-entrypoint
ENTRYPOINT ["/usr/local/bin/hangar-dev-entrypoint"]
