#!/bin/sh
# Starts sshd and hangar-server as user `test` (ADR 0020).
set -eu

: "${HANGAR_DEV_KEY:?public key missing: start with pnpm dev:server}"
printf '%s\n' "$HANGAR_DEV_KEY" > /etc/ssh/keys/test
chmod 644 /etc/ssh/keys/test

# Volumes start out owned by root.
chown test:test /home/test/data /home/test/projects

# A project to try sessions with; --root allows only this folder.
if [ ! -d /home/test/projects/demo/.git ]; then
  runuser -u test -- sh -c '
    git init -q -b main /home/test/projects/demo &&
    cd /home/test/projects/demo &&
    echo "# demo" > README.md &&
    git add README.md &&
    git -c user.name=hangar -c user.email=hangar@localhost commit -q -m init'
fi

/usr/sbin/sshd
exec runuser -u test -- node /opt/hangar/apps/server/dist/hangar-server.mjs \
  --data /home/test/data \
  --listen 127.0.0.1:7420 \
  --root /home/test/projects \
  --bays /opt/hangar/bays
