// `pnpm test:container` (Phase 12): the production image of hangar-server, which the script has
// just built as `hangar-server:test`. Not part of `pnpm test`: it needs Docker.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ServerConnections } from '../../packages/bridge/src';

const IMAGE = process.env.HANGAR_IMAGE ?? 'hangar-server:test';
const AGENTS = 'dev.hangar.agents';
const name = `hangar-smoke-${randomBytes(4).toString('hex')}`;
const volumes = [`${name}-data`, `${name}-projects`];
const ssh = join(__dirname, 'docker-ssh.mjs');
const servers = join(mkdtempSync(join(tmpdir(), 'hangar-container-check-')), 'servers.json');

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' });
const exec = (...args: string[]) => docker('exec', name, ...args);
const logValue = (prefix: string) =>
  [...docker('logs', name).matchAll(new RegExp(`^${prefix} (\\S+)$`, 'gm'))].at(-1)?.[1];
const health = () =>
  JSON.parse(
    exec(
      'node',
      '-e',
      "fetch('http://127.0.0.1:7420/health').then(r => r.text()).then(console.log)",
    ),
  ) as {
    bays: { id: string }[];
    errors: unknown[];
    jobs: { id: string; lastRun?: { ok: boolean } }[];
  };
const status = () => docker('inspect', '--format', '{{.State.Health.Status}}', name).trim();

const data: string[] = [];
const connect = () =>
  new ServerConnections(
    servers,
    { name: 'container-check' },
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
let connections = connect();

beforeAll(async () => {
  docker(
    'run',
    '-d',
    '--name',
    name,
    '-v',
    `${volumes[0]}:/data`,
    '-v',
    `${volumes[1]}:/projects`,
    // An API key in the environment of the service reaches sessions and jobs (ADR 0029).
    '-e',
    'ANTHROPIC_API_KEY=smoke-key',
    IMAGE,
  );
  await vi.waitFor(() => expect(logValue('listening on')).toBeTruthy(), { timeout: 60_000 });
});

afterAll(() => {
  connections.closeAll();
  docker('rm', '-f', name);
  docker('volume', 'rm', ...volumes);
});

it('runs as a user without root rights and owns its volumes', () => {
  // Keys, tokens and scrollback: nobody else reads the data folder.
  expect(exec('stat', '-c', '%a', '/data').trim()).toBe('700');
  expect(exec('id', '-u').trim()).not.toBe('0');
  expect(exec('stat', '-c', '%U', '/data', '/projects').trim().split('\n')).toEqual([
    exec('id', '-un').trim(),
    exec('id', '-un').trim(),
  ]);
});

it('is healthy, loads the agent bay and listens on the loopback only', async () => {
  await expect.poll(status, { timeout: 60_000 }).toBe('healthy');
  const { bays, errors } = health();
  expect(bays.map((b) => b.id)).toContain(AGENTS);
  expect(errors).toEqual([]);
  // Nothing on another address of the container answers.
  const ip = docker(
    'inspect',
    '--format',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
    name,
  ).trim();
  expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  expect(() =>
    exec(
      'node',
      '-e',
      `fetch('http://${ip}:7420/health').then(() => process.exit(0), () => process.exit(1))`,
    ),
  ).toThrow();
});

it('runs a session and a job with the API key, and a restart of the container brings the session and the job back', async () => {
  const probe = await connections.probe(`${name}:7420`);
  expect(probe.fingerprint).toBe(logValue('fingerprint'));
  const id = await connections.pair(probe.id, 'container-check', logValue('pairing code')!);

  exec(
    'sh',
    '-c',
    'git init -q -b main /projects/demo && cd /projects/demo && echo "# demo" > README.md && ' +
      'git add README.md && git -c user.name=hangar -c user.email=hangar@localhost commit -q -m init',
  );
  const project = (await connections.invoke(id, AGENTS, 'project.add', ['/projects/demo'])) as {
    id: string;
  };
  const session = (await connections.invoke(id, AGENTS, 'session.create', [project.id])) as {
    id: string;
  };
  await connections.invoke(id, AGENTS, 'session.input', [
    session.id,
    'echo before-$((40+2)) key-$ANTHROPIC_API_KEY\n',
  ]);
  await expect.poll(() => data.join(''), { timeout: 15_000 }).toContain('before-42 key-smoke-key');

  const job = (await connections.invoke(id, AGENTS, 'job.add', [
    session.id,
    'test "$ANTHROPIC_API_KEY" = smoke-key',
    '0 0 1 1 *',
  ])) as { id: string };
  await connections.job(id, 'run', job.id);
  const lastRun = () => health().jobs.find((j) => j.id === job.id)?.lastRun?.ok;
  await expect.poll(lastRun, { timeout: 30_000 }).toBe(true);

  connections.closeAll();
  docker('restart', name);
  await expect.poll(status, { timeout: 60_000 }).toBe('healthy');

  connections = connect();
  data.length = 0;
  await connections.connectAll();
  const { sessions } = (await connections.invoke(id, AGENTS, 'state', [])) as {
    sessions: { id: string }[];
  };
  expect(sessions.map((s) => s.id)).toContain(session.id);
  const buffer = (await connections.invoke(id, AGENTS, 'session.buffer', [session.id])) as string;
  expect(buffer).toContain('before-42');
  expect(buffer).toContain('Hangar restarted');
  // The new shell of the restored session answers.
  await connections.invoke(id, AGENTS, 'session.input', [session.id, 'echo after-$((40+3))\n']);
  await expect.poll(() => data.join(''), { timeout: 15_000 }).toContain('after-43');
  expect(lastRun()).toBe(true);
});
