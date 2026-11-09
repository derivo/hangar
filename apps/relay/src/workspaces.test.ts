import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus, MemoryPermissionStore } from '@hangar/bus';
import { workspaceAction, Workspaces, type WorkspacesView } from '@hangar/host';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { startRelay, type Relay } from './relay';

const OPERATOR = 'operator-token';
let relay: Relay | undefined;
const closers: (() => void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) c();
  await relay?.close();
  relay = undefined;
});

async function startOn(file: string, port = 0) {
  relay = await startRelay({ file, operatorToken: OPERATOR, port });
  return relay.url;
}

/** A Hangar's workspaces in `dir`; `reverse` stands in for safeStorage. */
function hangar(dir: string, name: string, renewMs?: number) {
  const ref: { w?: Workspaces } = {};
  const bus = new Bus({
    permissions: new MemoryPermissionStore(),
    prompter: { ask: async () => 'allow' },
    remote: {
      isMember: (w, i) => ref.w!.isMember(w, i),
      isShared: (w, t) => ref.w!.isShared(w, t),
    },
  });
  bus.register(
    'dev.hangar.notes',
    { name: 'note.read', sensitive: false, remote: true },
    () => 'ok',
  );
  const changes = vi.fn();
  const reverse = (s: string) => [...s].reverse().join('');
  const w = new Workspaces({
    dir,
    name,
    bus,
    protect: { encrypt: reverse, decrypt: reverse },
    onChange: changes,
    retryMs: 100,
    ...(renewMs && { renewMs }),
  });
  ref.w = w;
  closers.push(() => w.close());
  return { w, bus, changes };
}

/**
 * A relay stand-in that answers the handshake only after `delayMs` and then stays silent;
 * with `fail` it closes the connection instead.
 */
async function slowRelay(delayMs: number, fail = false): Promise<string> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  closers.push(() => server.close());
  server.on('connection', (ws) =>
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as { type: string };
      if (m.type === 'hello')
        setTimeout(
          () =>
            fail
              ? ws.close()
              : ws.send(JSON.stringify({ type: 'challenge', version: 1, nonce: 'AAAA' })),
          delayMs,
        );
      if (m.type === 'prove') ws.send(JSON.stringify({ type: 'ready', workspaces: [] }));
    }),
  );
  await new Promise((r) => server.once('listening', r));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const storedVersion = (dir: string) =>
  (
    JSON.parse(readFileSync(join(dir, 'workspaces.json'), 'utf8')) as {
      workspaces: { list: { version: number } }[];
    }
  ).workspaces[0]!.list.version;

const names = (v: WorkspacesView, ws: string) =>
  v.workspaces.find((x) => x.name === ws)?.members.map((m) => m.name);

