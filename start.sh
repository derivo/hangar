#!/bin/sh
# Starts Hangar in dev mode: checks Node and pnpm, installs dependencies if needed.
set -eu
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js fehlt. Benötigt wird Version 22.12 oder neuer: https://nodejs.org" >&2
  exit 1
fi
# Vite, Vitest and electron-vite need 22.12 or newer.
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)'; then
  echo "Node.js $(node -v) ist zu alt. Benötigt wird Version 22.12 oder neuer." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm fehlt. Installieren mit: npm install -g pnpm" >&2
  exit 1
fi

# Install when dependencies are missing or the lockfile changed since the last install.
if [ ! -d node_modules ] || [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; then
  pnpm install
fi

exec pnpm dev
