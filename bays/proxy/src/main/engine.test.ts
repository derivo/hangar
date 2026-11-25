import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { Ca } from './ca';
import { findMitmdump, MitmEngine, supported, type EngineStatus } from './engine';
import type { AddonEvent } from './protocol';

interface Command {
  id: number;
  op: string;
  [key: string]: unknown;
}

/** A mitmdump with the addon: answers every command unless told otherwise. */
class FakeMitmdump extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  commands: Command[] = [];
  failing = new Set<string>();
  /** Ops whose replies wait in `held` until called. */
  holding = new Set<string>();
  held: (() => void)[] = [];
  signals: (string | undefined)[] = [];
  constructor(readonly args: string[]) {
    super();
    let buf = '';
    this.stdin.setEncoding('utf8').on('data', (d: string) => {
      buf += d;
      for (let i = buf.indexOf('\n'); i !== -1; i = buf.indexOf('\n')) {
        const cmd = JSON.parse(buf.slice(0, i)) as Command;
        buf = buf.slice(i + 1);
        this.commands.push(cmd);
        const ok = !this.failing.has(cmd.op);
        const reply = () =>
          this.send({
            type: 'reply',
            id: cmd.id,
            ok,
            ...(ok ? {} : { error: `${cmd.op} failed` }),
          });
        if (this.holding.has(cmd.op)) this.held.push(reply);
        else reply();
      }
    });
    // The addon shuts mitmdump down when stdin ends.
    this.stdin.on('finish', () => setImmediate(() => this.emit('exit', 0, null)));
  }
  send(obj: unknown) {
    this.stdout.write(`${JSON.stringify(obj)}\n`);
  }
  hello(version = '12.3.1') {
    this.send({ type: 'hello', version });
  }
  kill(signal?: string) {
    this.signals.push(signal);
    setImmediate(() => this.emit('exit', null, signal ?? 'SIGTERM'));
    return true;
  }
  crash(message = 'Traceback: boom') {
    this.stderr.write(`${message}\n`);
    setImmediate(() => this.emit('exit', 1, null));
  }
}

const tick = () => new Promise((r) => setImmediate(r));
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await tick();
  expect(check()).toBe(true);
}

function setup(
  opts: {
    autoHello?: string | false;
    find?: (s: string) => string;
    onSpawn?: (child: FakeMitmdump) => void;
  } = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'hangar-proxy-engine-'));
  const ca = new Ca(dataDir, () => 'ROOTS\n');
  const children: FakeMitmdump[] = [];
  const statuses: EngineStatus[] = [];
  const events: AddonEvent[] = [];
  const log = vi.fn();
  let setting = '';
  const engine = new MitmEngine({
    ca,
    addonPath: '/app/addon/hangar_proxy.py',
    mitmdumpPath: () => setting,
    upstreamCaFile: () => '',
    log,
    find: opts.find ?? (() => '/bin/mitmdump'),
    spawn: (command, args) => {
      const child = new FakeMitmdump([command, ...args]);
      children.push(child);
      opts.onSpawn?.(child);
      if (opts.autoHello !== false) setImmediate(() => child.hello(opts.autoHello || '12.3.1'));
      return child as unknown as ChildProcess;
    },
  });
  engine.onStatus((s) => statuses.push(s));
  engine.onEvent((e) => events.push(e));
  const last = () => children.at(-1)!;
  return {
    engine,
    ca,
    children,
    statuses,
    events,
    log,
    last,
    setSetting: (s: string) => (setting = s),
  };
}

afterEach(() => vi.useRealTimers());

