# Image of the Hangar Relay (ADR 0011, docs/relay-operations.md). Build from the repository root after
# `pnpm --filter @hangar/relay-server build`, or with `pnpm image:relay`:
#   docker build -f docker/relay/Dockerfile -t hangar-relay .
FROM node:24-bookworm-slim
# tini forwards SIGTERM to node; the relay bundles everything else.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir /data /tls \
 && chown node:node /data \
 && chmod 700 /data

WORKDIR /opt/hangar
COPY apps/relay/dist/hangar-relay.mjs ./

USER node
# relay.json: workspaces, member lists, invitation hashes. Fresh named volumes take over the owner.
VOLUME ["/data"]
EXPOSE 7430
# Certificate and key are mounted to /tls; the check skips verification, it only asks this process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --start-interval=1s \
  CMD ["node", "-e", "require('https').get('https://127.0.0.1:7430/health', { rejectUnauthorized: false }, (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
ENTRYPOINT ["tini", "--", "node", "/opt/hangar/hangar-relay.mjs"]
# Beyond loopback only with TLS; HANGAR_RELAY_TOKEN and HANGAR_RELAY_URL come from the environment.
CMD ["--data", "/data", "--listen", "0.0.0.0:7430", "--tls-cert", "/tls/cert.pem", "--tls-key", "/tls/key.pem"]
