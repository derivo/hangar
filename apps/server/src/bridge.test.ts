import { readdirSync, readFileSync, statSync } from 'node:fs';
import { connect as connectSocket } from 'node:net';
import { join } from 'node:path';
import { connect, PROTOCOL_VERSION } from '@hangar/bridge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunningServer } from './server';
import { startBridge, startEchoServer } from './test-setup';

let server: RunningServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(data?: string) {
  const s = await startEchoServer(data);
  server = s.server;
  return s;
}

describe('bridge: pairing', () => {
  it('pairs with the code from the log after the fingerprint is shown, then works with the token', async () => {
    const s = await start();
    expect(s.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(s.code()).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const first = await connect({ url: s.url });
    expect(first.fingerprint).toBe(s.fingerprint);
    expect(first.paired).toBe(false);
    await expect(first.invoke('dev.echo', 'echo', [1])).rejects.toThrow('Not paired');
    await expect(first.pair('WRON-GCOD', 'Laptop')).rejects.toThrow('Wrong pairing code');
    const code = s.code();
    const token = await first.pair(code, 'Laptop');
    expect(first.paired).toBe(true);
    expect(first.bays).toEqual([{ id: 'dev.echo', version: '0.1.0' }]);
    first.close();

    // The code works once; the server logs a new one.
    expect(s.code()).not.toBe(code);
    const other = await connect({ url: s.url });
    await expect(other.pair(code, 'Zweiter')).rejects.toThrow('Wrong pairing code');
    other.close();

    const conn = await connect({ url: s.url, fingerprint: s.fingerprint, token });
    expect(conn.paired).toBe(true);
    const events: unknown[] = [];
    conn.onEvent((bay, channel, payload) => events.push([bay, channel, payload]));
    await expect(conn.invoke('dev.echo', 'echo', [{ a: 1 }])).resolves.toEqual({ a: 1 });
    expect(events).toEqual([['dev.echo', 'echoed', { a: 1 }]]);
    await expect(conn.invoke('dev.echo', 'fail', [])).rejects.toThrow('kaputt');
    await expect(conn.invoke('dev.none', 'echo', [])).rejects.toThrow('Unknown bay: dev.none');
    conn.close();
  });

  it('also writes each pairing code to <data>/pair-code, readable by the owner only', async () => {
    // The desktop on the same machine pairs with its own local server without typing (ADR 0036).
    const s = await start();
    const file = join(s.data, 'pair-code');
    expect(readFileSync(file, 'utf8')).toBe(s.code());
    // Windows has no POSIX file modes.
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    const conn = await connect({ url: s.url });
    await conn.pair(readFileSync(file, 'utf8'), 'Laptop');
    conn.close();
    expect(readFileSync(file, 'utf8')).toBe(s.code());
    expect(readdirSync(s.data).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('keeps its key across restarts', async () => {
    const s = await start();
    await server!.close();
    const again = await start(s.data);
    expect(again.fingerprint).toBe(s.fingerprint);
  });
});

describe('bridge: rejected connections', () => {
  it('rejects a wrong token', async () => {
    const s = await start();
    await expect(
      connect({ url: s.url, fingerprint: s.fingerprint, token: 'nope' }),
    ).rejects.toThrow('Invalid token');
  });

  it('rejects a server whose fingerprint does not match', async () => {
    const s = await start();
    const other = 'SHA256:' + 'A'.repeat(43);
    await expect(connect({ url: s.url, fingerprint: other })).rejects.toThrow(
      `Server fingerprint does not match: expected ${other}, got ${s.fingerprint}`,
    );
  });

  it('rejects a protocol version it does not speak', async () => {
    const s = await start();
    const ws = new WebSocket(s.url);
    await new Promise((r) => ws.addEventListener('open', r));
    ws.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION + 1, nonce: 'eA==' }));
    const reply = await new Promise<string>((r) =>
      ws.addEventListener('message', (e) => r(e.data as string)),
    );
    expect(JSON.parse(reply)).toEqual({
      type: 'error',
      message: `Protocol version ${PROTOCOL_VERSION + 1} not supported (server speaks ${PROTOCOL_VERSION})`,
    });
  });

  it('answers malformed or early messages with an error and closes', async () => {
    const s = await start();
    const firstReply = async (text: string) => {
      const ws = new WebSocket(s.url);
      await new Promise((r) => ws.addEventListener('open', r));
      const closed = new Promise((r) => ws.addEventListener('close', r));
      ws.send(text);
      const reply = await new Promise<string>((r) =>
        ws.addEventListener('message', (e) => r(e.data as string)),
      );
      await closed;
      return JSON.parse(reply);
    };
    expect(await firstReply('{')).toEqual({ type: 'error', message: 'Invalid message' });
    expect(
      await firstReply('{"type":"invoke","id":1,"bay":"dev.echo","channel":"echo","args":[]}'),
    ).toEqual({ type: 'error', message: 'Say hello first' });
    // Type names of Object.prototype are no validators (Codex re-review 2026-10-30).
    for (const text of ['{"type":"__proto__"}', '{"type":"constructor"}', '{"type":5}']) {
      expect(await firstReply(text), text).toEqual({ type: 'error', message: 'Say hello first' });
    }
    // Fields of the wrong type never reach the handlers (a hello without nonce crashed the server).
    for (const text of [
      '{"type":"hello","version":1}',
      '{"type":"hello","version":1,"nonce":5}',
      'null',
      '{"type":"invoke","id":1,"bay":"dev.echo","channel":"echo"}',
      '{"type":"answer","id":1,"decision":5}',
      '{"type":"jobs"}',
      '{"type":"job","id":1,"action":"explode","job":"x"}',
      '{"type":"job","id":1,"action":"run","job":5}',
      '{"type":"workspaces","id":1,"action":5,"args":[]}',
      '{"type":"workspaces","id":1,"action":"view","args":[{}]}',
    ]) {
      expect(await firstReply(text), text).toEqual({ type: 'error', message: 'Invalid message' });
    }
    const conn = await connect({ url: s.url });
    // Reaches the server only through a raw socket; the client never sends it.
    (conn as unknown as { ws: WebSocket }).ws.send('{"type":"bye"}');
    const closed = new Promise<void>((r) => conn.onClose(r));
    const pending = conn.invoke('dev.echo', 'echo', [1]);
    await closed;
    await expect(pending).rejects.toThrow(/Connection closed|Not paired/);
  });

  it('survives a broken frame before any login (anyone on the loopback can send one)', async () => {
    const s = await start();
    const { port } = new URL(s.url);
    const socket = connectSocket(Number(port), '127.0.0.1');
    await new Promise((r) => socket.once('connect', r));
    socket.write(
      'GET /connect HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
    await new Promise((r) => socket.once('data', r));
    const closed = new Promise((r) => socket.once('close', r));
    // A client frame without mask: invalid by RFC 6455.
    socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
    await closed;
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
  });

  it('reports a server it cannot reach', async () => {
    await expect(connect({ url: 'ws://127.0.0.1:9/connect' })).rejects.toThrow(
      'Cannot reach ws://127.0.0.1:9/connect',
    );
  });
});

describe('bridge: permission questions (phase 11b)', () => {
  const opened: { close(): void }[] = [];
  afterEach(() => {
    for (const o of opened.splice(0)) o.close();
  });
  const bridge = async (askTimeoutMs?: number) => {
    const b = await startBridge(askTimeoutMs);
    opened.push(b);
    return b;
  };
  const desktop = async (b: Awaited<ReturnType<typeof startBridge>>) => {
    const conn = await connect({ url: b.url });
    await conn.pair(b.code(), 'Laptop');
    opened.push(conn);
    return conn;
  };
  const request = {
    caller: { kind: 'session', bayId: 'dev.hangar.agents', sessionId: 's1' },
    target: 'dev.hangar.vault/secret.read',
    sensitive: true,
    kind: 'grant',
  } as const;
  const denied = (why: string) =>
    `Access denied: dev.hangar.agents → dev.hangar.vault/secret.read (${why})`;

  it('asks the desktop that connected last and returns its answer', async () => {
    const b = await bridge();
    const first = await desktop(b);
    const last = await desktop(b);
    const asked: unknown[] = [];
    first.onAsk(async () => 'allow');
    last.onAsk(async (r) => (asked.push(r), 'session'));
    await expect(b.bridge.ask(request)).resolves.toBe('session');
    expect(asked).toEqual([request]);
  });

  it('fails without a stored answer when no desktop can answer', async () => {
    const b = await bridge(100);
    await expect(b.bridge.ask(request)).rejects.toThrow(
      denied('no desktop connected to ask: set a rule in permissions.json'),
    );
    // Connected but not paired: not asked.
    opened.push(await connect({ url: b.url }));
    await expect(b.bridge.ask(request)).rejects.toThrow(
      denied('no desktop connected to ask: set a rule in permissions.json'),
    );

    const conn = await desktop(b);
    conn.onAsk(() => new Promise(() => {}));
    await expect(b.bridge.ask(request)).rejects.toThrow(
      denied('no answer from the desktop within 0.1 s'),
    );
    const asking = b.bridge.ask(request);
    conn.close();
    await expect(asking).rejects.toThrow(denied('the desktop went away before answering'));
  });

  it('withdraws a question it gave up on, and takes at most 10 open ones', async () => {
    const b = await bridge(100);
    const conn = await desktop(b);
    const signals: AbortSignal[] = [];
    conn.onAsk((_r, signal) => (signals.push(signal), new Promise(() => {})));
    await expect(b.bridge.ask(request)).rejects.toThrow(
      denied('no answer from the desktop within 0.1 s'),
    );
    await expect.poll(() => signals[0]?.aborted).toBe(true);

    const slow = await bridge();
    const other = await desktop(slow);
    other.onAsk(() => new Promise(() => {}));
    const open = Array.from({ length: 10 }, () => slow.bridge.ask(request));
    await expect(slow.bridge.ask(request)).rejects.toThrow(denied('too many open questions'));
    other.close();
    await Promise.allSettled(open);
  });

  it('accepts only an answer that fits the question, from the desktop asked', async () => {
    const b = await bridge();
    const conn = await desktop(b);
    // Choices of a sensitive grant do not fit a confirmation.
    conn.onAsk(async () => 'session');
    await expect(b.bridge.ask({ ...request, kind: 'confirm' })).rejects.toThrow(
      denied('invalid answer from the desktop'),
    );
    await expect(b.bridge.ask({ ...request, sensitive: false })).rejects.toThrow(
      denied('invalid answer from the desktop'),
    );

    // Another connection cannot answer in its place.
    let answer: (d: 'deny') => void = () => {};
    conn.onAsk(() => new Promise((r) => (answer = r)));
    const asking = b.bridge.ask(request);
    const other = await connect({ url: b.url });
    opened.push(other);
    const raw = (other as unknown as { ws: WebSocket }).ws;
    for (let id = 1; id < 10; id++)
      raw.send(JSON.stringify({ type: 'answer', id, decision: 'allow' }));
    await new Promise((r) => setTimeout(r, 50));
    answer('deny');
    await expect(asking).resolves.toBe('deny');
  });
});

describe('bridge: notifications and badges (phase 11c)', () => {
  const opened: { close(): void }[] = [];
  afterEach(() => {
    for (const o of opened.splice(0)) o.close();
  });
  const bays = [{ id: 'dev.hangar.agents', version: '0.1.0' }];
  const bridge = async () => {
    const b = await startBridge(undefined, bays);
    opened.push(b);
    return b;
  };
  const desktop = async (b: Awaited<ReturnType<typeof startBridge>>) => {
    const conn = await connect({ url: b.url });
    await conn.pair(b.code(), 'Laptop');
    opened.push(conn);
    const notes: unknown[] = [];
    conn.onNotify((bay, n) => notes.push([bay, n]));
    return { conn, notes };
  };
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const bay = 'dev.hangar.agents';

  it('keeps notifications while no desktop is connected and delivers them once, to the next', async () => {
    const b = await bridge();
    b.bridge.notify(bay, { title: 'A' });
    b.bridge.notify(bay, { title: 'B', body: 'b' });
    const first = await desktop(b);
    await settle();
    expect(first.notes).toEqual([
      [bay, { title: 'A' }],
      [bay, { title: 'B', body: 'b' }],
    ]);
    const second = await desktop(b);
    b.bridge.notify(bay, { title: 'C' });
    await settle();
    expect(second.notes).toEqual([[bay, { title: 'C' }]]);
    expect(first.notes).toHaveLength(3);
  });

  it('keeps the last 50 notifications while no desktop is connected', async () => {
    const b = await bridge();
    for (let i = 0; i < 55; i++) b.bridge.notify(bay, { title: String(i) });
    const { notes } = await desktop(b);
    await settle();
    expect(notes.map((n) => (n as [string, { title: string }])[1].title)).toEqual(
      Array.from({ length: 50 }, (_, i) => String(i + 5)),
    );
  });

  it('sends the current badges on connect and every change after', async () => {
    const b = await bridge();
    b.bridge.badge(bay, 2);
    const { conn } = await desktop(b);
    const changes: unknown[] = [];
    conn.onBadge(() => changes.push({ ...conn.badges }));
    await settle();
    expect(conn.badges).toEqual({ [bay]: 2 });
    b.bridge.badge(bay, 0);
    await settle();
    expect(conn.badges).toEqual({ [bay]: 0 });
    // The first badge may come before or after onBadge: only the last change counts here.
    expect(changes.at(-1)).toEqual({ [bay]: 0 });
  });

  it('keeps a notification sent while the only desktop is closing (Codex 11c)', async () => {
    const b = await bridge();
    const { conn } = await desktop(b);
    const closed = new Promise<void>((r) => conn.onClose(r));
    conn.close();
    await closed;
    b.bridge.notify(bay, { title: 'late' });
    const next = await desktop(b);
    await settle();
    expect(next.notes).toEqual([[bay, { title: 'late' }]]);
  });

  it('limits what a paired server can make the desktop show (Codex 11c)', async () => {
    const b = await bridge();
    const { conn, notes } = await desktop(b);
    const changes = vi.fn();
    conn.onBadge(changes);
    for (let i = 0; i < 100; i++)
      b.bridge.notify(bay, { title: 'x'.repeat(500), body: 'y'.repeat(5000) });
    for (let i = 0; i < 5; i++) b.bridge.badge(bay, 3);
    b.bridge.badge(bay, 1e308);
    await settle();
    // At most 60 a minute: enough for the 50 kept ones and a few more.
    expect(notes).toHaveLength(60);
    const [, first] = notes[0] as [string, { title: string; body: string }];
    expect(first.title).toHaveLength(200);
    expect(first.body).toHaveLength(1000);
    // Unchanged badges change nothing; huge ones are capped.
    expect(changes).toHaveBeenCalledTimes(2);
    expect(conn.badges).toEqual({ [bay]: 9999 });
  });

  it('ignores notifications and badges of unknown bays or with the wrong shape', async () => {
    const b = await bridge();
    const { conn, notes } = await desktop(b);
    b.bridge.notify('dev.other', { title: 'x' });
    b.bridge.badge('dev.other', 1);
    b.bridge.notify(bay, { title: 5 } as never);
    b.bridge.notify(bay, { title: 'x', body: 5 } as never);
    b.bridge.badge(bay, -1);
    b.bridge.badge(bay, 1.5);
    await settle();
    expect(notes).toEqual([]);
    expect(conn.badges).toEqual({});
  });
});

describe('bridge: bays of the desktop for the local server (ADR 0036)', () => {
  const tab = {
    bayId: 'dev.hangar.browser',
    spec: { name: 'tab.open', sensitive: false, openToAgents: true, description: 'Opens' },
  };
  const target = 'dev.hangar.browser/tab.open';
  const agent = { bayId: 'dev.hangar.agents', sessionId: 's1' };
  async function offering() {
    const offers: unknown[] = [];
    const b = await startBridge(undefined, [], undefined, (f) => offers.push(f));
    const conn = await connect({ url: b.url });
    await conn.pair(b.code(), 'Laptop');
    return { b, conn, offers };
  }

  it('takes what a paired desktop offers and calls it there, with the caller', async () => {
    const { b, conn, offers } = await offering();
    try {
      const calls: unknown[] = [];
      conn.onCall(async (...call) => (calls.push(call), { id: 't1' }));
      await conn.offer([tab]);
      expect(offers).toEqual([[tab]]);
      await expect(b.bridge.call(target, { url: 'x' }, agent)).resolves.toEqual({ id: 't1' });
      expect(calls).toEqual([[target, { url: 'x' }, agent, expect.any(AbortSignal)]]);
      conn.onCall(async () => {
        throw new Error('kaputt');
      });
      await expect(b.bridge.call(target, {}, { bayId: 'dev.probe' })).rejects.toThrow('kaputt');
      const ended = vi.fn();
      conn.onSessionEnded(ended);
      b.bridge.sessionEnded('dev.hangar.agents', 's1');
      await vi.waitFor(() => expect(ended).toHaveBeenCalledWith('dev.hangar.agents', 's1'));
    } finally {
      conn.close();
      b.close();
    }
  });

  it('keeps the sessions that end without a desktop and tells the next that offers', async () => {
    const { b, conn } = await offering();
    try {
      const ended = vi.fn();
      conn.onSessionEnded(ended);
      // Ended while the app was away: its tabs would stay open until it restarts.
      b.bridge.sessionEnded('dev.hangar.agents', 's1');
      await conn.offer([tab]);
      await vi.waitFor(() => expect(ended).toHaveBeenCalledWith('dev.hangar.agents', 's1'));
      await conn.offer([tab]);
      expect(ended).toHaveBeenCalledTimes(1);
      // Without a desktop for long: the oldest are dropped.
      conn.close();
      const again = await connect({ url: b.url });
      await again.pair(b.code(), 'Laptop');
      const later = vi.fn();
      again.onSessionEnded(later);
      for (let i = 0; i <= 500; i++) b.bridge.sessionEnded('dev.hangar.agents', `s${i}`);
      await again.offer([tab]);
      await vi.waitFor(() => expect(later).toHaveBeenCalledWith('dev.hangar.agents', 's500'));
      expect(later).toHaveBeenCalledTimes(500);
      expect(later).not.toHaveBeenCalledWith('dev.hangar.agents', 's0');
      again.close();
    } finally {
      conn.close();
      b.close();
    }
  });

  it('fails a call while no desktop offered, and when it goes away during the call', async () => {
    const { b, conn } = await offering();
    try {
      await expect(b.bridge.call(target, {}, agent)).rejects.toThrow('Hangar is not open');
      let called = () => {};
      const reached = new Promise<void>((r) => (called = r));
      let signal: AbortSignal | undefined;
      conn.onCall((_t, _a, _c, s) => ((signal = s), called(), new Promise(() => {})));
      await conn.offer([tab]);
      const call = b.bridge.call(target, {}, agent);
      await reached;
      expect(signal!.aborted).toBe(false);
      conn.close();
      // At once, not after the closing handshake: a dialog answered meanwhile must not run it.
      expect(signal!.aborted).toBe(true);
      await expect(call).rejects.toThrow('Hangar is not open');
      // A call still waiting in the app (its permission dialog, say) must not run afterwards.
      await vi.waitFor(() => expect(signal!.aborted).toBe(true));
      await vi.waitFor(() =>
        expect(b.bridge.call(target, {}, agent)).rejects.toThrow('Hangar is not open'),
      );
    } finally {
      b.close();
    }
  });

  it('takes offers only from paired desktops, in the right shape and with known fields only', async () => {
    const offers: unknown[] = [];
    const b = await startBridge(undefined, [], undefined, (f) => offers.push(f));
    try {
      const stranger = await connect({ url: b.url });
      await expect(stranger.offer([tab])).rejects.toThrow('Not paired');
      stranger.close();
      const conn = await connect({ url: b.url });
      await conn.pair(b.code(), 'Laptop');
      await conn.offer([{ ...tab, spec: { ...tab.spec, remote: true, extra: 1 } } as never]);
      expect(offers).toEqual([[tab]]);
      const closed = new Promise((r) => conn.onClose(() => r(undefined)));
      void conn.offer([{ bayId: 'dev.x', spec: { name: 1 } }] as never).catch(() => {});
      await closed;
      expect(offers).toHaveLength(1);
    } finally {
      b.close();
    }
  });
});

describe('bridge: running shells for the tray (ADR 0036)', () => {
  it('tells paired desktops how many agent sessions run, on connect and on every change', async () => {
    const b = await startBridge();
    try {
      b.bridge.sessions(2);
      const conn = await connect({ url: b.url });
      const changed = vi.fn();
      conn.onSessions(changed);
      expect(conn.sessions).toBeUndefined();
      await conn.pair(b.code(), 'Laptop');
      await vi.waitFor(() => expect(conn.sessions).toBe(2));
      b.bridge.sessions(3);
      await vi.waitFor(() => expect(conn.sessions).toBe(3));
      expect(changed).toHaveBeenCalled();
      conn.close();
    } finally {
      b.close();
    }
  });
});

describe('bridge: workspaces of the local server (ADR 0036, point 11)', () => {
  it('lets a paired desktop manage the workspaces and tells it about changes', async () => {
    const calls: unknown[] = [];
    const b = await startBridge(undefined, [], undefined, undefined, async (action, args) => {
      calls.push([action, args]);
      return { token: 't' };
    });
    try {
      const stranger = await connect({ url: b.url });
      await expect(stranger.workspaces('view', [])).rejects.toThrow('Not paired');
      stranger.close();
      const conn = await connect({ url: b.url });
      await conn.pair(b.code(), 'Laptop');
      await expect(conn.workspaces('share', ['team', 'dev.x/f', true])).resolves.toEqual({
        token: 't',
      });
      expect(calls).toEqual([['share', ['team', 'dev.x/f', true]]]);
      const changed = vi.fn();
      conn.onWorkspaces(changed);
      b.bridge.workspacesChanged();
      await vi.waitFor(() => expect(changed).toHaveBeenCalled());
      conn.close();
    } finally {
      b.close();
    }
  });

  it('fails on a server without workspaces', async () => {
    const b = await startBridge();
    try {
      const conn = await connect({ url: b.url });
      await conn.pair(b.code(), 'Laptop');
      await expect(conn.workspaces('view', [])).rejects.toThrow('No workspaces on this server');
      conn.close();
    } finally {
      b.close();
    }
  });
});