describe('MitmEngine', () => {
  it('starts mitmdump with the addon, loopback only and no default listener', async () => {
    const { engine, last, ca } = setup();
    await engine.start();
    const args = last().args;
    expect(args.slice(0, 3)).toEqual(['/bin/mitmdump', '-s', '/app/addon/hangar_proxy.py']);
    for (const set of [
      `confdir=${ca.confdir}`,
      'listen_host=127.0.0.1',
      'server=false',
      'flow_detail=0',
      'termlog_verbosity=error',
      'show_ignored_hosts=true',
      `ssl_verify_upstream_trusted_ca=${join(ca.dataDir, 'upstream.pem')}`,
    ])
      expect(args[args.indexOf(set) - 1]).toBe('--set');
    expect(args).not.toContain('ssl_insecure=true');
    expect(engine.status()).toMatchObject({ state: 'running', version: '12.3.1', reason: null });
  });

  it('starts only once for concurrent callers', async () => {
    const { engine, children } = setup();
    await Promise.all([engine.start(), engine.start(), engine.listen(4001, 'pw')]);
    await engine.start();
    expect(children).toHaveLength(1);
  });

  it('fails with the reason when mitmdump is missing', async () => {
    const { engine, children } = setup({
      find: () => {
        throw new Error('mitmdump not found: install mitmproxy (uv tool install mitmproxy)');
      },
    });
    await expect(engine.listen(4001, 'pw')).rejects.toThrow('mitmdump not found');
    expect(engine.status()).toMatchObject({
      state: 'failed',
      reason: expect.stringMatching(/^mitmdump not found/),
    });
    expect(children).toHaveLength(0);
  });

  it('refuses an unsupported mitmproxy version and does not restart', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { engine, children } = setup({ autoHello: '13.0.0' });
    await expect(engine.start()).rejects.toThrow(
      'mitmproxy 13.0.0 is not supported (needs >=12.3,<13)',
    );
    await tick();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(1);
    expect(children[0]!.signals).toEqual([undefined]);
    expect(engine.status().state).toBe('failed');
  });

  it('binds lazily and forgets a listener that failed', async () => {
    const { engine, last, children } = setup();
    expect(children).toHaveLength(0);
    await engine.listen(4001, 'secret');
    expect(last().commands).toEqual([{ id: 1, op: 'listen', port: 4001, password: 'secret' }]);
    last().failing.add('listen');
    await expect(engine.listen(4002, 'x')).rejects.toThrow('listen failed');
    expect(engine.status().listeners).toBe(1);
  });

  it('forwards capture, ignore and unlisten to the addon', async () => {
    const { engine, last } = setup();
    await engine.setCapture(false); // before the start: only remembered
    await engine.listen(4001, 'pw');
    await engine.setCapture(true);
    await engine.ignore(['^pinned\\.example:443$']);
    await engine.unlisten(4001);
    expect(last().commands.map(({ id: _, ...c }) => c)).toEqual([
      { op: 'capture', on: false },
      { op: 'listen', port: 4001, password: 'pw' },
      { op: 'capture', on: true },
      { op: 'ignore', hosts: ['^pinned\\.example:443$'] },
      { op: 'unlisten', port: 4001 },
    ]);
    expect(engine.status().listeners).toBe(0);
  });

  it('hands addon events on, but not the hello', async () => {
    const { engine, last, events } = setup();
    await engine.start();
    last().send({ type: 'flow.error', id: 'f1', error: 'connection refused' });
    last().send({ type: 'bogus' });
    await until(() => events.length === 1);
    expect(events).toEqual([{ type: 'flow.error', id: 'f1', error: 'connection refused' }]);
    expect(engine.status().warnings.unknown).toBe(1);
  });

  it('restarts after a crash with backoff 1 s, 5 s, 30 s and the same listeners', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { engine, children, last, log } = setup();
    await engine.listen(4001, 'a');
    await engine.listen(4002, 'b');
    await engine.setCapture(false);
    await engine.ignore(['^x:1$']);

    for (const [n, delay] of [
      [2, 1000],
      [3, 5000],
      [4, 30_000],
      [5, 30_000],
    ] as const) {
      last().crash();
      await until(() => engine.status().state === 'restarting');
      expect(engine.status().reason).toBe('mitmdump exited (1): Traceback: boom');
      await expect(engine.listen(4003, 'c')).rejects.toThrow('The proxy engine is restarting');
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(children).toHaveLength(n - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(children).toHaveLength(n);
      await until(() => engine.status().state === 'running');
      // Pause and pass-through hold before the first client can connect again.
      expect(last().commands.map(({ id: _, ...c }) => c)).toEqual([
        { op: 'capture', on: false },
        { op: 'ignore', hosts: ['^x:1$'] },
        { op: 'listen', port: 4001, password: 'a' },
        { op: 'listen', port: 4002, password: 'b' },
      ]);
    }
    expect(log).toHaveBeenCalledWith('mitmdump exited (1): Traceback: boom; restarting in 30 s');

    // A run of a minute counts as stable: the next crash waits 1 s again.
    await vi.advanceTimersByTimeAsync(60_000);
    last().crash();
    await until(() => engine.status().state === 'restarting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(children).toHaveLength(6);
  });

  it('drops a listener the restarted engine cannot bind again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { engine, last, log, children } = setup({
      // The port is taken by now.
      onSpawn: (child) => children.length > 1 && child.failing.add('listen'),
    });
    await engine.listen(4001, 'a');
    last().crash();
    await until(() => engine.status().state === 'restarting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(children).toHaveLength(2);
    await until(() => engine.status().state === 'running');
    expect(engine.status().listeners).toBe(0);
    expect(log).toHaveBeenCalledWith('listener 4001 lost after restart: listen failed');
  });

  it('retries a start that died before its hello', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { engine, children } = setup({ autoHello: false });
    const first = engine.start();
    const failed = expect(first).rejects.toThrow('mitmdump exited (1): No module named mitmproxy');
    children[0]!.crash('No module named mitmproxy');
    await failed;
    expect(engine.status().state).toBe('restarting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(children).toHaveLength(2);
    children[1]!.hello();
    await until(() => engine.status().state === 'running');
  });

  it('gives up waiting for the hello after 20 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { engine, children } = setup({ autoHello: false });
    const check = expect(engine.start()).rejects.toThrow('mitmdump did not start within 20 s');
    await vi.advanceTimersByTimeAsync(20_000);
    await check;
    expect(children[0]!.signals).toEqual([undefined]);
  });

  it('reports a spawn error', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hangar-proxy-engine-'));
    const engine = new MitmEngine({
      ca: new Ca(dataDir, () => 'ROOTS\n'),
      addonPath: 'addon.py',
      mitmdumpPath: () => '',
      upstreamCaFile: () => '',
      find: () => join(dataDir, 'no-such-mitmdump'),
    });
    await expect(engine.start()).rejects.toThrow(/ENOENT/);
    await engine.stop();
    expect(engine.status().state).toBe('stopped');
  });

  it('stops by closing stdin and kills after 5 s', async () => {
    const { engine, last, statuses } = setup();
    await engine.start();
    await engine.stop();
    expect(engine.status().state).toBe('stopped');
    expect(statuses.map((s) => s.state)).toEqual(['starting', 'running', 'stopped']);
    await engine.stop();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await engine.start();
    last().stdin.removeAllListeners('finish'); // hangs on shutdown
    const stopped = engine.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await stopped;
    expect(last().signals).toEqual(['SIGKILL']);
  });

  it('restarts on demand with its listeners, and a stop cancels a pending restart', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { engine, children, last } = setup();
    await engine.listen(4001, 'a');
    await engine.restart();
    expect(children).toHaveLength(2);
    expect(last().commands[0]).toMatchObject({ op: 'listen', port: 4001 });

    last().crash();
    await until(() => engine.status().state === 'restarting');
    await engine.stop();
    expect(engine.status().state).toBe('stopped');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(2);
  });

  it('removes a listener that is being restored while the engine starts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { engine, last, children } = setup({
      onSpawn: (child) => children.length > 1 && child.holding.add('listen'),
    });
    await engine.listen(4001, 'a');
    last().crash();
    await until(() => engine.status().state === 'restarting');
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => children[1]!.commands.some((c) => c.op === 'listen'));
    const removed = engine.unlisten(4001);
    children[1]!.held.shift()!();
    await removed;
    expect(children[1]!.commands.map((c) => c.op)).toEqual(['listen', 'unlisten']);
    expect(engine.status()).toMatchObject({ state: 'running', listeners: 0 });
  });

  it('stays stopped when mitmdump dies while stop waits for its start', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { engine, children } = setup({ autoHello: false });
    const started = engine.start().catch(() => {});
    const stopped = engine.stop();
    children[0]!.crash();
    await started;
    await stopped;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(1);
    expect(engine.status().state).toBe('stopped');
    // A later start works again.
    const again = engine.start();
    children[1]!.hello();
    await again;
    expect(engine.status().state).toBe('running');
  });

  it('rejects open commands when mitmdump dies', async () => {
    const { engine, last } = setup();
    await engine.start();
    last().stdin.removeAllListeners('data'); // no replies any more
    const pending = engine.listen(4001, 'a');
    last().crash();
    await expect(pending).rejects.toThrow('mitmdump exited (1)');
  });
});

