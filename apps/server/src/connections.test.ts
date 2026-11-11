import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerConnections } from '@hangar/bridge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunningServer } from './server';
import { startBridge, startEchoServer } from './test-setup';

const fakeSsh = join(__dirname, '../../../packages/bridge/fixtures/fake-ssh.mjs');

let server: RunningServer | undefined;
const opened: ServerConnections[] = [];
afterEach(async () => {
  for (const c of opened.splice(0)) c.closeAll();
  await server?.close();
  server = undefined;
});

const desktop = (
  file = join(mkdtempSync(join(tmpdir(), 'hangar-desktop-')), 'servers.json'),
  retryMs?: number,
  locale?: string,
  local?: ConstructorParameters<typeof ServerConnections>[2]['local'],
) => {
  const changed = vi.fn();
  const events: unknown[][] = [];
  const ask = vi.fn(async () => 'deny' as const);
  const notify = vi.fn();
  const jobs = vi.fn();
  const connections = new ServerConnections(
    file,
    { name: 'Laptop', locale },
    { changed, event: (...e) => events.push(e), ask, notify, jobs, local },
    fakeSsh,
    retryMs,
  );
  opened.push(connections);
  return { connections, changed, events, file, ask, notify, jobs };
};

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe('ServerConnections', () => {
  it('pairs after a probe, saves the server and forwards invoke and events', async () => {
    const s = await startEchoServer();
    server = s.server;
    const { connections, changed, events, file } = desktop();

    await expect(connections.probe('127.0.0.1:9')).rejects.toThrow(
      'Cannot reach ws://127.0.0.1:9/connect',
    );
    const probe = await connections.probe(s.address);
    expect(probe.fingerprint).toBe(s.fingerprint);
    await expect(connections.pair(probe.id, 'Heimserver', 'WRON-GCOD')).rejects.toThrow(
      'Wrong pairing code',
    );
    // The probe stays open for a second try.
    const id = await connections.pair(probe.id, 'Heimserver', s.code());
    await expect(connections.pair(probe.id, 'Heimserver', s.code())).rejects.toThrow(
      'Pairing has ended',
    );

    expect(connections.list()).toEqual([
      {
        id,
        name: 'Heimserver',
        status: 'connected',
        bays: [{ id: 'dev.echo', version: '0.1.0' }],
        // Filled as the server's badges arrive (phase 11c).
        badges: expect.any(Object),
      },
    ]);
    expect(changed).toHaveBeenCalled();
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved).toEqual([
      {
        id,
        name: 'Heimserver',
        url: `ws://${s.address}/connect`,
        fingerprint: s.fingerprint,
        token: expect.any(String),
      },
    ]);
    // Windows has no POSIX file modes.
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);

    await expect(connections.invoke(id, 'dev.echo', 'echo', [7])).resolves.toBe(7);
    expect(events).toEqual([[id, 'dev.echo', 'echoed', 7]]);
    await expect(connections.invoke('nope', 'dev.echo', 'echo', [])).rejects.toThrow(
      'Not connected: nope',
    );
  });

  it('connects saved servers again after a restart, and disconnects, reconnects and removes', async () => {
    const s = await startEchoServer();
    server = s.server;
    const first = desktop();
    const probe = await first.connections.probe(s.address);
    const id = await first.connections.pair(probe.id, 'Heimserver', s.code());
    first.connections.closeAll();

    const { connections, file } = desktop(first.file);
    expect(connections.list()[0]).toMatchObject({ id, status: 'disconnected', bays: [] });
    await connections.connectAll();
    expect(connections.list()[0]).toMatchObject({ status: 'connected' });

    connections.disconnect(id);
    expect(connections.list()[0]).toMatchObject({ status: 'disconnected', bays: [] });
    await connections.connect(id);
    expect(connections.list()[0]).toMatchObject({ status: 'connected' });

    connections.remove(id);
    expect(connections.list()).toEqual([]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('tells the server its language when pairing and connecting; the server keeps the last (ADR 0019)', async () => {
    const s = await startEchoServer();
    server = s.server;
    const port = Number(s.address.split(':')[1]);
    const first = desktop(undefined, undefined, 'en');
    const probe = await first.connections.probe(s.address);
    const id = await first.connections.pair(probe.id, 'Heimserver', s.code());
    await expect(first.connections.invoke(id, 'dev.echo', 'locale', [])).resolves.toBe('en');
    first.connections.closeAll();

    const second = desktop(first.file, undefined, 'de');
    await second.connections.connectAll();
    await expect(second.connections.invoke(id, 'dev.echo', 'locale', [])).resolves.toBe('de');
    second.connections.closeAll();

    // Kept across a restart; a desktop with an unknown language changes nothing.
    await server.close();
    server = (await startEchoServer(s.data, port)).server;
    const third = desktop(first.file, undefined, 'fr');
    await third.connections.connectAll();
    await expect(third.connections.invoke(id, 'dev.echo', 'locale', [])).resolves.toBe('de');
  });

  it('keeps a desktop language that matches its own until then, across a restart (Codex review)', async () => {
    const data = mkdtempSync(join(tmpdir(), 'hangar-bridge-'));
    writeFileSync(join(data, 'settings.json'), JSON.stringify({ language: 'de' }));
    const s = await startEchoServer(data);
    server = s.server;
    const port = Number(s.address.split(':')[1]);
    const first = desktop(undefined, undefined, 'de');
    const probe = await first.connections.probe(s.address);
    const id = await first.connections.pair(probe.id, 'Heimserver', s.code());
    first.connections.closeAll();

    await server.close();
    writeFileSync(join(data, 'settings.json'), JSON.stringify({ language: 'en' }));
    server = (await startEchoServer(data, port)).server;
    const second = desktop(first.file);
    await second.connections.connectAll();
    await expect(second.connections.invoke(id, 'dev.echo', 'locale', [])).resolves.toBe('de');
  });

  it('marks a server whose fingerprint changed as failed, and one that went away as disconnected', async () => {
    const s = await startEchoServer();
    server = s.server;
    const first = desktop();
    const probe = await first.connections.probe(s.address);
    const id = await first.connections.pair(probe.id, 'Heimserver', s.code());
    first.connections.closeAll();

    const saved = JSON.parse(readFileSync(first.file, 'utf8'));
    const forged = 'SHA256:' + 'A'.repeat(43);
    writeFileSync(first.file, JSON.stringify([{ ...saved[0], fingerprint: forged }]));
    const { connections } = desktop(first.file);
    await connections.connectAll();
    expect(connections.list()[0]).toMatchObject({
      status: 'failed',
      error: `Server fingerprint does not match: expected ${forged}, got ${s.fingerprint}`,
    });

    writeFileSync(first.file, JSON.stringify(saved));
    const again = desktop(first.file);
    await again.connections.connect(id);
    expect(again.connections.list()[0]).toMatchObject({ status: 'connected' });
    await server.close();
    server = undefined;
    await until(() => again.connections.list()[0]!.status === 'disconnected');
    expect(again.connections.list()[0]).toMatchObject({ status: 'disconnected', bays: [] });
  });

  it('keeps a disconnect, remove or quit that happens while connecting', async () => {
    const s = await startEchoServer();
    server = s.server;
    const first = desktop();
    const probe = await first.connections.probe(s.address);
    const id = await first.connections.pair(probe.id, 'Heimserver', s.code());
    first.connections.closeAll();

    const { connections } = desktop(first.file);
    const connecting = connections.connect(id);
    connections.disconnect(id);
    await connecting;
    expect(connections.list()[0]).toMatchObject({ status: 'disconnected', bays: [] });
    await expect(connections.invoke(id, 'dev.echo', 'echo', [1])).rejects.toThrow(
      `Not connected: ${id}`,
    );

    const quitting = connections.connect(id);
    connections.closeAll();
    await quitting;
    expect(connections.list()[0]).toMatchObject({ status: 'disconnected' });

    const removing = connections.connect(id);
    connections.remove(id);
    await removing;
    expect(connections.list()).toEqual([]);
  });

  it('connects again after the server went away, also when the first attempts fail', async () => {
    const s = await startEchoServer();
    server = s.server;
    const port = Number(s.address.split(':')[1]);
    const { connections } = desktop(undefined, 20);
    const probe = await connections.probe(s.address);
    const id = await connections.pair(probe.id, 'Heimserver', s.code());

    await server.close();
    server = undefined;
    await until(() => connections.list()[0]!.status === 'failed');
    expect(connections.list()[0]!.error).toBe(`Cannot reach ws://${s.address}/connect`);

    server = (await startEchoServer(s.data, port)).server;
    await until(() => connections.list()[0]!.status === 'connected');
    await expect(connections.invoke(id, 'dev.echo', 'echo', [3])).resolves.toBe(3);
  });

  it('counts the reconnect attempts until it is connected again', async () => {
    const s = await startEchoServer();
    server = s.server;
    const port = Number(s.address.split(':')[1]);
    const { connections } = desktop(undefined, 20);
    const probe = await connections.probe(s.address);
    const id = await connections.pair(probe.id, 'Heimserver', s.code());
    expect(connections.list()[0]!.retry).toBeUndefined();

    await server.close();
    server = undefined;
    await until(() => (connections.list()[0]!.retry ?? 0) >= 3);
    expect(connections.list()[0]!.retry).toBeGreaterThanOrEqual(3);
    expect(connections.list()[0]!.status).not.toBe('connected');

    server = (await startEchoServer(s.data, port)).server;
    await until(() => connections.list()[0]!.status === 'connected');
    expect(connections.list()[0]!.retry).toBeUndefined();
    connections.disconnect(id);
    expect(connections.list()[0]!.retry).toBeUndefined();
  });

  it('names the next attempt while it waits, and none once it gives up (Codex review)', async () => {
    const s = await startEchoServer();
    server = s.server;
    const port = Number(s.address.split(':')[1]);
    const { connections, changed } = desktop(undefined, 20);
    const probe = await connections.probe(s.address);
    await connections.pair(probe.id, 'Heimserver', s.code());
    const seen: { status: string; retry?: number }[] = [];
    changed.mockImplementation(() => {
      const { status, retry } = connections.list()[0]!;
      seen.push({ status, retry });
    });

    await server.close();
    server = undefined;
    await until(() => seen.filter((v) => v.status === 'connecting').length >= 3);
    // Every pause already names the attempt that follows it.
    const down = seen.slice(seen.findIndex((v) => v.status !== 'connected'));
    expect(down[0]).toEqual({ status: 'disconnected', retry: 1 });
    for (const [i, view] of down.entries()) {
      if (view.status === 'connecting') expect(view.retry).toBe(down[i - 1]!.retry);
    }

    // Another server on the port: rejected for good, no attempt follows.
    server = (await startEchoServer(undefined, port)).server;
    await until(() => connections.list()[0]!.error?.startsWith('Server fingerprint') ?? false);
    expect(connections.list()[0]).toMatchObject({ status: 'failed' });
    expect(connections.list()[0]!.retry).toBeUndefined();
  });

  it('tries no more after a disconnect, a remove or a rejected key', async () => {
    const s = await startEchoServer();
    server = s.server;
    const port = Number(s.address.split(':')[1]);
    const { connections, file } = desktop(undefined, 20);
    const probe = await connections.probe(s.address);
    const id = await connections.pair(probe.id, 'Heimserver', s.code());
    const settled = async () => {
      server = (await startEchoServer(s.data, port)).server;
      await new Promise((r) => setTimeout(r, 200));
    };

    await server.close();
    await until(() => connections.list()[0]!.status === 'failed');
    connections.disconnect(id);
    await settled();
    expect(connections.list()[0]).toMatchObject({ status: 'disconnected' });

    await connections.connect(id);
    await server!.close();
    await until(() => connections.list()[0]!.status === 'failed');
    connections.remove(id);
    await settled();
    expect(connections.list()).toEqual([]);

    // A server with another key, or one that no longer knows the token, is not retried.
    const saved = { id: 'a', name: 'Heimserver', url: `ws://${s.address}/connect` };
    for (const [entry, error] of [
      [{ ...saved, fingerprint: 'SHA256:x', token: 't' }, 'Server fingerprint does not match'],
      [{ ...saved, fingerprint: s.fingerprint, token: 'wrong' }, 'Invalid token'],
    ] as const) {
      writeFileSync(file, JSON.stringify([entry]));
      const again = desktop(file, 20);
      await again.connections.connect('a');
      const calls = again.changed.mock.calls.length;
      await new Promise((r) => setTimeout(r, 200));
      expect(again.connections.list()[0]).toMatchObject({
        status: 'failed',
        error: expect.stringContaining(error),
      });
      expect(again.changed.mock.calls.length).toBe(calls);
    }
  });

  it('passes a permission question of the server on with its id and returns the answer', async () => {
    const b = await startBridge();
    try {
      const { connections, ask } = desktop();
      ask.mockResolvedValueOnce('session' as never);
      const probe = await connections.probe(b.url.slice('ws://'.length, -'/connect'.length));
      const id = await connections.pair(probe.id, 'Heimserver', b.code());
      const request = {
        caller: { kind: 'session', bayId: 'dev.hangar.agents', sessionId: 's1' },
        target: 'dev.hangar.vault/secret.read',
        sensitive: true,
        kind: 'grant',
      } as const;
      await expect(b.bridge.ask(request)).resolves.toBe('session');
      expect(ask).toHaveBeenCalledWith(id, request, expect.any(AbortSignal));
    } finally {
      b.close();
    }
  });

  it('passes on notifications kept while no desktop was connected, and the badges', async () => {
    const s = await startEchoServer();
    server = s.server;
    const { connections, notify, changed } = desktop();
    const probe = await connections.probe(s.address);
    const id = await connections.pair(probe.id, 'Heimserver', s.code());
    await until(() => notify.mock.calls.length > 0);
    expect(notify).toHaveBeenCalledWith(id, 'dev.echo', { title: 'started' });
    await until(() => connections.list()[0]!.badges['dev.echo'] === 1);
    expect(connections.list()[0]).toMatchObject({ status: 'connected', badges: { 'dev.echo': 1 } });
    expect(changed).toHaveBeenCalled();
    connections.disconnect(id);
    expect(connections.list()[0]!.badges).toEqual({});
  });

  it('lists and changes the jobs of a connected server (phase 11d)', async () => {
    const s = await startEchoServer();
    server = s.server;
    const { connections } = desktop();
    await expect(connections.jobs('nope')).rejects.toThrow('Not connected: nope');
    await expect(connections.job('nope', 'run', 'x')).rejects.toThrow('Not connected: nope');
    const probe = await connections.probe(s.address);
    const id = await connections.pair(probe.id, 'Heimserver', s.code());
    await expect(connections.jobs(id)).resolves.toEqual([]);
    await expect(connections.job(id, 'remove', 'x')).rejects.toThrow('Unknown job "x"');
  });

  it('gives up on server jobs without an answer and rejects a list that is none (Codex 11d)', async () => {
    for (const [jobs, error] of [
      [() => new Promise(() => {}), 'No answer from the server within 0.1 s'],
      [() => ({}), 'Invalid message from the server'],
      [() => [null], 'Invalid message from the server'],
      [() => [{ id: 'j', label: 'x', lastRun: { at: 'bald' } }], 'Invalid message from the server'],
      [
        () => [
          {
            ...{ id: 'j', bayId: 'b', label: 'x', schedule: '* * * * *' },
            ...{ paused: false, running: false, available: true, nextRun: 1e20 },
          },
        ],
        'Invalid message from the server',
      ],
    ] as const) {
      const b = await startBridge(undefined, [], jobs);
      try {
        const { connections } = desktop();
        const probe = await connections.probe(b.url.slice('ws://'.length, -'/connect'.length));
        const id = await connections.pair(probe.id, 'Heimserver', b.code());
        await expect(connections.jobs(id, 100)).rejects.toThrow(error);
        // A request given up on is not kept until the connection ends.
        const live = (connections as unknown as { live: Map<string, { connection: object }> }).live;
        const pending = (live.get(id)!.connection as unknown as { pending: Map<number, unknown> })
          .pending;
        expect(pending.size).toBe(0);
      } finally {
        b.close();
      }
    }
  });

  it('cancels a probe', async () => {
    const s = await startEchoServer();
    server = s.server;
    const { connections } = desktop();
    const probe = await connections.probe(s.address);
    connections.cancel(probe.id);
    await expect(connections.pair(probe.id, 'x', s.code())).rejects.toThrow('Pairing has ended');
  });

  // The fake ssh is a script with a shebang, which Windows cannot start.
  it.skipIf(process.platform === 'win32')(
    'reaches a server through an SSH tunnel, also after a restart',
    async () => {
      const s = await startEchoServer();
      server = s.server;
      const port = Number(s.address.split(':')[1]);
      const first = desktop();
      const probe = await first.connections.probe(`anna@heimserver:${port}`);
      expect(probe.fingerprint).toBe(s.fingerprint);
      const id = await first.connections.pair(probe.id, 'Heimserver', s.code());
      await expect(first.connections.invoke(id, 'dev.echo', 'echo', [1])).resolves.toBe(1);
      expect(JSON.parse(readFileSync(first.file, 'utf8'))[0]).toEqual({
        id,
        name: 'Heimserver',
        ssh: { user: 'anna', host: 'heimserver', port },
        fingerprint: s.fingerprint,
        token: expect.any(String),
      });
      first.connections.closeAll();

      const { connections } = desktop(first.file);
      await connections.connectAll();
      expect(connections.list()[0]).toMatchObject({ status: 'connected' });
      await expect(connections.invoke(id, 'dev.echo', 'echo', [2])).resolves.toBe(2);
    },
  );

  // The fake ssh is a script with a shebang, which Windows cannot start.
  it.skipIf(process.platform === 'win32')('names what ssh said when the tunnel fails', async () => {
    const { connections, file } = desktop();
    await expect(connections.probe('unreachable.invalid:7420')).rejects.toThrow(
      'SSH failed: ssh: Could not resolve hostname unreachable.invalid',
    );
    await expect(connections.probe('-oProxyCommand=x:7420')).rejects.toThrow(
      'Invalid address: -oProxyCommand=x:7420',
    );
    const saved = { id: 'a', name: 'Weg', fingerprint: 'SHA256:x', token: 't' };
    writeFileSync(
      file,
      JSON.stringify([{ ...saved, ssh: { host: 'unreachable.invalid', port: 1 } }]),
    );
    const again = desktop(file);
    await again.connections.connectAll();
    expect(again.connections.list()[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('SSH failed: ssh: Could not resolve hostname'),
    });
  });
});

describe('ServerConnections: the local server (ADR 0036)', () => {
  it('pairs once without a typed code and follows the port in listen.json', async () => {
    const s = await startEchoServer();
    server = s.server;
    const { connections, file } = desktop(undefined, 20);
    const id = await connections.pairLocal(s.data, 'Lokal');
    expect(connections.list()).toEqual([
      expect.objectContaining({ id, name: 'Lokal', status: 'connected', local: true }),
    ]);
    await expect(connections.invoke(id, 'dev.echo', 'echo', [1])).resolves.toBe(1);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved).toEqual([
      expect.objectContaining({ id, local: s.data, fingerprint: s.fingerprint }),
    ]);
    expect(saved[0].url).toBeUndefined();
    // Already paired: no second entry, no new code used up.
    const code = s.code();
    await expect(connections.pairLocal(s.data, 'Lokal')).resolves.toBe(id);
    expect(s.code()).toBe(code);
    expect(connections.list()).toHaveLength(1);

    // The server comes back on another port: the desktop reads it from listen.json.
    const { port } = JSON.parse(readFileSync(join(s.data, 'listen.json'), 'utf8'));
    await server.close();
    const blocker = await startEchoServer(undefined, port);
    try {
      server = (await startEchoServer(s.data)).server;
      expect(server.url).not.toBe(`http://127.0.0.1:${port}`);
      await until(() => connections.list()[0]!.status === 'connected');
      await expect(connections.invoke(id, 'dev.echo', 'echo', [2])).resolves.toBe(2);
    } finally {
      await blocker.server.close();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'pairs with a server set up over ssh and reads its port there before each connect',
    async () => {
      // ADR 0041: key and code come over ssh (here: fake-ssh runs the command on this machine).
      const s = await startEchoServer();
      server = s.server;
      const { connections, file } = desktop(undefined, 20);
      const { port, fingerprint } = JSON.parse(readFileSync(join(s.data, 'listen.json'), 'utf8'));
      const setup = {
        remoteData: s.data,
        port,
        fingerprint,
        code: s.code(),
        linger: true,
        user: 'anna',
        build: 'b',
      };
      // A wrong code: the connection closes and nothing is stored.
      await expect(
        connections.pairSetUp({ host: 'heimserver' }, 'Heimserver', {
          ...setup,
          code: 'XXXX-XXXX',
        }),
      ).rejects.toThrow();
      expect(connections.list()).toEqual([]);
      const id = await connections.pairSetUp({ host: 'heimserver' }, 'Heimserver', setup);
      await expect(connections.invoke(id, 'dev.echo', 'echo', [1])).resolves.toBe(1);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([
        expect.objectContaining({ id, remoteData: s.data, ssh: { host: 'heimserver', port } }),
      ]);
      // Set up again: the same entry, no new code used up.
      const code = s.code();
      await expect(
        connections.pairSetUp({ host: 'heimserver' }, 'Heimserver', setup),
      ).resolves.toBe(id);
      expect(s.code()).toBe(code);
      // Its clients are gone (a new data folder keeps no token): pairs again, same ID (Codex).
      await server.close();
      rmSync(join(s.data, 'clients.json'), { force: true });
      const again = await startEchoServer(s.data);
      server = again.server;
      const { port: newPort } = JSON.parse(readFileSync(join(s.data, 'listen.json'), 'utf8'));
      const token = JSON.parse(readFileSync(file, 'utf8'))[0].token;
      await expect(
        connections.pairSetUp({ host: 'heimserver' }, 'Anders', {
          ...setup,
          port: newPort,
          code: again.code(),
        }),
      ).resolves.toBe(id);
      await expect(connections.invoke(id, 'dev.echo', 'echo', [3])).resolves.toBe(3);
      const [entry] = JSON.parse(readFileSync(file, 'utf8'));
      expect(entry).toMatchObject({ id, name: 'Heimserver' });
      expect(entry.token).not.toBe(token);
      // The server comes back on another port: read from listen.json over ssh.
      await server.close();
      const blocker = await startEchoServer(undefined, port);
      try {
        server = (await startEchoServer(s.data)).server;
        await until(() => connections.list()[0]!.status === 'connected');
        await expect(connections.invoke(id, 'dev.echo', 'echo', [2])).resolves.toBe(2);
      } finally {
        await blocker.server.close();
      }
    },
  );

  it('keeps servers.json valid and every change when pairing and connecting run in parallel', async () => {
    const local = await startEchoServer();
    server = local.server;
    const remote = await startEchoServer();
    try {
      const { file } = desktop();
      const saved = { id: 'old', name: 'Alt', url: 'ws://127.0.0.1:9/connect' };
      writeFileSync(file, JSON.stringify([{ ...saved, fingerprint: 'SHA256:x', token: 't' }]));
      const { connections } = desktop(file);
      const probe = await connections.probe(remote.address);
      const [, paired, pairedLocal] = await Promise.all([
        connections.connectAll(),
        connections.pair(probe.id, 'Heimserver', remote.code()),
        connections.pairLocal(local.data, 'Lokal'),
      ]);
      const ids = JSON.parse(readFileSync(file, 'utf8')).map((s: { id: string }) => s.id);
      expect(ids.sort()).toEqual(['old', paired, pairedLocal].sort());
    } finally {
      await remote.server.close();
    }
  });

  it('connects again when paired already but no attempt runs, e.g. after a rejected version', async () => {
    // A rejected protocol version ends the retries; restarting the server pairs again (Codex 4a).
    const s = await startEchoServer();
    server = s.server;
    const { connections } = desktop(undefined, 20);
    const id = await connections.pairLocal(s.data, 'Lokal');
    connections.disconnect(id);
    await expect(connections.pairLocal(s.data, 'Lokal')).resolves.toBe(id);
    await until(() => connections.list()[0]!.status === 'connected');
    expect(connections.list()[0]!.status).toBe('connected');
  });

  it('keeps trying while another server holds the old port, until its own is back', async () => {
    // Anyone on this machine can listen on the port listen.json still names (Codex step 1).
    const s = await startEchoServer();
    server = s.server;
    const { connections } = desktop(undefined, 20);
    const id = await connections.pairLocal(s.data, 'Lokal');
    const { port } = JSON.parse(readFileSync(join(s.data, 'listen.json'), 'utf8'));
    await server.close();
    server = (await startEchoServer(undefined, port)).server;
    await until(
      () => !!connections.list()[0]!.error?.startsWith('Server fingerprint does not match'),
    );
    await server.close();
    server = (await startEchoServer(s.data)).server;
    await until(() => connections.list()[0]!.status === 'connected');
    await expect(connections.invoke(id, 'dev.echo', 'echo', [3])).resolves.toBe(3);
  });

  it('pairs only with the key named in listen.json', async () => {
    const s = await startEchoServer();
    server = s.server;
    const listen = join(s.data, 'listen.json');
    const real = JSON.parse(readFileSync(listen, 'utf8'));
    writeFileSync(listen, JSON.stringify({ ...real, fingerprint: 'SHA256:other' }));
    const { connections, file } = desktop();
    const code = s.code();
    await expect(connections.pairLocal(s.data, 'Lokal')).rejects.toThrow(
      'Server fingerprint does not match',
    );
    // The code did not leave the desktop.
    expect(s.code()).toBe(code);
    expect(() => readFileSync(file)).toThrow();
  });
});

describe('ServerConnections and the bays of this desktop (ADR 0036)', () => {
  it('runs the settings of the workspaces on the local server and hears of changes (point 11)', async () => {
    const calls: unknown[] = [];
    const b = await startBridge(undefined, [], undefined, undefined, async (action, args) => {
      calls.push([action, args]);
      return 'ok';
    });
    try {
      const listen = { port: b.port, fingerprint: b.bridge.fingerprint };
      writeFileSync(join(b.dataDir, 'listen.json'), JSON.stringify(listen));
      const workspaces = vi.fn();
      const { connections } = desktop(undefined, undefined, undefined, {
        functions: () => [],
        call: vi.fn(),
        sessionEnded: vi.fn(),
        workspaces,
      });
      const id = await connections.pairLocal(b.dataDir, 'Lokal');
      await expect(connections.workspaces(id, 'invite', ['team'])).resolves.toBe('ok');
      expect(calls).toEqual([['invite', ['team']]]);
      b.bridge.workspacesChanged();
      await until(() => workspaces.mock.calls.length > 0);
      expect(workspaces).toHaveBeenCalled();
    } finally {
      b.close();
    }
  });

  it('offers them to the local server only, runs its calls and hears of ended sessions', async () => {
    const tab = { bayId: 'dev.hangar.browser', spec: { name: 'tab.open', sensitive: false } };
    const offers: unknown[] = [];
    const b = await startBridge(undefined, [], undefined, (f) => offers.push(f));
    try {
      const listen = { port: b.port, fingerprint: b.bridge.fingerprint };
      writeFileSync(join(b.dataDir, 'listen.json'), JSON.stringify(listen));
      let functions = [tab];
      const call = vi.fn(async () => 'ok');
      const sessionEnded = vi.fn();
      const { connections } = desktop(undefined, undefined, undefined, {
        functions: () => functions,
        call,
        sessionEnded,
        workspaces: vi.fn(),
      });
      // Paired by address, the same server gets nothing.
      const probe = await connections.probe(`127.0.0.1:${b.port}`);
      await connections.pair(probe.id, 'Fern', b.code());
      await new Promise((r) => setTimeout(r, 50));
      expect(offers).toEqual([]);

      await connections.pairLocal(b.dataDir, 'Lokal');
      await until(() => offers.length > 0);
      expect(offers).toEqual([[tab]]);
      const caller = { bayId: 'dev.hangar.agents', sessionId: 's1' };
      await expect(
        b.bridge.call('dev.hangar.browser/tab.open', { url: 'x' }, caller),
      ).resolves.toBe('ok');
      expect(call).toHaveBeenCalledWith(
        'dev.hangar.browser/tab.open',
        { url: 'x' },
        caller,
        expect.any(AbortSignal),
      );
      b.bridge.sessionEnded('dev.hangar.agents', 's1');
      await until(() => sessionEnded.mock.calls.length > 0);
      expect(sessionEnded).toHaveBeenCalledWith('dev.hangar.agents', 's1');

      // The tray shows how many shells run there.
      b.bridge.sessions(4);
      await until(() => connections.list().some((s) => s.sessions === 4));
      expect(connections.list().find((s) => s.local)).toMatchObject({ sessions: 4 });

      functions = [];
      connections.offerAgain();
      await until(() => offers.length > 1);
      expect(offers).toEqual([[tab], []]);
    } finally {
      b.close();
    }
  });
});
