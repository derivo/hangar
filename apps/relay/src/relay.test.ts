import { execFileSync } from 'node:child_process';
import { sign } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createIdentity,
  seal,
  signedChallenge,
  Workspace,
  type FromRelay,
  type Identity,
  type ToRelay,
} from '@hangar/relay';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startRelay, type Relay } from './relay';

const OPERATOR = 'operator-token';
const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
let relay: Relay | undefined;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await relay?.close();
  relay = undefined;
});

const anna = createIdentity('anna');
const ben = createIdentity('ben');
const eve = createIdentity('eve');

const origin = () => new URL(relay!.url).origin;

async function start(now = () => Date.now()) {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-relay-srv-'));
  const log: string[] = [];
  relay = await startRelay({
    file: join(dir, 'relay.json'),
    operatorToken: OPERATOR,
    log: (l) => log.push(l),
    now,
  });
  return { dir, log, file: join(dir, 'relay.json') };
}

/** A raw connection: every message from the relay lands in `inbox`. */
async function raw() {
  const ws = new WebSocket(relay!.url);
  sockets.push(ws);
  const inbox: FromRelay[] = [];
  const waiters: (() => void)[] = [];
  ws.on('message', (d) => {
    inbox.push(JSON.parse(String(d)) as FromRelay);
    for (const w of waiters.splice(0)) w();
  });
  await new Promise((r) => ws.once('open', r));
  const next = async <T extends FromRelay['type']>(type: T) => {
    for (;;) {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return inbox.splice(i, 1)[0] as Extract<FromRelay, { type: T }>;
      await new Promise<void>((r) => waiters.push(r));
    }
  };
  const send = (m: ToRelay | Record<string, unknown> | string) =>
    ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  const closed = new Promise<void>((r) => ws.once('close', () => r()));
  return { ws, inbox, next, send, closed };
}

/** Connected and proven as `who`. */
async function as(who: Identity) {
  const c = await raw();
  c.send({ type: 'hello', versions: [1], identity: who.document });
  const { nonce } = await c.next('challenge');
  c.send({
    type: 'prove',
    sig: sign(null, signedChallenge(nonce, origin()), who.signKey).toString('base64url'),
  });
  const ready = await c.next('ready');
  let id = 0;
  const request = async (m: Record<string, unknown>) => {
    const rid = ++id;
    c.send({ ...m, id: rid });
    for (;;) {
      const r = await c.next('result');
      if (r.id === rid) return r;
    }
  };
  return { ...c, ready, request };
}

async function team() {
  const ctx = await start();
  const a = await as(anna);
  const ws = Workspace.found('team', anna);
  expect(
    await a.request({ type: 'create', workspace: 'team', token: OPERATOR, list: ws.list }),
  ).toMatchObject({ ok: true });
  const token = (await a.request({ type: 'invite', workspace: 'team' })) as { value: string };
  const b = await as(ben);
  expect(await b.request({ type: 'join', workspace: 'team', token: token.value })).toMatchObject({
    ok: true,
    value: ws.list,
  });
  return { ...ctx, a, b, ws };
}

describe('relay: connecting', () => {
  it('proves the key of an instance before anything else', async () => {
    await start();
    const c = await raw();
    c.send({ type: 'invite', id: 1, workspace: 'team' });
    expect(await c.next('error')).toEqual({ type: 'error', message: 'Not authenticated' });
    await c.closed;
  });

  it.each([
    ['invalid JSON', '{', 'Invalid message'],
    ['no object', 'null', 'Invalid message'],
    [
      'no common version',
      { type: 'hello', versions: [99], identity: anna.document },
      'No common protocol version',
    ],
    [
      'forged identity',
      { type: 'hello', versions: [1], identity: { ...anna.document, name: 'x' } },
      'Invalid identity document',
    ],
  ])('refuses %s', async (_label, message, error) => {
    await start();
    const c = await raw();
    c.send(message as Record<string, unknown>);
    expect(await c.next('error')).toEqual({ type: 'error', message: error });
  });

  it('refuses a proof made with another key', async () => {
    await start();
    const c = await raw();
    c.send({ type: 'hello', versions: [1], identity: anna.document });
    const { nonce, version } = await c.next('challenge');
    expect(version).toBe(1);
    c.send({
      type: 'prove',
      sig: sign(null, signedChallenge(nonce, origin()), eve.signKey).toString('base64url'),
    });
    expect(await c.next('error')).toEqual({ type: 'error', message: 'Invalid proof' });
  });

  it('only listens on loopback without TLS', async () => {
    await expect(
      startRelay({ file: join(tmpdir(), 'x.json'), operatorToken: OPERATOR, host: '0.0.0.0' }),
    ).rejects.toThrow('Without TLS the relay listens on loopback only');
  });

  it('a second connection of the same instance replaces the first', async () => {
    await start();
    const first = await as(anna);
    await as(anna);
    await first.closed;
  });
});

