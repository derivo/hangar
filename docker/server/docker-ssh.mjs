#!/usr/bin/env node
// Stands in for `ssh -L 127.0.0.1:<local>:127.0.0.1:<remote> -- <host> cat` in `pnpm test:container`:
// <host> is a container, and each connection reaches the container's own loopback through
// `docker exec`, as ssh to a server reaches the server's loopback. Ends with stdin like `cat`.
// The container's node is HANGAR_DOCKER_NODE, default `node` on its PATH.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const args = process.argv.slice(2);
const container = args.at(-2).split('@').at(-1);
const [, local, , remote] = args[args.indexOf('-L') + 1].split(':');
const pipe = `const s = require('net').connect(${Number(remote)}, '127.0.0.1');
process.stdin.pipe(s).pipe(process.stdout);
s.on('error', () => process.exit(1)).on('close', () => process.exit(0));`;
createServer((socket) => {
  const exec = spawn(
    'docker',
    ['exec', '-i', container, process.env.HANGAR_DOCKER_NODE ?? 'node', '-e', pipe],
    {
      stdio: ['pipe', 'pipe', 'ignore'],
    },
  );
  socket.pipe(exec.stdin);
  exec.stdout.pipe(socket);
  exec.on('exit', () => socket.destroy());
  socket.on('close', () => exec.kill());
  socket.on('error', () => exec.kill());
  exec.stdin.on('error', () => socket.destroy());
}).listen(Number(local), '127.0.0.1');
process.stdin.resume().on('end', () => process.exit(0));
