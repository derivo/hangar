import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentsBay } from '@hangar/bay-agents/src/main/index';
import { fakeContext } from '@hangar/bay-agents/src/main/test-ctx';
import { fakeSpawn } from '@hangar/bay-agents/src/main/test-pty';
import { createTempRepo } from '@hangar/bay-agents/src/main/test-repo';
import { Bus, MemoryPermissionStore } from '@hangar/bus';
import { createIdentity, RelayClient, remoteBayId } from '@hangar/relay';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRelay, type Relay } from './relay';

const OPERATOR = 'operator-token';
const AGENTS = 'dev.hangar.agents';
let relay: Relay | undefined;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
  await relay?.close();
  relay = undefined;
});

/** A Hangar bus over the relay; `shared` is its share list for every workspace. */
async function instance(name: string, dir: string, shared: string[]) {
  const identity = createIdentity(name);
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

/** Anna with the real agent bay on her bus and a project `shop`; Ben in the same workspace. */
async function team() {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-handover-it-'));
  relay = await startRelay({ file: join(dir, 'relay.json'), operatorToken: OPERATOR });
  const anna = await instance('anna', dir, []);
  const ben = await instance('ben', dir, []);

  const bay = createAgentsBay(fakeSpawn());
  const { ctx, functions } = fakeContext();
  await bay.activate(ctx);
  cleanup.push(() => bay.deactivate!());
  for (const name of ['handover.create', 'handover.get'])
    anna.bus.register(
      AGENTS,
      { name, sensitive: false, remote: name === 'handover.create' },
      (args, info) => functions.get(name)!(args, info),
    );
  const manager = bay.manager!;
  const project = await manager.addProject(createTempRepo('shop'));

  await anna.client.create('team', OPERATOR);
  const joined = new Promise<void>((resolve) =>
    anna.client.onJoined((workspace, identity) => {
      void anna.client.addMember(workspace, identity).then(resolve);
    }),
  );
  await ben.client.join('team', await anna.client.invite('team'), anna.identity.fingerprint);
  await joined;
  await vi.waitFor(() => expect(ben.client.isMember('team', anna.identity.fingerprint)).toBe(true));
  return { anna, ben, manager, project };
}

const session = { kind: 'session' as const, bayId: AGENTS, sessionId: 's1' };
const args = {
  project: 'shop',
  task: 'Review des Login-Branches',
  branch: 'feature/login',
  remote: 'git@github.com:ben/shop.git',
};

describe('handover to another instance over the relay (phase 17, ADR 0031)', () => {
  it('reaches a shared project as text and Git references', async () => {
    const { anna, ben, manager, project } = await team();
    manager.setProjectShared(project.id, true);
    anna.shared.push(`${AGENTS}/handover.create`);
    anna.client.announceAll('team');
    const id = `${remoteBayId(anna.identity.document, AGENTS)}/handover.create`;
    await vi.waitFor(() => expect(ben.bus.list().map((f) => f.id)).toContain(id));

    expect(await ben.bus.call(session, id, args)).toEqual({ ok: true });
    expect(manager.view().sessions.at(-1)!.handover).toMatchObject({
      origin: 'remote',
      from: `${ben.identity.fingerprint.slice(0, 16)} (team)`,
      task: args.task,
      branch: args.branch,
      remote: args.remote,
    });
    // Only the handover is shared: reading one stays on Anna's side.
    expect(ben.bus.list().map((f) => f.id)).not.toContain(
      `${remoteBayId(anna.identity.document, AGENTS)}/handover.get`,
    );
  });

  it('is refused without the share list, even when called by name', async () => {
    const { anna, ben, manager, project } = await team();
    manager.setProjectShared(project.id, true);
    expect(ben.bus.list().some((f) => f.id.endsWith('/handover.create'))).toBe(false);
    const forged = {
      kind: 'remote' as const,
      instance: ben.identity.fingerprint,
      workspace: 'team',
      bayId: AGENTS,
    };
    await expect(anna.bus.call(forged, `${AGENTS}/handover.create`, args)).rejects.toThrow(
      'Access denied',
    );
    expect(manager.view().sessions).toEqual([]);
  });
});
