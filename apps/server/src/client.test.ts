import { generateKeyPairSync, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { connect, signedHello } from '@hangar/bridge';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

// A peer that is not hangar-server: what the client does with bad answers.
let peer: WebSocketServer | undefined;
afterEach(() => peer?.close());

async function fakeServer(
  onHello: (ws: WebSocket, hello: { nonce: string }) => void,
  onRequest: (ws: WebSocket, m: { id: number }) => void = () => {},
) {
  const received: string[] = [];
  peer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  peer.on('connection', (ws) =>
    ws.on('message', (data) => {
      const text = data.toString();
      received.push(text);
      const m = JSON.parse(text) as { type: string; nonce: string };
      if (m.type === 'hello') onHello(ws, m);
      else onRequest(ws, m as unknown as { id: number });
    }),
  );
  await new Promise((r) => peer!.once('listening', r));
  const url = `ws://127.0.0.1:${(peer.address() as AddressInfo).port}/connect`;
  return { url, received };
}

const key = generateKeyPairSync('ed25519');
const publicKey = key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

describe('connect against a peer that misbehaves', () => {
  it('sends neither token nor pairing code to a server that cannot sign the nonce', async () => {
    const s = await fakeServer((ws) => {
      const signature = sign(null, signedHello('b3RoZXI='), key.privateKey).toString('base64');
      ws.send(JSON.stringify({ type: 'welcome', version: 1, publicKey, signature }));
    });
    await expect(connect({ url: s.url, token: 'secret-token' })).rejects.toThrow(
      'Server signature is invalid',
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(s.received.map((m) => JSON.parse(m).type)).toEqual(['hello']);
    expect(s.received.join()).not.toContain('secret-token');
  });

  it('fails when the server closes before it answers', async () => {
    const s = await fakeServer((ws) => ws.close());
    await expect(connect({ url: s.url })).rejects.toThrow(
      `Connection to ${s.url} closed before the server answered`,
    );
  });

  it('fails when the server does not answer in time', async () => {
    const s = await fakeServer(() => {});
    await expect(connect({ url: s.url, timeoutMs: 100 })).rejects.toThrow(
      `${s.url} did not answer within 0.1 s`,
    );
  });

  it('fails on an answer that is not JSON, before and after the handshake', async () => {
    const s = await fakeServer((ws) => ws.send('not-json'));
    await expect(connect({ url: s.url })).rejects.toThrow('Invalid message from the server');

    const t = await fakeServer((ws, hello) => {
      const signature = sign(null, signedHello(hello.nonce), key.privateKey).toString('base64');
      ws.send(JSON.stringify({ type: 'welcome', version: 1, publicKey, signature }));
      setTimeout(() => ws.send('not-json'), 20);
    });
    const connection = await connect({ url: t.url });
    await new Promise<void>((r) => connection.onClose(r));
  });

  it('rejects a request whose answer has the wrong shape', async () => {
    const s = await fakeServer(
      (ws, hello) => {
        const signature = sign(null, signedHello(hello.nonce), key.privateKey).toString('base64');
        ws.send(JSON.stringify({ type: 'welcome', version: 1, publicKey, signature }));
      },
      (ws, m) =>
        ws.send(JSON.stringify({ type: 'result', id: m.id, ok: false, error: { toString: null } })),
    );
    const connection = await connect({ url: s.url });
    await expect(connection.invoke('dev.echo', 'echo', [])).rejects.toThrow(
      'Invalid message from the server',
    );
  });
});

describe('permission questions from a server that floods them (phase 11b)', () => {
  it('asks one at a time, once per id, at most 10 open, also right after auth, and ends them on close', async () => {
    const request = {
      caller: { kind: 'session', bayId: 'dev.hangar.agents', sessionId: 's1' },
      target: 'dev.hangar.vault/secret.read',
      sensitive: true,
      kind: 'grant',
    };
    let server: WebSocket | undefined;
    const s = await fakeServer(
      (ws, hello) => {
        server = ws;
        const signature = sign(null, signedHello(hello.nonce), key.privateKey).toString('base64');
        ws.send(JSON.stringify({ type: 'welcome', version: 1, publicKey, signature }));
      },
      (ws, m) => {
        if ((m as { type?: string }).type !== 'auth') return;
        // In the same breath as the auth result, before the desktop can install its asker.
        ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, value: [] }));
        for (const id of [1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
          ws.send(JSON.stringify({ type: 'ask', id, request }));
        }
      },
    );
    const conn = await connect({ url: s.url, token: 't' });
    const shown: AbortSignal[] = [];
    const answers: ((d: 'deny') => void)[] = [];
    conn.onAsk((r, signal) => {
      expect(r).toEqual(request);
      shown.push(signal);
      return new Promise((resolve) => answers.push(resolve));
    });
    const answered = () =>
      s.received
        .map((t) => JSON.parse(t))
        .filter((m) => m.type === 'answer')
        .map((m) => m.id);

    // Let the whole burst arrive first: an early answer would free a slot for id 11.
    await expect.poll(() => shown.length).toBe(1);
    await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 10; i++) {
      await expect.poll(() => shown.length).toBe(i + 1);
      answers[i]!('deny');
    }
    await expect.poll(answered).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(shown).toHaveLength(10);

    server!.send(JSON.stringify({ type: 'ask', id: 20, request }));
    await expect.poll(() => shown.length).toBe(11);
    server!.close();
    await expect.poll(() => shown[10]!.aborted).toBe(true);
    answers[10]!('deny');
    await new Promise((r) => setTimeout(r, 50));
    expect(answered()).not.toContain(20);
  });
});

