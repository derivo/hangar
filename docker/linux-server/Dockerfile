# Linux package of hangar-server that the app ships and sets up over SSH (ADR 0041).
# Build with `pnpm package:linux-server [x64|arm64]…`; the result is
# dist/linux-server/hangar-server-linux-<arch>.tar.gz.

# Same Debian as the server image (ADR 0029): node-pty is compiled against its glibc,
# which is the baseline the package needs (measured below into requirements.json).
FROM node:24-bookworm AS build
ARG NODE_PTY_VERSION=1.1.0
WORKDIR /pkg/hangar-server
# Only what runs: sources, build intermediates and the prebuilds of other systems stay out.
RUN npm install --no-save --no-audit --no-fund --omit=dev node-pty@${NODE_PTY_VERSION} \
 && rm -r node_modules/node-addon-api \
 && cd node_modules/node-pty \
 && rm -rf src deps scripts third_party prebuilds build/Release/obj.target build/Release/.deps \
 && cd /pkg/hangar-server \
 && cp /usr/local/bin/node node
COPY apps/server/dist/hangar-server.mjs server/
COPY packages/cli/dist/hangar.mjs cli/
COPY bays/agents/manifest.json bays/agents/icon.svg bays/agents/
COPY bays/agents/dist bays/agents/dist
COPY bays/board/manifest.json bays/board/icon.svg bays/board/
COPY bays/board/dist bays/board/dist
COPY bays/feeds/manifest.json bays/feeds/icon.svg bays/feeds/
COPY bays/feeds/dist bays/feeds/dist
# The newest glibc and libstdc++ symbol versions any binary of the package needs; the setup
# refuses a machine with an older glibc before uploading (ADR 0041) and then starts node-pty there.
RUN newest() { find . -type f \( -name node -o -name '*.node' \) -exec objdump -T {} + \
      | grep -o "$1[0-9.]*" | sed "s/$1//" | sort -V | tail -1; } \
 && printf '{"glibc":"%s","glibcxx":"%s","cxxabi":"%s","node":"%s"}\n' \
      "$(newest GLIBC_)" "$(newest GLIBCXX_)" "$(newest CXXABI_)" "$(./node --version)" \
      > requirements.json \
 && cat requirements.json \
 && cd /pkg && tar --owner=0 --group=0 -czf /hangar-server.tar.gz hangar-server

FROM scratch
COPY --from=build /hangar-server.tar.gz /
