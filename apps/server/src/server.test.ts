import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '@hangar/bridge';
import { Bus, FilePermissionStore } from '@hangar/bus';
import type { BayContext } from '@hangar/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { Workspaces } from '@hangar/host';
// The relay is an app of its own; its tests import it the same way.
import { startRelay } from '../../relay/src/relay';
import { startServer, type RunningServer } from './server';
import {
  bayRoot,
  dataWithDueJob,
  fixtureBays,
  hostModuleBayRoot,
  startBridge,
  waitForHealth,
} from './test-setup';

let server: RunningServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('startServer', () => {
  it('runs due jobs of the bays and shows the result in /health and jobs.json', async () => {
    const data = dataWithDueJob();
    const log: string[] = [];
    server = await startServer({
      data,
      host: '127.0.0.1',
      port: 0,
      roots: [],
      bays: [fixtureBays, hostModuleBayRoot()],
      tickMs: 50,
      log: (line) => log.push(line),
    });

    const health = await waitForHealth(server.url, (h) => !!h.jobs[0]?.lastRun);
    expect(health.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(health.bays).toEqual(
      expect.arrayContaining([
        { id: 'dev.hangar.jobtest', version: '0.1.0' },
        { id: 'dev.hangar.usesworkspaces', version: '0.1.0' },
      ]),
    );
    expect(health.errors).toEqual([
      expect.objectContaining({
        id: 'dev.hangar.usesbrowser',
        error: 'Host module "browser" is not available on the server',
      }),
    ]);
    expect(health.jobs).toEqual([
      expect.objectContaining({
        id: 'nightly',
        bayId: 'dev.hangar.jobtest',
        label: 'Nightly',
        lastRun: expect.objectContaining({ ok: true }),
      }),
    ]);
    // /health shows no job output: it may hold terminal content.
    expect(JSON.stringify(health)).not.toContain('done 1');
    const jobs = JSON.parse(readFileSync(join(data, 'jobs.json'), 'utf8'));
    expect(jobs[0].lastRun.output).toBe('done 1');

    expect(log).toContain(`listening on ${server.url}`);
    expect(log).toContain('bay dev.hangar.jobtest 0.1.0 loaded');
    expect(log.join('\n')).not.toContain('done 1');

    expect((await fetch(`${server.url}/other`)).status).toBe(404);
    expect((await fetch(`${server.url}/health`, { method: 'POST' })).status).toBe(404);
  });
});

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe('local server (ADR 0036)', () => {
  it('connects to the relay of its workspaces and keeps the keys without a keychain', async () => {
    const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const hello = new Promise<void>((resolve) =>
      relay.on('connection', (ws) => ws.on('message', () => resolve())),
    );
    await new Promise((r) => relay.once('listening', r));
    try {
      const data = mkdtempSync(join(tmpdir(), 'hangar-server-'));
      mkdirSync(join(data, 'workspaces'));
      writeFileSync(
        join(data, 'workspaces', 'workspaces.json'),
        JSON.stringify({
          relay: `ws://127.0.0.1:${(relay.address() as AddressInfo).port}`,
          workspaces: [],
          shared: {},
          waiting: {},
        }),
      );
      server = await start(data);
      await hello;
      const identity = JSON.parse(
        readFileSync(join(data, 'workspaces', 'relay-identity.json'), 'utf8'),
      ) as { keys: string };
      expect(identity.keys).toMatch(/^plain:/);
    } finally {
      relay.close();
    }
  });

  it('shows its workspaces to the paired desktop and tells it about changes', async () => {
    const data = mkdtempSync(join(tmpdir(), 'hangar-server-'));
    server = await start(data);
    const conn = await connect({ url: server.url.replace('http', 'ws') + '/connect' });
    try {
      await conn.pair(readFileSync(join(data, 'pair-code'), 'utf8'), 'Laptop');
      const changed = vi.fn();
      conn.onWorkspaces(changed);
      const view = (await conn.workspaces('view', [])) as { status: string; fingerprint: string };
      expect(view.status).toBe('off');
      expect(view.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      // A relay that is not there: the attempt fails and the status changes.
      await expect(conn.workspaces('connect', ['ws://127.0.0.1:1'])).rejects.toThrow();
      await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    } finally {
      conn.close();
    }
  });

  it('answers an instance of its workspaces through the relay, the desktop deciding (point 11)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hangar-relay-'));
    const relay = await startRelay({ file: join(root, 'relay.json'), operatorToken: 'op' });
    const notes = bayRoot(
      'dev.notes',
      `export default {
        async activate(ctx) {
          globalThis.__notesWorkspaces = !!ctx.workspaces;
          ctx.provide('note.read', () => 'hi');
        },
      };`,
    );
    const manifest = join(notes, 'dev.notes', 'manifest.json');
    writeFileSync(
      manifest,
      JSON.stringify({
        ...JSON.parse(readFileSync(manifest, 'utf8')),
        hostModules: ['workspaces'],
        functions: [{ name: 'note.read', sensitive: false, remote: true }],
      }),
    );
    const data = mkdtempSync(join(tmpdir(), 'hangar-server-'));
    server = await start(data, [notes]);
    const conn = await connect({ url: server.url.replace('http', 'ws') + '/connect' });
    const benBus = new Bus({
      permissions: new FilePermissionStore(join(root, 'ben-permissions.json')),
      prompter: { ask: async () => 'allow' },
      remote: { isMember: () => true, isShared: () => true },
    });
    const ben = new Workspaces({
      dir: join(root, 'ben'),
      name: 'ben',
      bus: benBus,
      protect: { encrypt: (t) => t, decrypt: (t) => t },
      onChange: () => {},
    });
    try {
      await conn.pair(readFileSync(join(data, 'pair-code'), 'utf8'), 'Laptop');
      conn.onAsk(async () => 'allow');
      expect((globalThis as Record<string, unknown>).__notesWorkspaces).toBe(true);
      await conn.workspaces('connect', [relay.url]);
      await conn.workspaces('create', ['team', 'op']);
      const invite = (await conn.workspaces('invite', ['team'])) as {
        token: string;
        fingerprint: string;
      };
      await ben.connect(relay.url);
      await ben.join('team', invite.token, invite.fingerprint);
      const benPrint = ben.view().fingerprint;
      await vi.waitFor(async () => {
        const view = (await conn.workspaces('view', [])) as {
          workspaces: { joined: { fingerprint: string }[] }[];
        };
        expect(view.workspaces[0]!.joined.map((j) => j.fingerprint)).toEqual([benPrint]);
      });
      await conn.workspaces('accept', ['team', benPrint]);
      await conn.workspaces('share', ['team', 'dev.notes/note.read', true]);
      const remote = () => benBus.list().find((f) => f.id.endsWith('/note.read'));
      await vi.waitFor(() => expect(remote()).toBeDefined(), { timeout: 5000 });
      const caller = { kind: 'bay' as const, bayId: 'dev.hangar.agents' };
      await expect(benBus.call(caller, remote()!.id, {})).resolves.toBe('hi');
    } finally {
      ben.close();
      conn.close();
      await relay.close();
    }
  });

  it('runs without workspaces while their keys are still in the keychain of the app', async () => {
    const data = mkdtempSync(join(tmpdir(), 'hangar-server-'));
    mkdirSync(join(data, 'workspaces'));
    writeFileSync(
      join(data, 'workspaces', 'relay-identity.json'),
      JSON.stringify({ document: {}, keys: 'safe:AAAA' }),
    );
    const log: string[] = [];
    server = await startServer({
      data,
      host: '127.0.0.1',
      port: 0,
      roots: [],
      bays: [],
      log: (line) => log.push(line),
    });
    expect(log).toContain(
      'workspaces not available: Keys are protected by the keychain of the app',
    );
  });

  const start = (data: string, bays: string[] = []) =>
    startServer({ data, host: '127.0.0.1', port: 0, roots: [], bays, log: () => {} });
  const listen = (data: string) =>
    JSON.parse(readFileSync(join(data, 'listen.json'), 'utf8')) as {
      port: number;
      fingerprint: string;
    };

  it('listens before the bays start and tells port and fingerprint in listen.json', async () => {
    const data = mkdtempSync(join(tmpdir(), 'hangar-local-'));
    // A bay whose start fails unless the server already answers on the port in listen.json.
    const bays = bayRoot(
      'dev.hangar.early',
      `import { readFileSync } from 'node:fs';
      export default {
        async activate() {
          const { port } = JSON.parse(readFileSync(${JSON.stringify(join(data, 'listen.json'))}, 'utf8'));
          const res = await fetch('http://127.0.0.1:' + port + '/health');
          if (res.status !== 200) throw new Error('not listening');
        },
      };`,
    );
    server = await start(data, [bays]);
    const health = await waitForHealth(server.url, () => true);
    expect(health.errors).toEqual([]);
    expect(health.bays).toEqual([{ id: 'dev.hangar.early', version: '0.1.0' }]);
    const { port, fingerprint } = listen(data);
    expect(server.url).toBe(`http://127.0.0.1:${port}`);
    const conn = await connect({ url: `ws://127.0.0.1:${port}/connect` });
    expect(conn.fingerprint).toBe(fingerprint);
    conn.close();
    // Windows has no POSIX file modes.
    if (process.platform !== 'win32')
      expect(statSync(join(data, 'listen.json')).mode & 0o777).toBe(0o600);
  });

  it('turns desktops away until the bays have started, so none sees an empty list', async () => {
    const data = mkdtempSync(join(tmpdir(), 'hangar-local-'));
    let open = () => {};
    (globalThis as { __serverGate?: Promise<void> }).__serverGate = new Promise<void>(
      (resolve) => (open = resolve),
    );
    const bays = bayRoot(
      'dev.hangar.slow',
      'export default { activate: () => globalThis.__serverGate };',
    );
    const starting = start(data, [bays]);
    await until(() => existsSync(join(data, 'listen.json')));
    const url = `ws://127.0.0.1:${listen(data).port}/connect`;
    await expect(connect({ url })).rejects.toThrow();
    open();
    server = await starting;
    const conn = await connect({ url });
    const token = await conn.pair(readFileSync(join(data, 'pair-code'), 'utf8'), 'Laptop');
    expect(token).toBeTruthy();
    expect(conn.bays).toEqual([{ id: 'dev.hangar.slow', version: '0.1.0' }]);
    conn.close();
  });

  it('keeps ELECTRON_RUN_AS_NODE of its LaunchAgent out of shells and jobs', async () => {
    // Electron in a shell (editors, other apps) would otherwise start as plain Node.
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      server = await start(mkdtempSync(join(tmpdir(), 'hangar-local-')));
      expect(process.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    } finally {
      delete process.env.ELECTRON_RUN_AS_NODE;
    }
  });

  it('encrypts its relay keys with HANGAR_KEY_PASSPHRASE and keeps it out of shells and jobs', async () => {
    process.env.HANGAR_KEY_PASSPHRASE = 'correct horse';
    try {
      const data = mkdtempSync(join(tmpdir(), 'hangar-local-'));
      server = await start(data);
      expect(process.env.HANGAR_KEY_PASSPHRASE).toBeUndefined();
      const { keys } = JSON.parse(
        readFileSync(join(data, 'workspaces', 'relay-identity.json'), 'utf8'),
      );
      expect(keys).toMatch(/^pass:/);
    } finally {
      delete process.env.HANGAR_KEY_PASSPHRASE;
    }
  });

  it('takes the port from listen.json again, and a free one when it is taken', async () => {
    const data = mkdtempSync(join(tmpdir(), 'hangar-local-'));
    server = await start(data);
    const { port } = listen(data);
    await server.close();
    server = await start(data);
    expect(listen(data).port).toBe(port);
    await server.close();
    // Another process holds the port now.
    const blocker = createNetServer();
    await new Promise<void>((r) => blocker.listen(port, '127.0.0.1', r));
    try {
      server = await start(data);
      expect(listen(data).port).not.toBe(port);
      expect(server.url).toBe(`http://127.0.0.1:${listen(data).port}`);
    } finally {
      blocker.close();
    }
  });
});

