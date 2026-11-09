import { sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus, MemoryPermissionStore } from '@hangar/bus';
import {
  createIdentity,
  open,
  RelayClient,
  remoteBayId,
  seal,
  signedChallenge,
  Workspace,
  type FromRelay,
  type Identity,
  type StoredWorkspace,
} from '@hangar/relay';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { startRelay, type Relay } from './relay';

const OPERATOR = 'operator-token';
let relay: Relay | undefined;
const closers: (() => void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) c();
  await relay?.close();
  relay = undefined;
});

async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-relay-client-'));
  relay = await startRelay({ file: join(dir, 'relay.json'), operatorToken: OPERATOR });
  return dir;
}

async function instance(
  identity: Identity,
  dir: string,
  opts: {
    shared?: string[] | ((workspace: string) => string[]);
    timeout?: number;
    handler?: () => unknown;
  } = {},
) {
  const ref: { client?: RelayClient } = {};
  const bus = new Bus({
    permissions: new MemoryPermissionStore(),
    prompter: { ask: async () => 'allow' },
    remote: {
      isMember: (w, i) => ref.client!.isMember(w, i),
      isShared: (w, t) => ref.client!.isShared(w, t),
    },
  });
  bus.register(
    'dev.hangar.notes',
    { name: 'note.read', sensitive: false, remote: true },
    opts.handler ?? (() => 'ok'),
  );
  const client = await RelayClient.connect({
    url: relay!.url,
    identity,
    bus,
    dataDir: join(dir, identity.document.name),
    shared: (w) =>
      typeof opts.shared === 'function'
        ? opts.shared(w)
        : (opts.shared ?? ['dev.hangar.notes/note.read']),
    ...(opts.timeout && { callTimeoutMs: opts.timeout }),
  });
  ref.client = client;
  closers.push(() => client.close());
  return { bus, client };
}

/** Anna founds `team`, Ben joins and Anna adds him. */
async function pair(opts: Parameters<typeof instance>[2] = {}) {
  const dir = await start();
  const anna = createIdentity('Anna Laptop');
  const ben = createIdentity('ben');
  const a = await instance(anna, dir, opts);
  const b = await instance(ben, dir, opts);
  // Repeated after a reconnect; a request cut off by the end of a test is no failure.
  a.client.onJoined((w, doc) => void a.client.addMember(w, doc).catch(() => {}));
  await a.client.create('team', OPERATOR);
  await b.client.join('team', await a.client.invite('team'), anna.fingerprint);
  await vi.waitFor(() => expect(b.client.isMember('team', anna.fingerprint)).toBe(true));
  const id = `${remoteBayId(anna.document, 'dev.hangar.notes')}/note.read`;
  await vi.waitFor(() => expect(b.bus.list().map((f) => f.id)).toContain(id));
  return { dir, anna, ben, a, b, id };
}

/** Anna speaks to the relay by hand: founds `team`, invites, and seals what a test wants. */
async function handDriven(anna: Identity) {
  const ws = new WebSocket(relay!.url);
  closers.push(() => ws.terminate());
  const inbox: FromRelay[] = [];
  ws.on('message', (d) => inbox.push(JSON.parse(String(d)) as FromRelay));
  await new Promise((r) => ws.once('open', r));
  const wait = async <T extends FromRelay['type']>(type: T) => {
    await vi.waitFor(() => expect(inbox.some((m) => m.type === type)).toBe(true));
    const i = inbox.findIndex((m) => m.type === type);
    return inbox.splice(i, 1)[0] as Extract<FromRelay, { type: T }>;
  };
  const send = (m: object) => ws.send(JSON.stringify(m));
  send({ type: 'hello', versions: [1], identity: anna.document });
  const { nonce } = await wait('challenge');
  send({
    type: 'prove',
    sig: sign(null, signedChallenge(nonce, new URL(relay!.url).origin), anna.signKey).toString(
      'base64url',
    ),
  });
  await wait('ready');
  const team = Workspace.found('team', anna);
  send({ type: 'create', id: 1, workspace: 'team', token: OPERATOR, list: team.list });
  await wait('result');
  send({ type: 'invite', id: 2, workspace: 'team' });
  const { value: token } = (await wait('result')) as { value: string };
  let seq = 0;
  const to = (peer: Identity, body: unknown, workspace = 'team') =>
    send({
      type: 'send',
      envelope: seal(
        anna,
        peer.document,
        { workspace, epoch: 'h'.repeat(16), seq: ++seq, ts: Date.now() },
        JSON.stringify(body),
      ),
    });
  return { team, token, send, wait, to, inbox };
}