describe('Workspaces (host)', () => {
  it('runs the actions of the settings page by name, for the app and the local server (ADR 0036)', async () => {
    const { w, bus } = hangar(mkdtempSync(join(tmpdir(), 'hangar-ws-')), 'mac');
    const spec = { name: 'note.list', sensitive: false, remote: true, description: 'Lists notes' };
    bus.register('dev.hangar.notes', spec, () => []);
    const view = (await workspaceAction(w, bus, 'view', [])) as WorkspacesView & {
      functions: unknown[];
    };
    expect(view).toMatchObject({ status: 'off', name: 'mac' });
    expect(view.functions).toEqual([
      { id: 'dev.hangar.notes/note.read' },
      { id: 'dev.hangar.notes/note.list', description: 'Lists notes' },
    ]);
    await expect(workspaceAction(w, bus, 'connect', ['http://x'])).rejects.toThrow(
      'Invalid relay address',
    );
    await expect(workspaceAction(w, bus, 'invite', ['team'])).rejects.toThrow(
      'Not connected to a relay',
    );
    await expect(workspaceAction(w, bus, 'explode', [])).rejects.toThrow(
      'Unknown workspace action: explode',
    );
    // A share without on/off must not switch it off (Codex 5).
    w.setShared('team', 'dev.hangar.notes/note.read', true);
    for (const args of [['team', 'dev.hangar.notes/note.read'], ['team', 'x', 'yes'], ['team']])
      await expect(workspaceAction(w, bus, 'share', args), JSON.stringify(args)).rejects.toThrow(
        'Invalid arguments for share',
      );
    await expect(workspaceAction(w, bus, 'invite', [true])).rejects.toThrow(
      'Invalid arguments for invite',
    );
    expect(w.isShared('team', 'dev.hangar.notes/note.read')).toBe(true);
    // Each action reaches its method with its arguments.
    const methods = ['create', 'join', 'accept', 'reject', 'remove', 'invite'] as const;
    for (const m of methods) vi.spyOn(w, m).mockResolvedValue(undefined as never);
    await workspaceAction(w, bus, 'create', ['team', OPERATOR]);
    await workspaceAction(w, bus, 'invite', ['team']);
    await workspaceAction(w, bus, 'join', ['team', 'tok', 'fp']);
    for (const m of ['accept', 'reject', 'remove'] as const)
      await workspaceAction(w, bus, m, ['team', 'fp']);
    expect(w.create).toHaveBeenCalledWith('team', OPERATOR);
    expect(w.invite).toHaveBeenCalledWith('team');
    expect(w.join).toHaveBeenCalledWith('team', 'tok', 'fp');
    for (const m of ['accept', 'reject', 'remove'] as const)
      expect(w[m]).toHaveBeenCalledWith('team', 'fp');
    await workspaceAction(w, bus, 'share', ['team', 'dev.hangar.notes/note.read', false]);
    expect(w.isShared('team', 'dev.hangar.notes/note.read')).toBe(false);
  });

  it('connects, founds a workspace, invites, both confirm, and states flow', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hangar-ws-'));
    const url = await startOn(join(root, 'relay.json'));
    const anna = hangar(join(root, 'anna'), 'anna');
    const ben = hangar(join(root, 'ben'), 'ben');
    expect(anna.w.view()).toMatchObject({ status: 'off', workspaces: [] });
    await anna.w.connect(url);
    await ben.w.connect(url);
    expect(anna.w.view()).toMatchObject({ relay: url, status: 'connected', name: 'anna' });
    await anna.w.create('team', OPERATOR);
    const invite = await anna.w.invite('team');
    expect(invite).toMatchObject({ workspace: 'team', fingerprint: anna.w.view().fingerprint });
    expect(await ben.w.join('team', invite.token, invite.fingerprint)).toBe('waiting');
    // Anna sees Ben asking and confirms his fingerprint.
    await vi.waitFor(() =>
      expect(anna.w.view().workspaces[0]!.joined).toEqual([
        { name: 'ben', fingerprint: ben.w.view().fingerprint, inviter: invite.fingerprint },
      ]),
    );
    await anna.w.accept('team', ben.w.view().fingerprint);
    await vi.waitFor(() => expect(names(ben.w.view(), 'team')).toEqual(['anna', 'ben']));
    expect(anna.w.view().workspaces[0]!.joined).toEqual([]);
    expect(anna.changes).toHaveBeenCalled();

    const seen = vi.fn();
    const benBay = ben.w.forBay('dev.hangar.agents');
    benBay.onState(seen);
    anna.w.forBay('dev.hangar.agents').publish({ n: 1 });
    await vi.waitFor(() =>
      expect(benBay.states()).toEqual([
        { workspace: 'team', instance: anna.w.view().fingerprint, name: 'anna', state: { n: 1 } },
      ]),
    );
    expect(seen).toHaveBeenCalled();
    // Another bay's state is not handed to this one.
    expect(ben.w.states('dev.hangar.notes')).toEqual([]);

    // Share list: Ben may call Anna's function once she shares it.
    expect(anna.w.isShared('team', 'dev.hangar.notes/note.read')).toBe(false);
    anna.w.setShared('team', 'dev.hangar.notes/note.read', true);
    expect(anna.w.view().workspaces[0]!.shared).toEqual(['dev.hangar.notes/note.read']);
    await vi.waitFor(() =>
      expect(
        ben.bus.list().some((f) => f.id.endsWith('/note.read') && f.bayId.startsWith('remote.')),
      ).toBe(true),
    );
    anna.w.setShared('team', 'dev.hangar.notes/note.read', false);
    expect(anna.w.view().workspaces[0]!.shared).toEqual([]);

    // The private keys are stored protected, never in the clear.
    const stored = readFileSync(join(root, 'anna', 'relay-identity.json'), 'utf8');
    const { keys } = JSON.parse(stored) as { keys: string };
    expect(() => JSON.parse(keys) as unknown).toThrow();

    await anna.w.remove('team', ben.w.view().fingerprint);
    await vi.waitFor(() => expect(names(anna.w.view(), 'team')).toEqual(['anna']));
  });

  it('a refused instance is revoked; a join waits for the inviter and survives a restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hangar-ws-'));
    const url = await startOn(join(root, 'relay.json'));
    const anna = hangar(join(root, 'anna'), 'anna');
    const ben = hangar(join(root, 'ben'), 'ben');
    const eve = hangar(join(root, 'eve'), 'eve');
    for (const h of [anna, ben, eve]) await h.w.connect(url);
    await anna.w.create('team', OPERATOR);
    // Eve joins, Anna refuses her.
    await eve.w.join('team', (await anna.w.invite('team')).token, anna.w.view().fingerprint);
    await vi.waitFor(() => expect(anna.w.view().workspaces[0]!.joined).toHaveLength(1));
    await anna.w.reject('team', eve.w.view().fingerprint);
    expect(anna.w.view().workspaces[0]!.joined).toEqual([]);
    // Ben confirmed a fingerprint that did not sign the list: he waits, also after a restart.
    const invite = await anna.w.invite('team');
    expect(await ben.w.join('team', invite.token, 'a'.repeat(64))).toBe('waiting');
    expect(ben.w.view().workspaces).toEqual([
      { name: 'team', waiting: true, members: [], joined: [], shared: [] },
    ]);
    ben.w.close();
    const again = hangar(join(root, 'ben'), 'ben');
    await again.w.start();
    expect(again.w.view()).toMatchObject({
      status: 'connected',
      fingerprint: ben.w.view().fingerprint,
    });
    expect(again.w.view().workspaces[0]).toMatchObject({ name: 'team', waiting: true });
  });

  it('a member joining again is trusted at once; connecting again replaces the connection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hangar-ws-'));
    const url = await startOn(join(root, 'relay.json'));
    const fresh = hangar(join(root, 'fresh'), 'fresh');
    await fresh.w.start();
    expect(fresh.w.view().status).toBe('off');
    expect(fresh.w.states('dev.hangar.agents')).toEqual([]);

    const anna = hangar(join(root, 'anna'), 'anna');
    const ben = hangar(join(root, 'ben'), 'ben');
    for (const h of [anna, ben]) await h.w.connect(url);
    await anna.w.create('team', OPERATOR);
    const annaPrint = anna.w.view().fingerprint;
    const benPrint = ben.w.view().fingerprint;
    await ben.w.join('team', (await anna.w.invite('team')).token, annaPrint);
    await vi.waitFor(() => expect(anna.w.view().workspaces[0]!.joined).toHaveLength(1));
    await expect(anna.w.accept('team', 'f'.repeat(64))).rejects.toThrow('No such join request');
    await anna.w.accept('team', benPrint);
    await vi.waitFor(() => expect(names(ben.w.view(), 'team')).toEqual(['anna', 'ben']));

    // Ben is listed already: no join request for Anna, no waiting for Ben.
    expect(await ben.w.join('team', (await anna.w.invite('team')).token, annaPrint)).toBe(
      'trusted',
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(anna.w.view().workspaces[0]!.joined).toEqual([]);

    // The replaced connection closing does not count as a lost relay.
    await anna.w.connect(url);
    await new Promise((r) => setTimeout(r, 200));
    expect(anna.w.view()).toMatchObject({ status: 'connected' });
    expect(anna.w.view().error).toBeUndefined();
  });

  it('a confirmation that arrives while connecting is kept and ends the waiting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hangar-ws-'));
    const url = await startOn(join(root, 'relay.json'));
    const anna = hangar(join(root, 'anna'), 'anna');
    const ben = hangar(join(root, 'ben'), 'ben');
    for (const h of [anna, ben]) await h.w.connect(url);
    await anna.w.create('team', OPERATOR);
    const annaPrint = anna.w.view().fingerprint;
    const benPrint = ben.w.view().fingerprint;
    await ben.w.join('team', (await anna.w.invite('team')).token, annaPrint);
    await vi.waitFor(() => expect(anna.w.view().workspaces[0]!.joined).toHaveLength(1));
    // Ben is away while Anna adds him: he gets the list in the handshake of his next start.
    ben.w.close();
    await anna.w.accept('team', benPrint);
    const again = hangar(join(root, 'ben'), 'ben');
    await again.w.start();
    expect(again.w.view().workspaces).toEqual([
      expect.objectContaining({ name: 'team', waiting: false }),
    ]);
    expect(names(again.w.view(), 'team')).toEqual(['anna', 'ben']);
    expect(storedVersion(join(root, 'ben'))).toBe(2);
  });

  it('only the inviter adds an instance; another member sees the request without accepting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hangar-ws-'));
    const url = await startOn(join(root, 'relay.json'));
    const anna = hangar(join(root, 'anna'), 'anna');
    const cara = hangar(join(root, 'cara'), 'cara');
    const ben = hangar(join(root, 'ben'), 'ben');
    for (const h of [anna, cara, ben]) await h.w.connect(url);
    await anna.w.create('team', OPERATOR);
    const annaPrint = anna.w.view().fingerprint;
    await cara.w.join('team', (await anna.w.invite('team')).token, annaPrint);
    await vi.waitFor(() => expect(anna.w.view().workspaces[0]!.joined).toHaveLength(1));
    await anna.w.accept('team', cara.w.view().fingerprint);
    await vi.waitFor(() => expect(names(cara.w.view(), 'team')).toEqual(['anna', 'cara']));

    const benPrint = ben.w.view().fingerprint;
    await ben.w.join('team', (await anna.w.invite('team')).token, annaPrint);
    const request = { name: 'ben', fingerprint: benPrint, inviter: annaPrint };
    await vi.waitFor(() => expect(cara.w.view().workspaces[0]!.joined).toEqual([request]));
    await expect(cara.w.accept('team', benPrint)).rejects.toThrow(
      'Only the inviter can add this instance',
    );
    await vi.waitFor(() => expect(anna.w.view().workspaces[0]!.joined).toEqual([request]));
    await anna.w.accept('team', benPrint);
    await vi.waitFor(() => expect(names(ben.w.view(), 'team')).toEqual(['anna', 'cara', 'ben']));
  });

  it('renews the member list on its own, so a quiet workspace does not expire', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hangar-ws-'));
    const url = await startOn(join(root, 'relay.json'));
    const anna = hangar(join(root, 'anna'), 'anna', 150);
    const ben = hangar(join(root, 'ben'), 'ben', 150);
    for (const h of [anna, ben]) await h.w.connect(url);
    await anna.w.create('team', OPERATOR);
    await ben.w.join('team', (await anna.w.invite('team')).token, anna.w.view().fingerprint);
    await vi.waitFor(() => expect(anna.w.view().workspaces[0]!.joined).toHaveLength(1));
    await anna.w.accept('team', ben.w.view().fingerprint);
    await vi.waitFor(() => expect(names(ben.w.view(), 'team')).toEqual(['anna', 'ben']));
    const before = storedVersion(join(root, 'ben'));
    await vi.waitFor(() => expect(storedVersion(join(root, 'ben'))).toBeGreaterThan(before + 1), {
      timeout: 3000,
    });
    expect(names(ben.w.view(), 'team')).toEqual(['anna', 'ben']);
  });

  it('keeps only the newest of two overlapping connection attempts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hangar-ws-'));
    const url = await startOn(join(root, 'relay.json'));
    const anna = hangar(join(root, 'anna'), 'anna');
    const slow = anna.w.connect(await slowRelay(300));
    await anna.w.connect(url);
    await slow;
    expect(anna.w.view()).toMatchObject({ relay: url, status: 'connected' });
    // Requests go to the newer relay, not to the slow one that answered last.
    await anna.w.create('team', OPERATOR);
    expect(readFileSync(join(root, 'relay.json'), 'utf8')).toContain('"team"');

    // An older attempt that fails late changes nothing either.
    const failing = anna.w.connect(await slowRelay(200, true));
    await anna.w.connect(url);
    await expect(failing).rejects.toThrow('Relay connection closed');
    expect(anna.w.view()).toMatchObject({ relay: url, status: 'connected' });
    expect(anna.w.view().error).toBeUndefined();
    // Closed: a failed attempt plans no retry.
    anna.w.close();
    await expect(anna.w.connect('ws://127.0.0.1:9')).rejects.toThrow('Relay not reachable');
  });

  it('a workspace named like an object property keeps its own share list', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hangar-ws-'));
    const url = await startOn(join(root, 'relay.json'));
    const anna = hangar(join(root, 'anna'), 'anna');
    await anna.w.connect(url);
    await anna.w.create('constructor', OPERATOR);
    expect(anna.w.view().workspaces[0]!.shared).toEqual([]);
    expect(anna.w.isShared('constructor', 'dev.hangar.notes/note.read')).toBe(false);
    anna.w.setShared('constructor', 'dev.hangar.notes/note.read', true);
    expect(anna.w.view().workspaces[0]!.shared).toEqual(['dev.hangar.notes/note.read']);
  });

  it('reconnects after the relay comes back, and reports a relay it cannot reach', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hangar-ws-'));
    const file = join(root, 'relay.json');
    const url = await startOn(file);
    const port = Number(new URL(url).port);
    const anna = hangar(join(root, 'anna'), 'anna');
    await anna.w.connect(url);
    await anna.w.create('team', OPERATOR);
    await relay!.close();
    await vi.waitFor(() => expect(anna.w.view().status).not.toBe('connected'));
    // Down for several attempts: a failed attempt plans the next one.
    await new Promise((r) => setTimeout(r, 400));
    await startOn(file, port);
    await vi.waitFor(() => expect(anna.w.view().status).toBe('connected'), { timeout: 5000 });
    expect(anna.w.view().workspaces.map((w) => w.name)).toEqual(['team']);

    const lone = hangar(join(root, 'lone'), 'lone');
    for (const bad of ['http://relay.example', 'ws://relay.example', 'kein url'])
      await expect(lone.w.connect(bad)).rejects.toThrow('Invalid relay address');
    expect(lone.w.view()).toMatchObject({ status: 'off' });
    expect(lone.w.view().relay).toBeUndefined();
    await expect(lone.w.connect('ws://127.0.0.1:9')).rejects.toThrow('Relay not reachable');
    expect(lone.w.view()).toMatchObject({ status: 'error', error: 'Relay not reachable' });
    // Without `retryMs` the next attempt waits five seconds; closing ends the wait.
    const plain = new Workspaces({
      dir: join(root, 'plain'),
      name: 'plain',
      bus: lone.bus,
      protect: { encrypt: (t) => t, decrypt: (t) => t },
      onChange: () => {},
    });
    closers.push(() => plain.close());
    await expect(plain.connect('ws://127.0.0.1:9')).rejects.toThrow('Relay not reachable');
    expect(plain.view()).toMatchObject({ status: 'error' });
    await expect(lone.w.create('x', OPERATOR)).rejects.toThrow('Not connected to a relay');
    expect(lone.w.isMember('team', 'x')).toBe(false);
    lone.w.publish('dev.hangar.agents', {});
  });
});