describe('host services on the server', () => {
  it('takes a checked path instead of the folder dialog and ends agent sessions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hangar-root-'));
    const g = globalThis as Record<string, unknown>;
    g.__probeRoot = root;
    const probe = bayRoot(
      'dev.probe',
      `export default {
        async activate(ctx) {
          ctx.notify({ title: 'x' });
          ctx.setBadge(1);
          ctx.ui.send('state', {});
          const ended = [];
          ctx.onAgentSessionEnded((s) => ended.push(s.sessionId));
          ctx.registerAgentSession('s1');
          globalThis.__probe = { ctx, ended, folder: await ctx.pickFolder({ path: globalThis.__probeRoot }) };
        },
      };`,
    );
    const broken = bayRoot(
      'dev.broken',
      `export default { activate() { throw new Error('kaputt'); } };`,
    );
    // A manifest that is no JSON: the error has no bay id.
    mkdirSync(join(broken, 'no-json'));
    writeFileSync(join(broken, 'no-json', 'manifest.json'), '{');
    // Without `log`, lines go to stdout.
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    server = await startServer({
      data: dataWithDueJob(),
      host: '127.0.0.1',
      port: 0,
      roots: [root],
      bays: [probe, broken],
    });
    const log = stdout.mock.calls.map(([line]) => line as string);
    stdout.mockRestore();
    expect(log).toContainEqual(expect.stringMatching(/^bay .*no-json not loaded: /));
    const probed = g.__probe as { ctx: BayContext; ended: string[]; folder: string };
    expect(probed.folder).toBe(realpathSync(root));
    probed.ctx.unregisterAgentSession('s1');
    expect(probed.ended).toEqual(['s1']);
    expect(log).toContain('bay dev.broken not loaded: Start failed: kaputt');
    // The job's bay is not loaded: it has not run.
    const health = await waitForHealth(server.url, () => true);
    expect(health.jobs[0]).not.toHaveProperty('lastRun');
  });
});