describe('supported', () => {
  it('accepts 12.3 and later 12.x only', () => {
    expect(['12.3.1', '12.3.0', '12.4.0'].map(supported)).toEqual([true, true, true]);
    expect(['12.2.9', '13.0.0', '11.9.0'].map(supported)).toEqual([false, false, false]);
  });
});

describe('findMitmdump', () => {
  const sep = process.platform === 'win32' ? ';' : ':';
  it('takes the setting, else PATH, else the install folders', () => {
    const have = new Set(['/opt/x/mitmdump', '/usr/bin/mitmdump']);
    const exists = (p: string) => have.has(p.replaceAll('\\', '/'));
    expect(findMitmdump('/opt/x/mitmdump', {}, 'linux', exists)).toBe('/opt/x/mitmdump');
    expect(() => findMitmdump('/opt/y/mitmdump', {}, 'linux', exists)).toThrow(
      'mitmdump not found at /opt/y/mitmdump (setting mitmdumpPath)',
    );
    expect(
      findMitmdump('', { PATH: `/nope${sep}/usr/bin` }, 'linux', exists).replaceAll('\\', '/'),
    ).toBe('/usr/bin/mitmdump');
    have.add('/opt/homebrew/bin/mitmdump');
    expect(findMitmdump('', {}, 'darwin', exists).replaceAll('\\', '/')).toBe(
      '/opt/homebrew/bin/mitmdump',
    );
    expect(() => findMitmdump('', {}, 'linux', () => false)).toThrow(
      'mitmdump not found: install mitmproxy (uv tool install mitmproxy)',
    );
  });

  it('looks for mitmdump.exe on Windows, also in Path', () => {
    const exists = (p: string) => p.replaceAll('\\', '/') === '/uv/mitmdump.exe';
    expect(findMitmdump('', { Path: '/uv' }, 'win32', exists).replaceAll('\\', '/')).toBe(
      '/uv/mitmdump.exe',
    );
  });
});