describe('relay: workspaces', () => {
  it('creates a workspace only with the operator token and a valid name, once', async () => {
    await start();
    const a = await as(anna);
    const list = Workspace.found('team', anna).list;
    expect(
      await a.request({ type: 'create', workspace: 'team', token: 'wrong', list }),
    ).toMatchObject({ ok: false, error: 'Invalid operator token' });
    expect(
      await a.request({ type: 'create', workspace: '../x', token: OPERATOR, list }),
    ).toMatchObject({ ok: false, error: 'Invalid workspace name' });
    expect(
      await a.request({ type: 'create', workspace: 'team', token: OPERATOR, list }),
    ).toMatchObject({ ok: true });
    expect(
      await a.request({ type: 'create', workspace: 'team', token: OPERATOR, list }),
    ).toMatchObject({ ok: false, error: 'Workspace exists' });
  });

  it('invitations: only for members, single use, and they expire', async () => {
    let clock = Date.now();
    await start(() => clock);
    const a = await as(anna);
    await a.request({
      type: 'create',
      workspace: 'team',
      token: OPERATOR,
      list: Workspace.found('team', anna).list,
    });
    const e = await as(eve);
    expect(await e.request({ type: 'invite', workspace: 'team' })).toMatchObject({
      ok: false,
      error: 'Not a member',
    });
    expect(await e.request({ type: 'join', workspace: 'team', token: 'guess' })).toMatchObject({
      ok: false,
      error: 'Invalid invitation',
    });
    const { value: token } = (await a.request({ type: 'invite', workspace: 'team' })) as {
      value: string;
    };
    const b = await as(ben);
    expect(await b.request({ type: 'join', workspace: 'team', token })).toMatchObject({ ok: true });
    expect(await e.request({ type: 'join', workspace: 'team', token })).toMatchObject({
      ok: false,
      error: 'Invalid invitation',
    });
    const { value: late } = (await a.request({ type: 'invite', workspace: 'team' })) as {
      value: string;
    };
    clock += 8 * 24 * 60 * 60 * 1000;
    expect(await e.request({ type: 'join', workspace: 'team', token: late })).toMatchObject({
      ok: false,
      error: 'Invalid invitation',
    });
  });

  it('tells members who joined, at once and again after connecting while unlisted', async () => {
    const { a } = await team();
    expect(await a.next('joined')).toEqual({
      type: 'joined',
      workspace: 'team',
      identity: ben.document,
      inviter: anna.fingerprint,
    });
    const again = await as(anna);
    expect(await again.next('joined')).toEqual({
      type: 'joined',
      workspace: 'team',
      identity: ben.document,
      inviter: anna.fingerprint,
    });
    expect(again.ready.workspaces).toEqual([
      { workspace: 'team', list: expect.objectContaining({ version: 1 }) },
    ]);
  });

  it('keeps the newest member list, hands it on and drops revoked members from forwarding', async () => {
    const { a, b, ws } = await team();
    const v2 = ws.next(anna, { members: [anna.document, ben.document] });
    expect(await a.request({ type: 'list', list: v2 })).toMatchObject({ ok: true });
    expect(await b.next('list')).toEqual({ type: 'list', list: v2 });
    expect(await a.request({ type: 'list', list: v2 })).toMatchObject({
      ok: false,
      error: 'Not newer than the stored list',
    });
    const e = await as(eve);
    expect(await e.request({ type: 'list', list: v2 })).toMatchObject({
      ok: false,
      error: 'Not a member',
    });
    const v3 = ws.next(anna, { members: [anna.document], revoked: [ben.fingerprint] });
    await a.request({ type: 'list', list: v3 });
    const envelope = seal(
      anna,
      ben.document,
      { workspace: 'team', epoch: 'e'.repeat(16), seq: 1, ts: Date.now() },
      'x',
    );
    a.send({ type: 'send', envelope });
    expect(await a.next('undeliverable')).toEqual({
      type: 'undeliverable',
      to: ben.fingerprint,
      workspace: 'team',
      seq: 1,
      reason: 'refused',
    });
  });
});

