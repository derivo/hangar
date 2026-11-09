// Image of the Hangar Relay (ADR 0011): `pnpm image:relay [tag]`, default `hangar-relay`.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const tag = process.argv[2] ?? 'hangar-relay';
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });

run('pnpm', ['--filter', '@hangar/relay-server', 'build']);
run('docker', ['build', '-f', 'docker/relay/Dockerfile', '-t', tag, '.']);
