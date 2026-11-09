#!/usr/bin/env node
// `open-tunnel.mjs <ssh> <host> <port>`: opens a tunnel like the desktop, holds a connection
// through it (like the desktop's WebSocket), prints its local port and stays. Tests kill it hard
// to show that the tunnel does not outlive it.
import { connect } from 'node:net';

const { openTunnel } = await import('../src/tunnel.ts');
const [ssh, host, port] = process.argv.slice(2);
const tunnel = await openTunnel({ host, port: Number(port) }, ssh);
await new Promise((resolve, reject) =>
  connect(tunnel.port, '127.0.0.1', resolve).on('error', reject),
);
console.log(tunnel.port);
