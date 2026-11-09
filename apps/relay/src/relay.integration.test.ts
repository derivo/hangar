import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus, MemoryPermissionStore } from '@hangar/bus';
import { createIdentity, RelayClient, remoteBayId, type Identity } from '@hangar/relay';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRelay, type Relay } from './relay';

const MARKER = 'klartext-marker-4711';
const OPERATOR = 'operator-token';
let relay: Relay | undefined;
const clients: RelayClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await relay?.close();
  relay = undefined;
});

/** A Hangar bus with the bay `dev.hangar.notes` and a relay client. */
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
  const read = vi.fn((args: unknown) => ({ note: MARKER, args }));
  bus.register('dev.hangar.notes', { name: 'note.read', sensitive: false, remote: true }, read);
  bus.register(
    'dev.hangar.notes',
    { name: 'note.delete', sensitive: false, remote: true },
    () => 'deleted',
  );
  const client = await RelayClient.connect({
    url: relay!.url,
    identity,
    bus,
    dataDir: join(dir, name),
    shared: () => shared,
  });
  ref.client = client;
  clients.push(client);
  return { identity, bus, client, read };
}

async function team(log: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-relay-it-'));
  relay = await startRelay({
    file: join(dir, 'relay.json'),
    operatorToken: OPERATOR,
    log: (l) => log.push(l),
  });
  const anna = await instance('anna', dir, ['dev.hangar.notes/note.read']);
  const ben = await instance('ben', dir, []);
  await anna.client.create('team', OPERATOR);
  const joined = new Promise<void>((resolve) =>
    anna.client.onJoined((workspace, identity) => {
      // A person compares the fingerprint over a second channel, then adds the instance.
      expect(identity).toEqual(ben.identity.document);
      void anna.client.addMember(workspace, identity).then(resolve);
    }),
  );
  await ben.client.join('team', await anna.client.invite('team'), anna.identity.fingerprint);
  await joined;
  await vi.waitFor(() => expect(ben.client.isMember('team', anna.identity.fingerprint)).toBe(true));
  return { dir, anna, ben, log };
}

const target = (owner: Identity, fn: string) =>
  `${remoteBayId(owner.document, 'dev.hangar.notes')}/${fn}`;

describe('two Hangar buses over a local relay (phase 15)', () => {
  it('calls a shared function of the other instance', async () => {
    const { anna, ben } = await team();
    const id = target(anna.identity, 'note.read');
    await vi.waitFor(() => expect(ben.bus.list().map((f) => f.id)).toContain(id));
    const caller = { kind: 'session' as const, bayId: 'dev.hangar.agents', sessionId: 's1' };
    expect(await ben.bus.call(caller, id, { n: 1 })).toEqual({ note: MARKER, args: { n: 1 } });
    expect(anna.read).toHaveBeenCalledWith(
      { n: 1 },
      {
        caller: {
          kind: 'remote',
          instance: ben.identity.fingerprint,
          workspace: 'team',
          bayId: 'dev.hangar.agents',
        },
      },
    );
  });

  it('a function that is not shared is neither announced nor callable', async () => {
    const { anna, ben } = await team();
    await vi.waitFor(() =>
      expect(ben.bus.list().map((f) => f.id)).toContain(target(anna.identity, 'note.read')),
    );
    expect(ben.bus.list().map((f) => f.id)).not.toContain(target(anna.identity, 'note.delete'));
    // Even a forged call by name is refused by anna's bus.
    const caller = {
      kind: 'remote' as const,
      instance: ben.identity.fingerprint,
      workspace: 'team',
      bayId: 'dev.x',
    };
    await expect(anna.bus.call(caller, 'dev.hangar.notes/note.delete', {})).rejects.toThrow(
      'Access denied',
    );
  });

  it('the relay sees no content in its log or its file', async () => {
    const log: string[] = [];
    const { anna, ben, dir } = await team(log);
    const id = target(anna.identity, 'note.read');
    await vi.waitFor(() => expect(ben.bus.list().map((f) => f.id)).toContain(id));
    await ben.bus.call({ kind: 'bay', bayId: 'dev.hangar.agents' }, id, { secret: MARKER });
    expect(log.join('\n')).not.toContain(MARKER);
    expect(log.join('\n')).not.toContain('note.read');
    expect(readFileSync(join(dir, 'relay.json'), 'utf8')).not.toContain(MARKER);
  });
});
