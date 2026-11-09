// `pnpm test:ssh` (ADR 0020): the bridge over real ssh against the dev server, which
// `pnpm dev:server` has just started. Not part of `pnpm test`: it needs Docker.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { ServerConnections } from '../../packages/bridge/src';

const log = execFileSync(
  'docker',
  ['compose', '-f', join(__dirname, 'compose.yaml'), 'logs', '--no-log-prefix', 'server'],
  { encoding: 'utf8', env: { ...process.env, HANGAR_DEV_KEY: 'unused' } },
);
const logValue = (prefix: string) =>
  [...log.matchAll(new RegExp(`^${prefix} (\\S+)$`, 'gm'))].at(-1)![1]!;

const ssh = join(__dirname, '../../.dev-server/ssh');
const data: string[] = [];
const connections = new ServerConnections(
  join(mkdtempSync(join(tmpdir(), 'hangar-ssh-check-')), 'servers.json'),
  { name: 'ssh-check' },
  {
    changed() {},
    event(_server, _bay, channel, payload) {
      if (channel === 'session.data') data.push((payload as { data: string }).data);
    },
    // Nothing here needs a permission; a question would be a surprise.
    ask: async () => 'deny',
    notify: () => {},
    jobs: () => {},
  },
  ssh,
);
afterAll(() => connections.closeAll());

const AGENTS = 'dev.hangar.agents';

it('pairs over ssh and runs a session of the agent bay on the server', async () => {
  const probe = await connections.probe('hangar-dev:7420');
  expect(probe.fingerprint).toBe(logValue('fingerprint'));
  const id = await connections.pair(probe.id, 'ssh-check', logValue('pairing code'));
  expect(connections.list()[0]!.bays.map((b) => b.id)).toContain(AGENTS);

  // The volumes outlive runs: the demo project may already be there.
  const demo = '/home/test/projects/demo';
  const { projects } = (await connections.invoke(id, AGENTS, 'state', [])) as {
    projects: { id: string; path: string }[];
  };
  const added = projects.find((p) => p.path === demo);
  const project =
    added ?? ((await connections.invoke(id, AGENTS, 'project.add', [demo])) as { id: string });
  const session = (await connections.invoke(id, AGENTS, 'session.create', [project.id])) as {
    id: string;
  };
  try {
    await connections.invoke(id, AGENTS, 'session.input', [session.id, 'uname -sm\n']);
    await expect.poll(() => data.join(''), { timeout: 15_000 }).toMatch(/Linux (aarch64|x86_64)/);
    // The hangar CLI in the session reaches the server's MCP server with the session token.
    await connections.invoke(id, AGENTS, 'session.input', [
      session.id,
      'hangar describe ssh-check-ok\n',
    ]);
    const described = async () => {
      const { sessions } = (await connections.invoke(id, AGENTS, 'state', [])) as {
        sessions: { id: string; description: string }[];
      };
      return sessions.find((s) => s.id === session.id)?.description;
    };
    await expect.poll(described, { timeout: 15_000 }).toBe('ssh-check-ok');
  } finally {
    await connections.invoke(id, AGENTS, 'session.close', [session.id]);
    if (!added) await connections.invoke(id, AGENTS, 'project.remove', [project.id]);
  }
});

it('names what ssh says for a user without a key', async () => {
  await expect(connections.probe('nobody@hangar-dev:7420')).rejects.toThrow(
    'SSH failed: nobody@127.0.0.1: Permission denied (publickey).',
  );
});

it('ends the ssh tunnel when the desktop dies without closing it', async () => {
  const opener = spawn(
    process.execPath,
    [join(__dirname, '../../packages/bridge/fixtures/open-tunnel.mjs'), ssh, 'hangar-dev', '7420'],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const [chunk] = (await opener.stdout.take(1).toArray()) as Buffer[];
  const port = Number(String(chunk));
  opener.kill('SIGKILL');
  const accepts = () =>
    new Promise<boolean>((resolve) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
  await expect.poll(accepts, { timeout: 10_000 }).toBe(false);
});