describe('relay: forwarding', () => {
  it('forwards an envelope to the connected recipient without reading it', async () => {
    const { a, b } = await team();
    const envelope = seal(
      anna,
      ben.document,
      { workspace: 'team', epoch: 'e'.repeat(16), seq: 1, ts: Date.now() },
      'secret',
    );
    a.send({ type: 'send', envelope });
    expect(await b.next('deliver')).toEqual({ type: 'deliver', envelope });
  });

  it('refuses envelopes with a forged sender or outside the workspace', async () => {
    const { a, b } = await team();
    const forged = seal(
      ben,
      anna.document,
      { workspace: 'team', epoch: 'e'.repeat(16), seq: 1, ts: Date.now() },
      'x',
    );
    a.send({ type: 'send', envelope: forged });
    expect(await a.next('undeliverable')).toMatchObject({
      to: anna.fingerprint,
      reason: 'refused',
    });
    const toEve = seal(
      anna,
      eve.document,
      { workspace: 'team', epoch: 'e'.repeat(16), seq: 1, ts: Date.now() },
      'x',
    );
    a.send({ type: 'send', envelope: toEve });
    expect(await a.next('undeliverable')).toMatchObject({ to: eve.fingerprint, reason: 'refused' });
    a.send({ type: 'send' });
    expect(await a.next('error')).toEqual({ type: 'error', message: 'Not allowed' });
    expect(b.inbox.filter((m) => m.type === 'deliver')).toEqual([]);
  });

  it('tells the sender at once when the recipient is not connected', async () => {
    const { a, b } = await team();
    b.ws.close();
    await b.closed;
    const envelope = seal(
      anna,
      ben.document,
      { workspace: 'team', epoch: 'e'.repeat(16), seq: 7, ts: Date.now() },
      'x',
    );
    a.send({ type: 'send', envelope });
    expect(await a.next('undeliverable')).toEqual({
      type: 'undeliverable',
      to: ben.fingerprint,
      workspace: 'team',
      seq: 7,
      reason: 'offline',
    });
  });

  it('refuses unknown messages after connecting', async () => {
    const { a } = await team();
    a.send({ type: 'nope' });
    expect(await a.next('error')).toEqual({ type: 'error', message: 'Unknown message' });
  });
});

describe('relay: storage', () => {
  it('keeps workspaces across a restart in a file only its owner reads', async () => {
    const { file } = await team();
    // Windows has no POSIX file modes.
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    const stored = readFileSync(file, 'utf8');
    expect(stored).not.toContain(OPERATOR);
    await relay!.close();
    relay = await startRelay({ file, operatorToken: OPERATOR });
    const b = await as(ben);
    expect(b.ready.workspaces).toEqual([
      { workspace: 'team', list: expect.objectContaining({ version: 1 }) },
    ]);
  });
});

describe('relay: refuses member lists the instances would refuse', () => {
  it('on create: not signed by the creator, for another workspace, or forged', async () => {
    await start();
    const a = await as(anna);
    const byBen = Workspace.found('team', ben).list;
    expect(
      await a.request({ type: 'create', workspace: 'team', token: OPERATOR, list: byBen }),
    ).toMatchObject({ ok: false, error: 'Invalid member list' });
    const other = Workspace.found('other', anna).list;
    expect(
      await a.request({ type: 'create', workspace: 'team', token: OPERATOR, list: other }),
    ).toMatchObject({ ok: false, error: 'Invalid member list' });
    const forged = { ...Workspace.found('team', anna).list, version: 7 };
    expect(
      await a.request({ type: 'create', workspace: 'team', token: OPERATOR, list: forged }),
    ).toMatchObject({ ok: false, error: 'Invalid member list' });
  });

  it('on update: a junk list of a huge version cannot block the workspace', async () => {
    const { a, b, ws } = await team();
    const junk = { ...ws.draft(ben, {}), version: Number.MAX_SAFE_INTEGER };
    expect(await b.request({ type: 'list', list: junk })).toMatchObject({
      ok: false,
      error: 'Invalid member list',
    });
    const bogus = { workspace: 'team', version: 3, members: 5 };
    expect(await b.request({ type: 'list', list: bogus })).toMatchObject({
      ok: false,
      error: 'Invalid member list',
    });
    expect(
      await a.request({
        type: 'list',
        list: ws.next(anna, { members: [anna.document, ben.document] }),
      }),
    ).toMatchObject({ ok: true });
  });

  it('refuses a join without a token string and a list update without a list', async () => {
    const { a } = await team();
    expect(await a.request({ type: 'join', workspace: 'team', token: 5 })).toMatchObject({
      ok: false,
      error: 'Invalid invitation',
    });
    expect(await a.request({ type: 'list', list: null })).toMatchObject({
      ok: false,
      error: 'Not a member',
    });
  });

  it('forgets a joined instance that was revoked before anyone added it', async () => {
    const { a, ws, file } = await team();
    const { value: token } = (await a.request({ type: 'invite', workspace: 'team' })) as {
      value: string;
    };
    const e = await as(eve);
    await e.request({ type: 'join', workspace: 'team', token });
    await a.request({
      type: 'list',
      list: ws.next(anna, { members: [anna.document, ben.document], revoked: [eve.fingerprint] }),
    });
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<
      string,
      { members: string[]; joined: object }
    >;
    expect(stored.team!.members).toEqual([anna.fingerprint, ben.fingerprint]);
    expect(stored.team!.joined).toEqual({});
  });

  it('a member joining again stays one member', async () => {
    const { a, file } = await team();
    const { value: token } = (await a.request({ type: 'invite', workspace: 'team' })) as {
      value: string;
    };
    expect(await a.request({ type: 'join', workspace: 'team', token })).toMatchObject({ ok: true });
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { members: string[] }>;
    expect(stored.team!.members).toEqual([anna.fingerprint, ben.fingerprint]);
  });
});

