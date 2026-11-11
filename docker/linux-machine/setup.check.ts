// `pnpm test:linux-setup` (ADR 0041, step 2): the app's setup over real ssh against a Linux
// machine with systemd (docker/linux-machine), using the package from `pnpm
// package:linux-server` for this host's architecture. Not part of `pnpm test`: it needs Docker.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  linuxPackages,
  ServerConnections,
  serverUpdate,
  setUpServer,
  uninstallServer,
  sshRemote,
  type LinuxPackage,
  type Remote,
} from '../../packages/bridge/src';

const AGENTS = 'dev.hangar.agents';
const name = `hangar-machine-${randomBytes(4).toString('hex')}`;
const image = `${name}:check`;
const dir = mkdtempSync(join(tmpdir(), 'hangar-setup-check-'));
const ssh = join(dir, 'ssh');
const target = { host: 'linux-machine' };
const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const root = (script: string) => docker('exec', name, 'sh', '-c', script);

let remote: Remote;
let packages: LinuxPackage[];
const data: string[] = [];
const connections = new ServerConnections(
  join(dir, 'servers.json'),
  { name: 'setup-check' },
  {
    changed() {},
    event(_server, _bay, channel, payload) {
      if (channel === 'session.data') data.push((payload as { data: string }).data);
    },
    ask: async () => 'deny',
    notify: () => {},
    jobs: () => {},
  },
  ssh,
);

beforeAll(async () => {
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'key')]);
  docker(
    'build',
    '--build-arg',
    `KEY=${readFileSync(join(dir, 'key.pub'), 'utf8').trim()}`,
    '-t',
    image,
    __dirname,
  );
  // systemd as PID 1 needs its cgroups; a test machine only.
  docker(
    'run',
    '-d',
    '--name',
    name,
    '--privileged',
    '--cgroupns=host',
    '-v',
    '/sys/fs/cgroup:/sys/fs/cgroup:rw',
    '-p',
    '127.0.0.1::22',
    image,
  );
  const port = docker('port', name, '22').trim().split(':').at(-1)!;
  writeFileSync(
    join(dir, 'config'),
    [
      'Host linux-machine',
      '  HostName 127.0.0.1',
      `  Port ${port}`,
      '  User person',
      `  IdentityFile ${join(dir, 'key')}`,
      '  IdentitiesOnly yes',
      '  StrictHostKeyChecking no',
      `  UserKnownHostsFile ${join(dir, 'known_hosts')}`,
      '',
    ].join('\n'),
  );
  writeFileSync(ssh, `#!/bin/sh\nexec ssh -F '${join(dir, 'config')}' "$@"\n`, { mode: 0o755 });
  remote = sshRemote(target, ssh);
  await vi.waitFor(async () => expect((await remote('echo up')).stdout).toBe('up\n'), {
    timeout: 60_000,
    interval: 1000,
  });
  packages = await linuxPackages(join(__dirname, '../../dist/linux-server'), '0.0.0-check');
});

afterAll(() => {
  connections.closeAll();
  docker('rm', '-f', name);
  docker('rmi', image);
});

it('refuses a machine whose glibc is older than the package needs, before uploading', async () => {
  const demanding = packages.map((p) => ({ ...p, glibc: '9.99' }));
  await expect(setUpServer(remote, demanding)).rejects.toThrow(/^glibc 2\.36 is older than 9\.99$/);
  await expect(setUpServer(remote, [])).rejects.toThrow(
    /^No package for (x64|arm64) in this build$/,
  );
  expect(root('ls /home/person/.local/share/hangar/runtime 2>&1 || true')).not.toMatch(/0\.0\.0/);
});

