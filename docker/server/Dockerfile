# Production image of hangar-server (ADR 0029). Build from the repository root after
# `pnpm --filter @hangar/server --filter @hangar/cli --filter @hangar/bay-agents build`:
#   docker build -f docker/server/Dockerfile -t hangar-server .

# node-pty is compiled here (python3, make, g++); the runtime image stays without them.
FROM node:24-bookworm AS pty
ARG NODE_PTY_VERSION=1.1.0
WORKDIR /opt/hangar
RUN npm install --no-save --no-audit --no-fund node-pty@${NODE_PTY_VERSION}

FROM node:24-bookworm-slim
# git for worktrees, openssh-client for deploy keys, tini forwards SIGTERM to node.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir /data /projects \
 && chown node:node /data /projects \
 && chmod 700 /data

# Same layout as the repository: the server finds the CLI at ../../../packages/cli.
WORKDIR /opt/hangar
COPY --from=pty /opt/hangar/node_modules node_modules
COPY apps/server/dist apps/server/dist
COPY packages/cli/dist packages/cli/dist
COPY bays/agents/manifest.json bays/agents/icon.svg bays/agents/
COPY bays/agents/dist bays/agents/dist

USER node
ENV SHELL=/bin/bash
# Fresh named volumes take over the owner of these folders.
VOLUME ["/data", "/projects"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=1s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:7420/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["tini", "--", "node", "/opt/hangar/apps/server/dist/hangar-server.mjs"]
# Loopback only (ADR 0018): reach it with ssh to the host and `docker exec`, or network_mode host.
CMD ["--data", "/data", "--listen", "127.0.0.1:7420", "--root", "/projects", "--bays", "/opt/hangar/bays"]
