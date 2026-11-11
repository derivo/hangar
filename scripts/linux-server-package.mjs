// Linux packages of hangar-server that the app ships (ADR 0041):
// `pnpm package:linux-server [x64|arm64]…`, default both. Builds the bundles, then each package
// with Docker (another architecture through buildx/QEMU) into dist/linux-server/.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const arches = process.argv.slice(2).length ? process.argv.slice(2) : ['x64', 'arm64'];
const platform = { x64: 'linux/amd64', arm64: 'linux/arm64' };
for (const arch of arches) if (!platform[arch]) throw new Error(`Unknown architecture ${arch}`);
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });
const pty = JSON.parse(readFileSync(join(root, 'bays/agents/package.json'), 'utf8')).dependencies[
  'node-pty'
];

const bundles = ['@hangar/server', '@hangar/cli', '@hangar/bay-agents', '@hangar/bay-board'];
run('pnpm', [...bundles, '@hangar/bay-feeds'].flatMap((b) => ['--filter', b]).concat('build'));
const out = join(root, 'dist/linux-server');
mkdirSync(out, { recursive: true });
for (const arch of arches) {
  // Next to the result: a rename across file systems would fail (EXDEV).
  const dest = mkdtempSync(join(out, '.build-'));
  run('docker', [
    'buildx',
    'build',
    // The newest node:24 for every architecture, not an older one from the cache.
    '--pull',
    '--platform',
    platform[arch],
    '-f',
    'docker/linux-server/Dockerfile',
    '--build-arg',
    `NODE_PTY_VERSION=${pty}`,
    '--output',
    `type=local,dest=${dest}`,
    '.',
  ]);
  const file = join(out, `hangar-server-linux-${arch}.tar.gz`);
  renameSync(join(dest, 'hangar-server.tar.gz'), file);
  rmSync(dest, { recursive: true });
  console.log(`${file}: ${(statSync(file).size / 1e6).toFixed(1)} MB`);
}
