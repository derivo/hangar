// `pnpm test:linux-server [x64|arm64]` (ADR 0041, step 1): the Linux package in a plain Debian
// without Node, as the app will set it up. Not part of `pnpm test`: it needs Docker and the
// package from `pnpm package:linux-server`.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ServerConnections } from '../../packages/bridge/src';

const ARCH = process.env.HANGAR_LINUX_ARCH ?? (process.arch === 'arm64' ? 'arm64' : 'x64');
const PLATFORM = ARCH === 'arm64' ? 'linux/arm64' : 'linux/amd64';
const AGENTS = 'dev.hangar.agents';
const NODE = '/opt/hangar-server/node';
const PACKAGE = join(__dirname, `../../dist/linux-server/hangar-server-linux-${ARCH}.tar.gz`);
const OLDEST = 'rockylinux/rockylinux:9-minimal';
const OLDER = 'debian:bullseye-slim';
const name = `hangar-linux-${randomBytes(4).toString('hex')}`;
const image = `${name}:check`;
const servers = join(mkdtempSync(join(tmpdir(), 'hangar-linux-check-')), 'servers.json');
process.env.HANGAR_DOCKER_NODE = NODE;

const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const exec = (...args: string[]) => docker('exec', name, ...args);
const logValue = (prefix: string) =>
  [...docker('logs', name).matchAll(new RegExp(`^${prefix} (\\S+)$`, 'gm'))].at(-1)?.[1];
const health = () =>
  JSON.parse(
    exec(NODE, '-e', "fetch('http://127.0.0.1:7420/health').then(r => r.text()).then(console.log)"),
  ) as { bays: { id: string }[]; errors: unknown[] };

const data: string[] = [];
const connect = () =>
  new ServerConnections(
    servers,
    { name: 'linux-check' },
    {
      changed() {},
      event(_server, _bay, channel, payload) {
        if (channel === 'session.data') data.push((payload as { data: string }).data);
      },
      ask: async () => 'deny',
      notify: () => {},
      jobs: () => {},
    },
    join(__dirname, '../server/docker-ssh.mjs'),
  );
let connections = connect();

beforeAll(async () => {
  docker(
    'build',
    '--platform',
    PLATFORM,
    '-f',
    join(__dirname, 'check.Dockerfile'),
    '--build-arg',
    `ARCH=${ARCH}`,
    '-t',
    image,
    join(__dirname, '../../dist/linux-server'),
  );
  docker('run', '-d', '--platform', PLATFORM, '--name', name, image);
  await vi.waitFor(() => expect(logValue('listening on')).toBeTruthy(), { timeout: 60_000 });
});

afterAll(() => {
  connections.closeAll();
  docker('rm', '-f', name);
  docker('rmi', image);
});

it('needs no Node on the machine', () => {
  expect(() => exec('sh', '-c', 'command -v node')).toThrow();
});

// The declared minimum against real systems: Rocky Linux 9 has exactly glibc 2.34, Debian 11 2.31
// (there Node itself starts, node-pty does not load).
it('starts node-pty on a machine with the declared glibc and fails below it', () => {
  const unpacked = mkdtempSync(join(tmpdir(), 'hangar-linux-pkg-'));
  execFileSync('tar', ['xzf', `${PACKAGE}`, '-C', unpacked]);
  const { glibc } = JSON.parse(
    readFileSync(join(unpacked, 'hangar-server/requirements.json'), 'utf8'),
  ) as { glibc: string };
  const pty =
    "const t = require('/opt/hangar-server/node_modules/node-pty').spawn('/bin/sh', ['-c', 'echo pty-ok'], {});" +
    't.onData((d) => process.stdout.write(d)); t.onExit(() => process.exit(0));';
  const run = (image: string, ...cmd: string[]) =>
    docker(
      'run',
      '--rm',
      '--platform',
      PLATFORM,
      '-v',
      `${unpacked}/hangar-server:/opt/hangar-server:ro`,
      image,
      ...cmd,
    );
  const version = (image: string) => run(image, 'getconf', 'GNU_LIBC_VERSION').trim().split(' ')[1];
  expect(version(OLDEST)).toBe(glibc);
  expect(run(OLDEST, NODE, '-e', pty)).toContain('pty-ok');
  expect(Number(version(OLDER)!.split('.')[1])).toBeLessThan(Number(glibc.split('.')[1]));
  expect(() => run(OLDER, NODE, '-e', pty)).toThrow(/Failed to load native module: pty\.node/);
});

it('loads the bays of the local server without errors', () => {
  const { bays, errors } = health();
  expect(bays.map((b) => b.id).sort()).toEqual([AGENTS, 'dev.hangar.board', 'dev.hangar.feeds']);
  expect(errors).toEqual([]);
});

it('runs a session whose shell reaches the hangar CLI, and a restart brings it back', async () => {
  const probe = await connections.probe(`${name}:7420`);
  expect(probe.fingerprint).toBe(logValue('fingerprint'));
  const id = await connections.pair(probe.id, 'linux-check', logValue('pairing code')!);

  exec(
    'sh',
    '-c',
    'git init -q -b main ~/demo && cd ~/demo && echo "# demo" > README.md && ' +
      'git add README.md && git -c user.name=hangar -c user.email=hangar@localhost commit -q -m init',
  );
  const project = (await connections.invoke(id, AGENTS, 'project.add', ['/home/person/demo'])) as {
    id: string;
  };
  const session = (await connections.invoke(id, AGENTS, 'session.create', [project.id])) as {
    id: string;
  };
  // The CLI runs with the package's node: the session turns "waiting".
  await connections.invoke(id, AGENTS, 'session.input', [
    session.id,
    'echo before-$((40+2)) && hangar status waiting\n',
  ]);
  await expect.poll(() => data.join(''), { timeout: 15_000 }).toContain('before-42');
  const status = async () =>
    (
      (await connections.invoke(id, AGENTS, 'state', [])) as {
        sessions: { id: string; status: string }[];
      }
    ).sessions.find((s) => s.id === session.id)?.status;
  await expect.poll(status, { timeout: 15_000 }).toBe('waiting');

  connections.closeAll();
  docker('restart', name);
  await vi.waitFor(() => expect(health().bays.length).toBe(3), { timeout: 60_000 });

  connections = connect();
  data.length = 0;
  await connections.connectAll();
  const buffer = (await connections.invoke(id, AGENTS, 'session.buffer', [session.id])) as string;
  expect(buffer).toContain('before-42');
  await connections.invoke(id, AGENTS, 'session.input', [session.id, 'echo after-$((40+3))\n']);
  await expect.poll(() => data.join(''), { timeout: 15_000 }).toContain('after-43');
});
