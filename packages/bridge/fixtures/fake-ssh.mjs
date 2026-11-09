#!/usr/bin/env node
// Stands in for `ssh -T -L 127.0.0.1:<local>:127.0.0.1:<remote> -- [user@]host cat` in tests:
// forwards the local port to the remote port on this machine and, like `cat` on the server,
// ends with stdin. Host `unreachable.invalid` fails like ssh does.
import { connect, createServer } from 'node:net';

const args = process.argv.slice(2);
if (args[0] === '-V') {
  process.stderr.write('OpenSSH_9.9p2, LibreSSL 3.3.6\n');
  process.exit(0);
}
const host = args.at(-2).split('@').at(-1);
if (host === 'unreachable.invalid') {
  process.stderr.write(`ssh: Could not resolve hostname ${host}: nodename nor servname provided\n`);
  process.exit(255);
}
const [, local, , remote] = args[args.indexOf('-L') + 1].split(':');
createServer((socket) => {
  const target = connect(Number(remote), '127.0.0.1');
  socket.pipe(target).pipe(socket);
  target.on('error', () => socket.destroy());
  socket.on('error', () => target.destroy());
}).listen(Number(local), '127.0.0.1');
process.stdin.resume().on('end', () => process.exit(0));