it('sets up the server as a user service, pairs, and runs a session that reaches the CLI', async () => {
  const setup = await setUpServer(remote, packages);
  expect(setup).toMatchObject({
    remoteData: '/home/person/.local/share/hangar/data',
    linger: false,
  });
  // Private files: the whole folder, data written under the unit's umask.
  expect(
    root('stat -c %a /home/person/.local/share/hangar /home/person/.local/share/hangar/data'),
  ).toBe('700\n700\n');
  expect(root('stat -c %a /home/person/.local/share/hangar/data/listen.json')).toBe('600\n');
  expect(
    root('readlink /home/person/.config/systemd/user/default.target.wants/hangar-server.service'),
  ).toContain('hangar-server.service');
  expect(root('cat /home/person/.local/share/hangar/server.env')).toMatch(
    /^PATH=".*\/usr\/bin.*"$/m,
  );

  const id = await connections.pairSetUp(target, 'machine', setup);
  expect(
    connections
      .list()[0]!
      .bays.map((b) => b.id)
      .sort(),
  ).toEqual([AGENTS, 'dev.hangar.board', 'dev.hangar.feeds']);
  root(
    "runuser -u person -- sh -c 'git init -q -b main ~/demo && cd ~/demo && echo x > a && git add a && " +
      "git -c user.name=h -c user.email=h@localhost commit -q -m init'",
  );
  const project = (await connections.invoke(id, AGENTS, 'project.add', ['/home/person/demo'])) as {
    id: string;
  };
  const session = (await connections.invoke(id, AGENTS, 'session.create', [project.id])) as {
    id: string;
  };
  await connections.invoke(id, AGENTS, 'session.input', [
    session.id,
    'echo setup-$((40+2)) && hangar status waiting\n',
  ]);
  await expect.poll(() => data.join(''), { timeout: 15_000 }).toContain('setup-42');
  const status = async () =>
    (
      (await connections.invoke(id, AGENTS, 'state', [])) as {
        sessions: { id: string; status: string }[];
      }
    ).sessions.find((s) => s.id === session.id)?.status;
  await expect.poll(status, { timeout: 15_000 }).toBe('waiting');
});

it('sets up the same build again without uploading, keeps the pairing and finds the new port', async () => {
  const id = connections.list()[0]!.id;
  const before = JSON.parse(root('cat /home/person/.local/share/hangar/data/listen.json')) as {
    port: number;
  };
  // A runtime of an older build: gone once the server runs again (step 3).
  root('runuser -u person -- mkdir /home/person/.local/share/hangar/runtime/0.0.1+old');
  const upload = vi.fn(remote);
  const setup = await setUpServer(
    (script, input) => (input ? upload(script, input) : remote(script)),
    packages,
  );
  expect(upload).not.toHaveBeenCalled();
  expect(await connections.pairSetUp(target, 'machine', setup)).toBe(id);
  // listen.json is new after the restart: a random port, read over ssh before connecting.
  expect(setup.port).not.toBe(before.port);
  await expect.poll(() => connections.list()[0]!.status, { timeout: 30_000 }).toBe('connected');
  expect(root('ls /home/person/.local/share/hangar/runtime')).toBe(`${setup.build}\n`);
});

it('reads the build the unit starts and tells a newer package apart (step 3)', async () => {
  await expect(serverUpdate(remote, packages)).resolves.toBeUndefined();
  const newer = packages.map((p) => ({ ...p, build: '9.9.9+00000000' }));
  await expect(serverUpdate(remote, newer)).resolves.toEqual({
    running: root('ls /home/person/.local/share/hangar/runtime').trim(),
    ready: '9.9.9+00000000',
  });
});

it('uninstalls the server, the data folder only when asked (step 3)', async () => {
  connections.closeAll();
  await uninstallServer(remote, { data: false });
  const gone = (path: string) => root(`test -e ${path} && echo there || echo gone`).trim();
  expect(gone('/home/person/.config/systemd/user/hangar-server.service')).toBe('gone');
  expect(gone('/home/person/.local/share/hangar/runtime')).toBe('gone');
  expect(gone('/home/person/.local/share/hangar/data/clients.json')).toBe('there');
  await expect
    .poll(() => root('pgrep -u person -f hangar-server.mjs || echo none').trim())
    .toBe('none');
  await expect(serverUpdate(remote, packages)).resolves.toBeUndefined();
  await uninstallServer(remote, { data: true });
  expect(gone('/home/person/.local/share/hangar')).toBe('gone');
});