describe('permission questions the desktop refuses to show (Codex round 2)', () => {
  it('ignores malformed questions and ids it answered, and gives each question its own signal', async () => {
    const request = {
      caller: { kind: 'bay', bayId: 'dev.x' },
      target: 'dev.y/f',
      sensitive: false,
      kind: 'grant',
    };
    let server: WebSocket | undefined;
    const s = await fakeServer(
      (ws, hello) => {
        server = ws;
        const signature = sign(null, signedHello(hello.nonce), key.privateKey).toString('base64');
        ws.send(JSON.stringify({ type: 'welcome', version: 1, publicKey, signature }));
      },
      (ws, m) => {
        if ((m as { type?: string }).type === 'auth') {
          ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, value: [] }));
        }
      },
    );
    const conn = await connect({ url: s.url, token: 't' });
    const shown: { id: unknown; signal: AbortSignal }[] = [];
    const answers: ((d: 'allow') => void)[] = [];
    let current: unknown;
    conn.onAsk((_r, signal) => {
      shown.push({ id: current, signal });
      return new Promise((resolve) => answers.push(resolve));
    });
    const ask = (id: unknown, req: unknown = request) => {
      current = id;
      server!.send(JSON.stringify({ type: 'ask', id, request: req }));
    };
    for (const id of [undefined, 'a', 1.5, null]) ask(id);
    const remote = { kind: 'remote', bayId: 'dev.x', instance: 'f'.repeat(64), workspace: 'w' };
    const { instance: _i, ...withoutInstance } = remote;
    for (const req of [
      null,
      {},
      { ...request, kind: 'other' },
      { ...request, caller: 5 },
      { ...request, caller: withoutInstance },
      { ...request, caller: { ...remote, workspace: 1 } },
    ])
      ask(2, req);
    await new Promise((r) => setTimeout(r, 50));
    expect(shown).toHaveLength(0);

    ask(1);
    await expect.poll(() => shown.length).toBe(1);
    answers[0]!('allow');
    // A caller of another instance (ADR 0011) reaches the dialog like a local one.
    ask(3, { ...request, caller: remote });
    await expect.poll(() => shown.length).toBe(2);
    // Replayed after its answer, or an id below the last one: not shown (ids only increase).
    ask(1);
    ask(2);
    answers[1]!('allow');
    await new Promise((r) => setTimeout(r, 50));
    expect(shown).toHaveLength(2);
    expect(shown[0]!.signal).not.toBe(shown[1]!.signal);

    // A withdrawal of a question never asked changes nothing; nothing is kept for it.
    for (let id = 100; id < 200; id++) server!.send(JSON.stringify({ type: 'withdraw', id }));
    expect((conn as unknown as { done?: Set<number> }).done).toBeUndefined();
    // The server gives up: the shown dialog closes, a waiting question goes.
    ask(4);
    ask(5);
    await expect.poll(() => shown.length).toBe(3);
    server!.send(JSON.stringify({ type: 'withdraw', id: 5 }));
    server!.send(JSON.stringify({ type: 'withdraw', id: 4 }));
    await expect.poll(() => shown[2]!.signal.aborted).toBe(true);
    answers[2]!('allow');
    await new Promise((r) => setTimeout(r, 50));
    expect(shown).toHaveLength(3);
    const answered = s.received.map((t) => JSON.parse(t)).filter((m) => m.type === 'answer');
    expect(answered.map((m) => m.id)).toEqual([1, 3]);
  });
});

describe('calls of the local server (ADR 0036)', () => {
  it('answers a call only in the right shape, and with an error without a handler', async () => {
    let socket: WebSocket | undefined;
    const s = await fakeServer((ws, { nonce }) => {
      socket = ws;
      const signature = sign(null, signedHello(nonce), key.privateKey).toString('base64');
      ws.send(JSON.stringify({ type: 'welcome', version: 3, publicKey, signature }));
    });
    const conn = await connect({ url: s.url });
    expect(conn.version).toBe(3);
    const send = (m: unknown) => socket!.send(JSON.stringify(m));
    send({ type: 'call', id: 1, target: 'dev.b/f', args: {}, caller: { bayId: 'dev.a' } });
    await expect.poll(() => s.received.at(-1)).toBeDefined();
    await expect
      .poll(() => s.received.map((m) => JSON.parse(m)).at(-1))
      .toEqual({ type: 'reply', id: 1, ok: false, error: 'Unknown function: dev.b/f' });
    const calls: unknown[] = [];
    conn.onCall(async (...c) => (calls.push(c), 'ok'));
    send({ type: 'call', id: 2, target: 'dev.b/f', args: {}, caller: { bayId: 1 } });
    send({ type: 'call', id: 'x', target: 'dev.b/f', args: {}, caller: { bayId: 'dev.a' } });
    send({
      type: 'call',
      id: 3,
      target: 'dev.b/f',
      args: {},
      caller: { bayId: 'dev.a', sessionId: 2 },
    });
    send({ type: 'sessionEnded', bayId: 1, sessionId: 's' });
    send({ type: 'sessions', count: -1 });
    send({ type: 'sessions', count: 1.5 });
    send({
      type: 'call',
      id: 4,
      target: 'dev.b/f',
      args: [1],
      caller: { bayId: 'dev.a', sessionId: 's' },
    });
    await expect
      .poll(() => s.received.map((m) => JSON.parse(m)).at(-1))
      .toEqual({ type: 'reply', id: 4, ok: true, value: 'ok' });
    expect(calls).toEqual([
      ['dev.b/f', [1], { bayId: 'dev.a', sessionId: 's' }, expect.any(AbortSignal)],
    ]);
    expect(conn.sessions).toBeUndefined();
    conn.close();
  });
});
