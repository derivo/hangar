import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentsBay } from '@hangar/bay-agents/src/main/index';
import { fakeContext as agentsContext } from '@hangar/bay-agents/src/main/test-ctx';
import { fakeSpawn } from '@hangar/bay-agents/src/main/test-pty';
import { createTempRepo } from '@hangar/bay-agents/src/main/test-repo';
import board from '@hangar/bay-board/src/main/index';
import { fakeContext as boardContext } from '@hangar/bay-board/src/main/test-ctx';
import { Bus, MemoryPermissionStore } from '@hangar/bus';
import { createIdentity, RelayClient, remoteBayId } from '@hangar/relay';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRelay, type Relay } from './relay';

const OPERATOR = 'operator-token';
const AGENTS = 'dev.hangar.agents';
const BOARD = 'dev.hangar.board';
const TASKS = ['task.list', 'task.add', 'task.claim', 'task.note', 'task.done'];
let relay: Relay | undefined;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
  await relay?.close();
  relay = undefined;
});

async function instance(name: string, dir: string) {
  const identity = createIdentity(name);
  const shared: string[] = [];
  const ref: { client?: RelayClient } = {};
  const bus = new Bus({
    permissions: new MemoryPermissionStore(),
    prompter: { ask: vi.fn(async () => 'allow' as const) },
    remote: {
      isMember: (w, i) => ref.client!.isMember(w, i),
      isShared: (w, t) => ref.client!.isShared(w, t),
    },
  });
  const client = await RelayClient.connect({
    url: relay!.url,
    identity,
    bus,
    dataDir: join(dir, name),
    shared: () => shared,
  });
  ref.client = client;
  cleanup.push(() => client.close());
  return { identity, bus, client, shared };
}

/** Anna runs the real agent bay and board with projects shop (shared) and blog; Ben joins. */
async function team() {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-board-it-'));
  relay = await startRelay({ file: join(dir, 'relay.json'), operatorToken: OPERATOR });
  const anna = await instance('anna', dir);
  const ben = await instance('ben', dir);

  const agents = createAgentsBay(fakeSpawn());
  const a = agentsContext();
  await agents.activate(a.ctx);
  cleanup.push(() => agents.deactivate!());
  const manager = agents.manager!;
  const shop = await manager.addProject(createTempRepo('shop'));
  await manager.addProject(createTempRepo('blog'));
  manager.setProjectShared(shop.id, true);

  const b = boardContext();
  // The board asks the agent bay as a bay of the same instance.
  b.ctx.call.mockImplementation(
    async (target: string, args?: unknown) =>
      a.functions.get(target.slice(`${AGENTS}/`.length))!(args, {
        caller: { kind: 'bay', bayId: BOARD },
      }) as never,
  );
  await board.activate(b.ctx);
  for (const name of TASKS)
    anna.bus.register(
      BOARD,
      { name, sensitive: false, openToAgents: true, remote: true },
      (x, info) => b.call(name, x, info),
    );

  await anna.client.create('team', OPERATOR);
  const joined = new Promise<void>((resolve) =>
    anna.client.onJoined((workspace, identity) => {
      void anna.client.addMember(workspace, identity).then(resolve);
    }),
  );
  await ben.client.join('team', await anna.client.invite('team'), anna.identity.fingerprint);
  await joined;
  await vi.waitFor(() => expect(ben.client.isMember('team', anna.identity.fingerprint)).toBe(true));
  return { anna, ben };
}

const session = { kind: 'session' as const, bayId: AGENTS, sessionId: 's1' };

describe('the board for agents of another instance over the relay (ADR 0037, Nachtrag)', () => {
  it('adds, claims and finishes tasks of a shared project', async () => {
    const { anna, ben } = await team();
    anna.shared.push(...TASKS.map((n) => `${BOARD}/${n}`));
    anna.client.announceAll('team');
    const id = (name: string) => `${remoteBayId(anna.identity.document, BOARD)}/${name}`;
    await vi.waitFor(() => expect(ben.bus.list().map((f) => f.id)).toContain(id('task.done')));

    const task = (await ben.bus.call(session, id('task.add'), {
      project: 'shop',
      title: 'Suche testen',
    })) as { id: string; createdBy: string };
    expect(task.createdBy).toBe(`${ben.identity.fingerprint.slice(0, 16)} (team)`);
    await ben.bus.call(session, id('task.claim'), { project: 'shop', id: task.id });
    expect(
      await ben.bus.call(session, id('task.done'), { project: 'shop', id: task.id, note: 'grün' }),
    ).toMatchObject({ status: 'done', sessionId: `remote:${ben.identity.fingerprint}/` });
    // The relay carries no session of the other side: the instance holds the task.
    await expect(ben.bus.call(session, id('task.list'), { project: 'blog' })).rejects.toThrow(
      'No such shared project',
    );
  });

  it('is refused without the share list, even when called by name', async () => {
    const { anna, ben } = await team();
    expect(ben.bus.list().some((f) => f.id.endsWith(`${BOARD}/task.add`))).toBe(false);
    const forged = {
      kind: 'remote' as const,
      instance: ben.identity.fingerprint,
      workspace: 'team',
      bayId: AGENTS,
      sessionId: 's1',
    };
    await expect(
      anna.bus.call(forged, `${BOARD}/task.add`, { project: 'shop', title: 'x' }),
    ).rejects.toThrow('Access denied');
  });
});
