# A plain Linux machine for `pnpm test:linux-server` (ADR 0041): Debian of the baseline without
# Node, a normal user, the package unpacked. Build context: dist/linux-server.
FROM debian:bookworm-slim
ARG ARCH=x64
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -r /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash person
ADD hangar-server-linux-${ARCH}.tar.gz /opt/
USER person
WORKDIR /home/person
ENTRYPOINT ["/opt/hangar-server/node", "/opt/hangar-server/server/hangar-server.mjs", \
  "--data", "/home/person/.local/share/hangar/data", "--listen", "127.0.0.1:7420", \
  "--root", "/home/person", "--bays", "/opt/hangar-server/bays", \
  "--cli", "/opt/hangar-server/cli/hangar.mjs"]