const agent = { kind: 'bay' as const, bayId: 'dev.hangar.agents' };

describe('RelayClient', () => {
  it('names remote bays after the instance and its fingerprint, so a new key gets new grants', () => {
    const doc = createIdentity('Anna Laptop!').document;
    expect(remoteBayId(doc, 'dev.hangar.notes')).toMatch(
      /^remote\.anna-laptop-[0-9a-f]{64}\.dev\.hangar\.notes$/,
    );
    expect(remoteBayId(createIdentity('!!!').document, 'dev.x')).toMatch(
      /^remote\.instance-[0-9a-f]{64}\.dev\.x$/,
    );
    expect(remoteBayId(createIdentity('Anna Laptop!').document, 'dev.hangar.notes')).not.toBe(
      remoteBayId(doc, 'dev.hangar.notes'),
    );
  });

  it('trusts no list after joining until the confirmed instance signed one', async () => {
    const { dir, a } = await pair();
    const carl = await instance(createIdentity('carl'), dir);
    expect(await carl.client.join('team', await a.client.invite('team'), 'f'.repeat(64))).toBe(
      'waiting',
    );
    // Anna adds Carl (pair() does that on `joined`), but Carl confirmed someone else.
    await vi.waitFor(() => expect(a.client.workspace('team')?.list.members).toHaveLength(3));
    await new Promise((r) => setTimeout(r, 100));
    expect(carl.client.workspace('team')).toBeUndefined();
  });

  it('keeps waiting while the list of the inviter does not hold this instance yet', async () => {
    const dir = await start();
    const anna = createIdentity('anna');
    const ben = createIdentity('ben');
    const a = await instance(anna, dir);
    const b = await instance(ben, dir);
    await a.client.create('team', OPERATOR);
    // The relay answers the join with Anna's current list: signed by her, without Ben.
    expect(await b.client.join('team', await a.client.invite('team'), anna.fingerprint)).toBe(
      'waiting',
    );
    expect(b.client.workspace('team')).toBeUndefined();
    await a.client.addMember('team', ben.document);
    await vi.waitFor(() => expect(b.client.workspace('team')?.list.members).toHaveLength(2));
  });

  it('an invitation still works when another member signed the latest list', async () => {
    const { dir, a, b, anna } = await pair();
    await vi.waitFor(() => expect(b.client.workspace('team')?.list.members).toHaveLength(2));
    await b.client.renew('team');
    await vi.waitFor(() => expect(a.client.workspace('team')?.list.version).toBe(3));
    const carlId = createIdentity('carl');
    const carl = await instance(carlId, dir);
    expect(await carl.client.join('team', await a.client.invite('team'), anna.fingerprint)).toBe(
      'waiting',
    );
    // Anna adds Carl (pair() does that on `joined`): her list makes Carl trust the workspace.
    await vi.waitFor(() => expect(carl.client.isMember('team', carlId.fingerprint)).toBe(true));
  });

  it('reports relay errors of requests', async () => {
    const { a } = await pair();
    await expect(a.client.create('team', OPERATOR)).rejects.toThrow('Workspace exists');
    await expect(a.client.addMember('nope', createIdentity('x').document)).rejects.toThrow(
      'Unknown workspace: nope',
    );
  });

  it('a remote error comes back as the error of the call', async () => {
    const { b, id } = await pair({
      handler: () => {
        throw new Error('note missing');
      },
    });
    await expect(b.bus.call(agent, id, {})).rejects.toThrow('note missing');
  });

  it('gives up after the call timeout and limits open calls per instance', async () => {
    const { b, id } = await pair({ timeout: 300, handler: () => new Promise(() => {}) });
    const calls = Array.from({ length: 10 }, () => b.bus.call(agent, id, {}));
    await expect(b.bus.call(agent, id, {})).rejects.toThrow('Too many open calls to this instance');
    for (const c of calls) await expect(c).rejects.toThrow('The call timed out');
  });

  it('fails at once when the other instance is not connected', async () => {
    const { a, b, id } = await pair();
    a.client.close();
    // The relay learns of the closed socket a moment later.
    await new Promise((r) => setTimeout(r, 200));
    await expect(b.bus.call(agent, id, {})).rejects.toThrow('The instance is not connected');
  });

  it('rejects open calls and unregisters remote functions when the relay connection ends', async () => {
    const { b, id } = await pair({ handler: () => new Promise(() => {}) });
    const call = b.bus.call(agent, id, {});
    await new Promise((r) => setTimeout(r, 50));
    b.client.close();
    await expect(call).rejects.toThrow('Relay connection closed');
    expect(b.bus.list().map((f) => f.id)).not.toContain(id);
  });

  it('refuses a message over 1 MB before it leaves', async () => {
    const { b, id } = await pair();
    await expect(b.bus.call(agent, id, { big: 'x'.repeat(1024 * 1024) })).rejects.toThrow(
      'Message too large',
    );
  });

  it('removing a member drops its functions and refuses its calls', async () => {
    const { a, b, ben, id } = await pair();
    await a.client.removeMember('team', ben.fingerprint);
    await vi.waitFor(() => expect(a.client.isMember('team', ben.fingerprint)).toBe(false));
    await expect(b.bus.call(agent, id, {})).rejects.toThrow(
      'The relay refused the message: no member of the workspace',
    );
  });

  it('takes a newer member list from another member even if the relay never sends it', async () => {
    const dir = await start();
    const anna = createIdentity('anna');
    const carl = createIdentity('carl');
    const hand = await handDriven(anna);
    const c = await instance(carl, dir);
    await c.client.join('team', hand.token, anna.fingerprint);
    const v2 = hand.team.next(anna, { members: [anna.document, carl.document] });
    hand.send({ type: 'list', id: 3, list: v2 });
    await vi.waitFor(() => expect(c.client.workspace('team')?.list.version).toBe(2));
    // v3 only inside an announce: the relay stores and forwards no list.
    const v3 = hand.team.next(anna, {});
    hand.to(carl, { t: 'announce', functions: [], list: v3 });
    await vi.waitFor(() => expect(c.client.workspace('team')?.list.version).toBe(3));
  });

  it('drops what does not belong and answers bad calls with an error, without stopping', async () => {
    const dir = await start();
    const anna = createIdentity('anna');
    const carl = createIdentity('carl');
    const eve = createIdentity('eve');
    const hand = await handDriven(anna);
    const c = await instance(carl, dir);
    await c.client.join('team', hand.token, anna.fingerprint);
    const v2 = hand.team.next(anna, { members: [anna.document, carl.document] });
    hand.send({ type: 'list', id: 3, list: v2 });
    await vi.waitFor(() => expect(c.client.workspace('team')?.list.version).toBe(2));
    // Carl announces again whenever the list changes: wait for the kind of reply asked for.
    const reply = async (t: string) => {
      for (;;) {
        const { envelope } = await hand.wait('deliver');
        const body = JSON.parse(open(anna, carl.document, envelope)) as Record<string, unknown>;
        if (body.t === t) return body;
      }
    };
    // Unknown workspace, forged sender, unknown call id: dropped.
    hand.to(carl, { t: 'announce', functions: [] }, 'other');
    hand.send({
      type: 'send',
      envelope: seal(
        eve,
        carl.document,
        { workspace: 'team', epoch: 'e'.repeat(16), seq: 1, ts: Date.now() },
        '{}',
      ),
    });
    hand.to(carl, { t: 'result', id: 'unknown', ok: true, value: 1 });
    // A newer list nobody of the members signed is ignored.
    hand.to(carl, {
      t: 'announce',
      functions: [],
      list: { ...Workspace.found('team', eve).list, version: 9 },
    });
    // Unknown kinds and announces without a list change nothing; nor does an unknown workspace.
    hand.to(carl, { t: 'nonsense' });
    hand.to(carl, { t: 'announce', functions: [] });
    c.client.announceAll('nope');
    // Functions that are no list or no valid entries register nothing.
    hand.to(carl, { t: 'announce', functions: 'all', list: v2 });
    expect(await reply('announce')).toMatchObject({ t: 'announce' });
    hand.to(carl, {
      t: 'announce',
      list: v2,
      functions: [
        { bayId: '../x', spec: { name: 'a' } },
        { bayId: 'dev.x', spec: { name: 'a/b' } },
        {
          bayId: 'dev.x',
          spec: { name: 'ok', description: 'Reads', inputSchema: { type: 'object' } },
        },
      ],
    });
    const id = `${remoteBayId(anna.document, 'dev.x')}/ok`;
    await vi.waitFor(() =>
      expect(c.bus.list().map((f) => f.id)).toEqual(expect.arrayContaining([id])),
    );
    expect(c.bus.list().find((f) => f.id === id)?.spec).toEqual({
      name: 'ok',
      sensitive: false,
      description: 'Reads',
      inputSchema: { type: 'object' },
    });
    expect(c.bus.list().filter((f) => f.id.startsWith('remote.'))).toHaveLength(1);
    // A call with an invalid caller bay is answered with an error; a resent id not at all.
    hand.to(carl, {
      t: 'call',
      id: 'c1',
      bayId: 'Not A Bay',
      target: 'dev.hangar.notes/note.read',
      args: {},
    });
    expect(await reply('result')).toEqual({
      t: 'result',
      id: 'c1',
      ok: false,
      error: 'Invalid call',
    });
    hand.to(carl, {
      t: 'call',
      id: 'c1',
      bayId: 'dev.x',
      target: 'dev.hangar.notes/note.read',
      args: {},
    });
    hand.to(carl, {
      t: 'call',
      id: 'c2',
      bayId: 'dev.x',
      target: 'dev.hangar.notes/note.read',
      args: {},
    });
    expect(await reply('result')).toEqual({ t: 'result', id: 'c2', ok: true, value: 'ok' });
  });

  it('starts again with the stored workspaces and their vouched times', async () => {
    const { dir, b, anna, ben } = await pair();
    let stored: StoredWorkspace | undefined;
    b.client.onChange((s) => (stored = s));
    await b.client.renew('team').catch(() => {});
    await vi.waitFor(() => expect(stored?.list.version).toBeGreaterThan(1));
    b.client.close();
    const again = await RelayClient.connect(
      {
        url: relay!.url,
        identity: ben,
        bus: new Bus({ prompter: { ask: async () => 'deny' } }),
        dataDir: join(dir, 'again'),
        shared: () => [],
      },
      [stored!],
    );
    closers.push(() => again.close());
    expect(again.isMember('team', anna.fingerprint)).toBe(true);
    expect(again.workspace('team')!.vouchedTimes).toEqual(stored!.vouched);
  });

  it('survives a relay that sends malformed messages', async () => {
    const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    closers.push(() => fake.close());
    const junk = [
      { type: 'deliver' },
      { type: 'deliver', envelope: { header: 5 } },
      { type: 'list', list: null },
      { type: 'list', list: { workspace: 'team', version: 'x' } },
      { type: 'result', id: 99, ok: true },
      { type: 'undeliverable' },
      { type: 'joined' },
      { type: 'nonsense' },
      // After ready an error answers one message (e.g. `Not allowed`), it ends nothing.
      { type: 'error', message: 'Not allowed' },
    ];
    let server: WebSocket | undefined;
    fake.on('connection', (ws) => (server = ws));
    fake.on('connection', (ws) =>
      ws.on('message', (d) => {
        const m = JSON.parse(String(d)) as { type: string };
        if (m.type === 'hello')
          ws.send(JSON.stringify({ type: 'challenge', version: 1, nonce: 'AAAA' }));
        if (m.type === 'prove') {
          ws.send(JSON.stringify({ type: 'ready', workspaces: [] }));
          for (const j of junk) ws.send(JSON.stringify(j));
        }
      }),
    );
    await new Promise((r) => fake.once('listening', r));
    const { port } = fake.address() as AddressInfo;
    const options = {
      url: `ws://127.0.0.1:${port}`,
      identity: createIdentity('x'),
      bus: new Bus({ prompter: { ask: async () => 'deny' as const } }),
      dataDir: tmpdir(),
      shared: () => [],
    };
    const client = await RelayClient.connect(options);
    closers.push(() => client.close());
    await new Promise((r) => setTimeout(r, 100));
    expect(server!.readyState).toBe(WebSocket.OPEN);
    // A join with a forged identity document never reaches the members.
    const joined = vi.fn();
    client.onJoined(joined);
    for (const identity of [null, { name: 'x' }, { ...createIdentity('y').document, name: 'z' }])
      server!.send(JSON.stringify({ type: 'joined', workspace: 'team', identity }));
    await new Promise((r) => setTimeout(r, 100));
    expect(joined).not.toHaveBeenCalled();
    // A relay without the inviter (older `relay.json`): the request comes without it.
    const doc = createIdentity('w').document;
    server!.send(JSON.stringify({ type: 'joined', workspace: 'team', identity: doc }));
    await vi.waitFor(() => expect(joined).toHaveBeenCalledWith('team', doc, undefined));
    // A ready of the wrong shape ends the connection attempt instead of throwing in a listener.
    fake.removeAllListeners('connection');
    fake.on('connection', (ws) =>
      ws.on('message', (d) => {
        const m = JSON.parse(String(d)) as { type: string };
        if (m.type === 'hello')
          ws.send(JSON.stringify({ type: 'challenge', version: 1, nonce: 'AAAA' }));
        if (m.type === 'prove') ws.send(JSON.stringify({ type: 'ready', workspaces: 5 }));
      }),
    );
    await expect(RelayClient.connect(options)).rejects.toThrow('Invalid message from the relay');
  });

  it('fails to connect to nothing, and to a server that speaks something else', async () => {
    await expect(
      RelayClient.connect({
        url: 'ws://127.0.0.1:9',
        identity: createIdentity('x'),
        bus: new Bus({ prompter: { ask: async () => 'deny' } }),
        dataDir: tmpdir(),
        shared: () => [],
      }),
    ).rejects.toThrow('Relay not reachable');
    const other = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    closers.push(() => other.close());
    other.on('connection', (ws) => ws.send('not json'));
    await new Promise((r) => other.once('listening', r));
    const { port } = other.address() as AddressInfo;
    await expect(
      RelayClient.connect({
        url: `ws://127.0.0.1:${port}`,
        identity: createIdentity('x'),
        bus: new Bus({ prompter: { ask: async () => 'deny' } }),
        dataDir: tmpdir(),
        shared: () => [],
      }),
    ).rejects.toThrow('Invalid message from the relay');
  });

  it('answers at most 10 calls of one instance at a time, also after its calls timed out', async () => {
    let running = 0;
    // The timeout also bounds the requests to the relay while pairing; 100 ms was too short for
    // the Windows runner, whose relay writes its state to disk slowly.
    const { b, id } = await pair({
      timeout: 1000,
      handler: () => {
        running++;
        return new Promise(() => {});
      },
    });
    const first = Array.from({ length: 10 }, () => b.bus.call(agent, id, {}));
    for (const c of first) await expect(c).rejects.toThrow('The call timed out');
    await expect(b.bus.call(agent, id, {})).rejects.toThrow(
      'Too many open calls from this instance',
    );
    expect(running).toBe(10);
  });

  it('publishes its own list changes one after another, so a renewal refuses no change', async () => {
    const { a, ben } = await pair();
    const version = a.client.workspace('team')!.list.version;
    await Promise.all([
      a.client.renew('team'),
      a.client.addMember('team', ben.document),
      a.client.renew('team'),
    ]);
    expect(a.client.workspace('team')!.list.version).toBe(version + 3);
    expect(a.client.isMember('team', ben.fingerprint)).toBe(true);
  });

  it('a function shared in two workspaces stays when one of them stops sharing it', async () => {
    const shared: Record<string, string[]> = {};
    const { a, b, anna, ben, id } = await pair({
      shared: (w) => shared[w] ?? ['dev.hangar.notes/note.read'],
    });
    await a.client.create('two', OPERATOR);
    expect(await b.client.join('two', await a.client.invite('two'), anna.fingerprint)).toBe(
      'waiting',
    );
    await vi.waitFor(() => expect(a.client.isMember('two', ben.fingerprint)).toBe(true));
    await vi.waitFor(() => expect(b.client.isMember('two', anna.fingerprint)).toBe(true));
    shared.team = [];
    a.client.announceAll('team');
    await new Promise((r) => setTimeout(r, 200));
    expect(b.bus.list().map((f) => f.id)).toContain(id);
    await expect(b.bus.call(agent, id, {})).resolves.toBe('ok');
  });

  it('a relay that closes or stays silent does not leave connect or requests hanging', async () => {
    const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    closers.push(() => fake.close());
    await new Promise((r) => fake.once('listening', r));
    const { port } = fake.address() as AddressInfo;
    const options = {
      url: `ws://127.0.0.1:${port}`,
      identity: createIdentity('x'),
      bus: new Bus({ prompter: { ask: async () => 'deny' as const } }),
      dataDir: tmpdir(),
      shared: () => [],
      callTimeoutMs: 200,
    };
    fake.on('connection', (ws) => ws.close());
    await expect(RelayClient.connect(options)).rejects.toThrow('Relay connection closed');
    fake.removeAllListeners('connection');
    await expect(RelayClient.connect(options)).rejects.toThrow('The relay did not answer');
    // Ready, then no answer to a request.
    fake.on('connection', (ws) =>
      ws.on('message', (d) => {
        const m = JSON.parse(String(d)) as { type: string };
        if (m.type === 'hello')
          ws.send(JSON.stringify({ type: 'challenge', version: 1, nonce: 'AAAA' }));
        if (m.type === 'prove') ws.send(JSON.stringify({ type: 'ready', workspaces: [] }));
      }),
    );
    const client = await RelayClient.connect(options);
    closers.push(() => client.close());
    await expect(client.invite('team')).rejects.toThrow('The relay did not answer');
  });

  it('refuses messages from the relay over the size limit, before and after ready', async () => {
    const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    closers.push(() => fake.close());
    await new Promise((r) => fake.once('listening', r));
    const { port } = fake.address() as AddressInfo;
    const huge = 'x'.repeat(3 * 1024 * 1024);
    let afterReady = false;
    fake.on('connection', (ws) =>
      ws.on('message', (d) => {
        const m = JSON.parse(String(d)) as { type: string };
        if (m.type === 'hello')
          ws.send(JSON.stringify({ type: 'challenge', version: 1, nonce: 'AAAA' }));
        if (m.type === 'prove') {
          if (!afterReady) return ws.send(JSON.stringify({ type: 'ready', workspaces: [], huge }));
          ws.send(JSON.stringify({ type: 'ready', workspaces: [] }));
          ws.send(JSON.stringify({ type: 'joined', huge }));
        }
      }),
    );
    const options = {
      url: `ws://127.0.0.1:${port}`,
      identity: createIdentity('x'),
      bus: new Bus({ prompter: { ask: async () => 'deny' as const } }),
      dataDir: tmpdir(),
      shared: () => [],
    };
    await expect(RelayClient.connect(options)).rejects.toThrow();
    afterReady = true;
    const client = await RelayClient.connect(options);
    const joined = vi.fn();
    client.onJoined(joined);
    // The oversized frame ends the connection; the process keeps running.
    await new Promise((r) => setTimeout(r, 300));
    expect(joined).not.toHaveBeenCalled();
    await expect(client.invite('team')).rejects.toThrow('Relay connection closed');
  });

  it('shares the state of a bay with every member, also with late ones, and forgets leavers', async () => {
    const { dir, a, b, anna, ben } = await pair();
    const changes = vi.fn();
    b.client.onRemoteStates(changes);
    a.client.publishState('dev.hangar.agents', { sessions: ['s1'] });
    const fromAnna = {
      workspace: 'team',
      instance: anna.fingerprint,
      name: 'Anna Laptop',
      bayId: 'dev.hangar.agents',
      state: { sessions: ['s1'] },
    };
    await vi.waitFor(() => expect(b.client.remoteStates()).toEqual([fromAnna]));
    expect(changes).toHaveBeenLastCalledWith([fromAnna]);
    // Carl joins later and still learns the last state.
    const carlId = createIdentity('carl');
    const carl = await instance(carlId, dir);
    await carl.client.join('team', await a.client.invite('team'), anna.fingerprint);
    await vi.waitFor(() => expect(carl.client.remoteStates()).toContainEqual(fromAnna));
    // Ben leaves: Anna forgets his state.
    b.client.publishState('dev.hangar.agents', { sessions: [] });
    await vi.waitFor(() =>
      expect(a.client.remoteStates().map((s) => s.instance)).toContain(ben.fingerprint),
    );
    await a.client.removeMember('team', ben.fingerprint);
    await vi.waitFor(() =>
      expect(a.client.remoteStates().map((s) => s.instance)).not.toContain(ben.fingerprint),
    );
    // A state of the wrong shape is dropped.
    expect(carl.client.remoteStates().every((s) => s.bayId === 'dev.hangar.agents')).toBe(true);
    a.client.close();
    await vi.waitFor(() => expect(a.client.remoteStates()).toEqual([]));
  });

  it('two members changing the list at once: the relay orders them, nobody keeps a fork', async () => {
    const { a, b } = await pair();
    await vi.waitFor(() =>
      expect(b.client.workspace('team')!.list).toEqual(a.client.workspace('team')!.list),
    );
    const version = a.client.workspace('team')!.list.version;
    const results = await Promise.allSettled([a.client.renew('team'), b.client.renew('team')]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(String((results[1] as PromiseRejectedResult).reason)).toContain(
      'Not newer than the stored list',
    );
    await vi.waitFor(() => expect(b.client.workspace('team')!.list.version).toBe(version + 1));
    expect(b.client.workspace('team')!.list).toEqual(a.client.workspace('team')!.list);
  });
});