describe('permission questions on the server (phase 11b)', () => {
  it('denies without a desktop and stores nothing; a desktop that denies stores the denial', async () => {
    const file = join(dataWithDueJob(), 'permissions.json');
    const b = await startBridge();
    const bus = new Bus({
      permissions: new FilePermissionStore(file),
      prompter: { ask: (r) => b.bridge.ask(r) },
    });
    bus.register('dev.vault', { name: 'secret.read', sensitive: true }, async () => 'geheim');
    const agent = { kind: 'session', bayId: 'dev.hangar.agents', sessionId: 's1' } as const;
    bus.startSession('s1');
    try {
      await expect(bus.call(agent, 'dev.vault/secret.read', {})).rejects.toThrow(
        'Access denied: dev.hangar.agents → dev.vault/secret.read (no desktop connected to ask: set a rule in permissions.json)',
      );
      expect(bus.grants()).toEqual([]);
      bus.setMode('dev.hangar.agents', 'dev.vault/secret.read', 'allow');
      await expect(bus.call(agent, 'dev.vault/secret.read', {})).resolves.toBe('geheim');

      bus.revoke('dev.hangar.agents', 'dev.vault/secret.read');
      const conn = await connect({ url: b.url });
      await conn.pair(b.code(), 'Laptop');
      conn.onAsk(async () => 'deny');
      await expect(bus.call(agent, 'dev.vault/secret.read', {})).rejects.toThrow('denied');
      expect(bus.grants()).toMatchObject([{ subject: 'dev.hangar.agents', mode: 'deny' }]);
      conn.close();
    } finally {
      b.close();
    }
  });
});