describe('relay: health', () => {
  it('answers GET /health and nothing else over plain HTTP', async () => {
    await start();
    const base = relay!.url.replace(/^ws/, 'http');
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, version: 1 });
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });
});

describe('relay: addresses', () => {
  it('listens on IPv6 loopback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-relay-v6-'));
    relay = await startRelay({ file: join(dir, 'r.json'), operatorToken: OPERATOR, host: '::1' });
    expect(relay.url).toMatch(/^ws:\/\/\[::1\]:\d+$/);
    await as(anna);
  });

  it.skipIf(!hasOpenssl)('speaks TLS with a certificate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-relay-tls-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    const cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
    relay = await startRelay({
      file: join(dir, 'r.json'),
      operatorToken: OPERATOR,
      tls: { cert, key: readFileSync(join(dir, 'key.pem'), 'utf8') },
    });
    expect(relay.url).toMatch(/^wss:\/\/127\.0\.0\.1:\d+$/);
    const ws = new WebSocket(relay.url, { ca: cert });
    sockets.push(ws);
    const first = await new Promise<FromRelay>((resolve, reject) => {
      ws.once('error', reject);
      ws.once('open', () =>
        ws.send(JSON.stringify({ type: 'hello', versions: [1], identity: anna.document })),
      );
      ws.once('message', (d) => resolve(JSON.parse(String(d)) as FromRelay));
    });
    expect(first.type).toBe('challenge');
  });
});

describe('relay: review of phase 15', () => {
  it('survives an unauthenticated frame over the size limit', async () => {
    await start();
    const c = await raw();
    c.ws.send('x'.repeat(2 * 1024 * 1024));
    await c.closed;
    // Still serving: a new instance connects.
    expect((await as(anna)).ready).toEqual({ type: 'ready', workspaces: [] });
  });

  it('a proof made for another relay does not count here', async () => {
    await start();
    const c = await raw();
    c.send({ type: 'hello', versions: [1], identity: anna.document });
    const { nonce } = await c.next('challenge');
    c.send({
      type: 'prove',
      sig: sign(null, signedChallenge(nonce, 'wss://evil.example'), anna.signKey).toString(
        'base64url',
      ),
    });
    expect(await c.next('error')).toEqual({ type: 'error', message: 'Invalid proof' });
  });

  it('a revoked member cannot come back with an invitation it kept', async () => {
    const { a, b, ws } = await team();
    const kept = (await b.request({ type: 'invite', workspace: 'team' })) as { value: string };
    const v2 = ws.next(anna, { members: [anna.document], revoked: [ben.fingerprint] });
    expect(await a.request({ type: 'list', list: v2 })).toMatchObject({ ok: true });
    expect(await b.request({ type: 'join', workspace: 'team', token: kept.value })).toMatchObject({
      ok: false,
      error: 'Revoked',
    });
    expect(await b.request({ type: 'invite', workspace: 'team' })).toMatchObject({
      ok: false,
      error: 'Not a member',
    });
  });

  it('keeps at most 20 open invitations per workspace', async () => {
    const { a } = await team();
    for (let i = 0; i < 20; i++)
      expect(await a.request({ type: 'invite', workspace: 'team' })).toMatchObject({ ok: true });
    expect(await a.request({ type: 'invite', workspace: 'team' })).toMatchObject({
      ok: false,
      error: 'Too many open invitations',
    });
  });

  it('drops a recipient that does not read instead of queueing without end', async () => {
    const { a, b } = await team();
    b.ws.pause();
    const big = 'x'.repeat(1000 * 1000);
    for (let seq = 1; seq <= 40; seq++) {
      a.send({
        type: 'send',
        envelope: {
          header: { workspace: 'team', from: anna.fingerprint, to: ben.fingerprint, seq },
          ciphertext: big,
        },
      });
    }
    await expect(a.next('undeliverable')).resolves.toMatchObject({ reason: 'offline' });
  });
});
