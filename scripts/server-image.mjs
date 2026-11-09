// Production image of hangar-server (ADR 0029): `pnpm image:server [tag]`, default `hangar-server`.
// Builds the bundles the image copies, then the image with the node-pty version of the agent bay.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const tag = process.argv[2] ?? 'hangar-server';
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });
const pty = JSON.parse(readFileSync(join(root, 'bays/agents/package.json'), 'utf8')).dependencies[
  'node-pty'
];

run('pnpm', [
  '--filter',
  '@hangar/server',
  '--filter',
  '@hangar/cli',
  '--filter',
  '@hangar/bay-agents',
  'build',
]);
run('docker', [
  'build',
  '-f',
  'docker/server/Dockerfile',
  '--build-arg',
  `NODE_PTY_VERSION=${pty}`,
  '-t',
  tag,
  '.',
]);