describe('server jobs for the desktop (phase 11d)', () => {
  it('lists, pauses, runs and removes jobs for a paired desktop and reports changes', async () => {
    const log: string[] = [];
    server = await startServer({
      data: dataWithDueJob(),
      host: '127.0.0.1',
      port: 0,
      roots: [],
      bays: [fixtureBays],
      // No run of its own during the test.
      tickMs: 60_000,
      log: (line) => log.push(line),
    });
    const url = server.url.replace('http', 'ws') + '/connect';
    const code = log.findLast((l) => l.startsWith('pairing code '))!.slice('pairing code '.length);

    const stranger = await connect({ url });
    await expect(stranger.jobs()).rejects.toThrow('Not paired');
    await expect(stranger.job('run', 'nightly')).rejects.toThrow('Not paired');
    stranger.close();

    const conn = await connect({ url });
    await conn.pair(code, 'Laptop');
    const changes = vi.fn();
    conn.onJobs(changes);
    expect(await conn.jobs()).toEqual([
      expect.objectContaining({ id: 'nightly', label: 'Nightly', paused: false, available: true }),
    ]);
    await conn.job('pause', 'nightly');
    expect((await conn.jobs())[0]).toMatchObject({ paused: true });
    await conn.job('resume', 'nightly');
    expect((await conn.jobs())[0]).toMatchObject({ paused: false });
    await conn.job('run', 'nightly');
    expect((await conn.jobs())[0]).toMatchObject({ lastRun: { ok: true, output: 'done 1' } });
    await expect(conn.job('run', 'nope')).rejects.toThrow('Unknown job "nope"');
    await conn.job('remove', 'nightly');
    expect(await conn.jobs()).toEqual([]);
    await vi.waitFor(() => expect(changes.mock.calls.length).toBeGreaterThanOrEqual(4));
    conn.close();
  });
});

describe('bays of the desktop for agents of the local server (ADR 0036)', () => {
  const tab = {
    bayId: 'dev.hangar.browser',
    spec: { name: 'tab.open', sensitive: false, openToAgents: true },
  };
  // An agent bay that hands out the token of session s1 and ends it on `end`.
  const agentBay = () =>
    bayRoot(
      'dev.agents',
      `export default {
        activate(ctx) {
          const access = ctx.registerAgentSession('s1');
          ctx.setRunning(1);
          ctx.ui.handle('access', () => access);
          // The shell ended with exit; its session stays.
          ctx.ui.handle('exit', () => ctx.setRunning(0));
          ctx.ui.handle('end', () => ctx.unregisterAgentSession('s1'));
        },
      };`,
    );
  const mcp = async (access: { token: string; mcpUrl: string }, method: string, params = {}) => {
    const res = await fetch(access.mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${access.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return ((await res.json()) as { result: Record<string, unknown> }).result;
  };
  const tools = async (access: { token: string; mcpUrl: string }) =>
    ((await mcp(access, 'tools/list')).tools as { name: string }[]).map((t) => t.name);

  it('calls the offered functions on the desktop, keeps them over a restart and fails without it', async () => {
    const data = mkdtempSync(join(tmpdir(), 'hangar-local-'));
    const bays = agentBay();
    const log: string[] = [];
    const start = () =>
      startServer({
        data,
        host: '127.0.0.1',
        port: 0,
        roots: [],
        bays: [bays],
        log: (l) => log.push(l),
      });
    server = await start();
    const url = server.url.replace('http', 'ws') + '/connect';
    const conn = await connect({ url });
    await conn.pair(readFileSync(join(data, 'pair-code'), 'utf8'), 'Laptop');
    const calls: unknown[] = [];
    conn.onCall(async (...c) => (calls.push(c), { id: 't1' }));
    const ended = vi.fn();
    conn.onSessionEnded(ended);
    // A bay of the server keeps its own function; the desktop cannot take it over.
    await conn.offer([tab, { bayId: 'dev.agents', spec: { name: 'x', sensitive: false } }]);
    const access = (await conn.invoke('dev.agents', 'access', [])) as {
      token: string;
      mcpUrl: string;
    };
    expect(await tools(access)).toContain('dev.hangar.browser/tab.open');
    expect(await tools(access)).not.toContain('dev.agents/x');
    const result = await mcp(access, 'tools/call', {
      name: 'dev.hangar.browser/tab.open',
      arguments: { url: 'http://x' },
    });
    expect(result.content).toEqual([{ type: 'text', text: '{"id":"t1"}' }]);
    expect(calls).toEqual([
      [
        'dev.hangar.browser/tab.open',
        { url: 'http://x' },
        { bayId: 'dev.agents', sessionId: 's1' },
        expect.any(AbortSignal),
      ],
    ]);
    // The tray counts the running shells, not the sessions.
    await vi.waitFor(() => expect(conn.sessions).toBe(1));
    await conn.invoke('dev.agents', 'exit', []);
    await vi.waitFor(() => expect(conn.sessions).toBe(0));
    // An offer replaces the last one.
    await conn.offer([]);
    expect(await tools(access)).not.toContain('dev.hangar.browser/tab.open');
    await conn.offer([tab]);
    await conn.invoke('dev.agents', 'end', []);
    await vi.waitFor(() => expect(ended).toHaveBeenCalledWith('dev.agents', 's1'));
    conn.close();
    await server.close();

    // Started again without the desktop: the tools stay listed, a call says why it fails.
    process.env.HANGAR_LOCALE = 'de';
    try {
      server = await start();
      const again = await connect({ url: server.url.replace('http', 'ws') + '/connect' });
      await again.pair(readFileSync(join(data, 'pair-code'), 'utf8'), 'Laptop');
      const access2 = (await again.invoke('dev.agents', 'access', [])) as typeof access;
      again.close();
      expect(await tools(access2)).toContain('dev.hangar.browser/tab.open');
      const failed = await mcp(access2, 'tools/call', {
        name: 'dev.hangar.browser/tab.open',
        arguments: {},
      });
      expect(failed).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: 'Hangar ist nicht geöffnet' }],
      });
    } finally {
      delete process.env.HANGAR_LOCALE;
    }
  });

  it('offers functions only for bays to its bays, never to its agents (ADR 0021)', async () => {
    const data = mkdtempSync(join(tmpdir(), 'hangar-local-'));
    const target = 'dev.hangar.secrets/secret.resolve';
    const bays = bayRoot(
      'dev.agents',
      `export default {
        activate(ctx) {
          const access = ctx.registerAgentSession('s1');
          ctx.ui.handle('access', () => access);
          ctx.ui.handle('resolve', () => ctx.call('${target}', { names: ['TOKEN'] }));
        },
      };`,
      { uses: [target] },
    );
    server = await startServer({ data, host: '127.0.0.1', port: 0, roots: [], bays: [bays] });
    const conn = await connect({ url: server.url.replace('http', 'ws') + '/connect' });
    try {
      await conn.pair(readFileSync(join(data, 'pair-code'), 'utf8'), 'Laptop');
      const calls: unknown[] = [];
      conn.onCall(async (...c) => (calls.push(c.slice(0, 3)), { TOKEN: 'geheim' }));
      // The app checks, the server does not ask as well (ADR 0036, Nachtrag).
      const asked: unknown[] = [];
      conn.onAsk(async (request) => (asked.push(request), 'allow'));
      const secret = {
        bayId: 'dev.hangar.secrets',
        spec: { name: 'secret.resolve', sensitive: true, bayOnly: true },
      };
      await conn.offer([secret]);
      const access = (await conn.invoke('dev.agents', 'access', [])) as {
        token: string;
        mcpUrl: string;
      };
      expect(await tools(access)).not.toContain(target);
      expect(await mcp(access, 'tools/call', { name: target, arguments: {} })).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: expect.stringContaining('Access denied') }],
      });
      expect(await conn.invoke('dev.agents', 'resolve', [])).toEqual({ TOKEN: 'geheim' });
      expect(calls).toEqual([[target, { names: ['TOKEN'] }, { bayId: 'dev.agents' }]]);
      expect(asked).toEqual([]);
    } finally {
      conn.close();
    }
  });

  it('ignores a damaged file of offered functions', async () => {
    const data = mkdtempSync(join(tmpdir(), 'hangar-local-'));
    writeFileSync(join(data, 'desktop-functions.json'), '{');
    server = await startServer({
      data,
      host: '127.0.0.1',
      port: 0,
      roots: [],
      bays: [],
      log: () => {},
    });
    await server.close();
    // Entries in the wrong shape are left out; the LaunchAgent would restart it in a loop.
    writeFileSync(
      join(data, 'desktop-functions.json'),
      JSON.stringify([
        null,
        { bayId: 'x' },
        { bayId: 'dev.b', spec: { name: 'f', sensitive: false } },
        { bayId: 'dev.c', spec: { name: 'g', sensitive: true, bayOnly: 'ja' } },
      ]),
    );
    server = await startServer({
      data,
      host: '127.0.0.1',
      port: 0,
      roots: [],
      bays: [],
      log: () => {},
    });
    expect((await fetch(`${server.url}/health`)).status).toBe(200);
  });
});
