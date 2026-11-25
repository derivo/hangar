// mitmdump as the proxy engine of the bay (ADR 0049, "Bay and engine").
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Ca } from './ca';
import { Protocol, type AddonEvent } from './protocol';

export type EngineState = 'stopped' | 'starting' | 'running' | 'restarting' | 'failed';

export interface EngineStatus {
  state: EngineState;
  /** mitmproxy version reported by the addon. */
  version: string | null;
  /** Why the engine failed or restarts. */
  reason: string | null;
  listeners: number;
  warnings: Protocol['warnings'];
}

/** What the rest of the bay needs from the engine; tests use a fake. */
export interface Engine {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Stops and starts again with the same listeners, e.g. after a setting changed. */
  restart(): Promise<void>;
  /** Binds `127.0.0.1:<port>` for proxy credentials `hangar:<password>`; resolves once bound. */
  listen(port: number, password: string): Promise<void>;
  /** Removes the listener and closes its open connections. */
  unlisten(port: number): Promise<void>;
  setCapture(on: boolean): Promise<void>;
  /** Regular expressions of `host:port` passed through without interception. */
  ignore(hosts: string[]): Promise<void>;
  status(): EngineStatus;
  onEvent(listener: (event: AddonEvent) => void): void;
  onStatus(listener: (status: EngineStatus) => void): void;
}

/** Restart delays after a crash; the last one repeats. */
export const BACKOFF_MS = [1000, 5000, 30_000];
/** A run this long counts as stable: the next crash starts the backoff again. */
const STABLE_MS = 60_000;
const HELLO_MS = 20_000;
const STOP_MS = 5000;

/** mitmproxy versions the addon supports: `>=12.3,<13` (ADR 0049). */
export const supported = (version: string) => {
  const [major, minor] = version.split('.').map(Number);
  return major === 12 && minor! >= 3;
};

/**
 * `mitmdump` from the setting, else from `PATH` and the folders `uv tool` and Homebrew
 * install to, which a LaunchAgent's `PATH` lacks.
 */
export function findMitmdump(
  setting: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  if (setting) {
    if (!exists(setting))
      throw new Error(`mitmdump not found at ${setting} (setting mitmdumpPath)`);
    return setting;
  }
  const name = platform === 'win32' ? 'mitmdump.exe' : 'mitmdump';
  const extra =
    platform === 'win32'
      ? [join(homedir(), '.local', 'bin')]
      : [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const dirs = [...(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean), ...extra];
  const found = dirs.map((d) => join(d, name)).find(exists);
  if (!found) {
    throw new Error('mitmdump not found: install mitmproxy (uv tool install mitmproxy)');
  }
  return found;
}

export interface MitmEngineOptions {
  ca: Ca;
  /** `hangar_proxy.py`, a real file (outside `app.asar`). */
  addonPath: string;
  /** Current value of the setting `mitmdumpPath`. */
  mitmdumpPath: () => string;
  /** Current value of the setting `upstreamCaFile`. */
  upstreamCaFile: () => string;
  log?: (message: string) => void;
  spawn?: (command: string, args: string[]) => ChildProcess;
  find?: (setting: string) => string;
}

export class MitmEngine implements Engine {
  private state: EngineState = 'stopped';
  private version: string | null = null;
  private reason: string | null = null;
  private child: ChildProcess | undefined;
  private protocol: Protocol | undefined;
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private crashes = 0;
  /** `stop()` was called: an exit must not schedule a restart. */
  private halted = false;
  /** The version check killed mitmdump: no restart. */
  private unsupported = false;
  private startedAt = 0;
  private capture = true;
  private ignored: string[] = [];
  private readonly listeners = new Map<number, string>();
  private readonly eventListeners: ((e: AddonEvent) => void)[] = [];
  private readonly statusListeners: ((s: EngineStatus) => void)[] = [];
  private readonly warnings = { broken: 0, unknown: 0, overflow: 0, dropped: 0 };

  constructor(private readonly options: MitmEngineOptions) {}

  status(): EngineStatus {
    const live = this.protocol?.warnings;
    const warnings = { ...this.warnings };
    if (live)
      for (const k of Object.keys(warnings) as (keyof typeof warnings)[]) warnings[k] += live[k];
    return {
      state: this.state,
      version: this.version,
      reason: this.reason,
      listeners: this.listeners.size,
      warnings,
    };
  }

  onEvent(listener: (event: AddonEvent) => void): void {
    this.eventListeners.push(listener);
  }

  onStatus(listener: (status: EngineStatus) => void): void {
    this.statusListeners.push(listener);
  }

  start(): Promise<void> {
    this.halted = false;
    if (this.state === 'running') return Promise.resolve();
    return (this.starting ??= this.launch().finally(() => (this.starting = undefined)));
  }

  async stop(): Promise<void> {
    this.halted = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    await this.starting?.catch(() => {});
    const child = this.child;
    if (!child) {
      if (this.state !== 'failed') this.set('stopped', null);
      return;
    }
    this.stopping ??= new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), STOP_MS);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      // The addon shuts mitmdump down when its stdin ends.
      child.stdin?.end();
    });
    await this.stopping;
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async listen(port: number, password: string): Promise<void> {
    if (this.state === 'restarting')
      throw new Error(`The proxy engine is restarting: ${this.reason}`);
    await this.start();
    await this.protocol!.request('listen', { port, password });
    this.listeners.set(port, password);
  }

  async unlisten(port: number): Promise<void> {
    this.listeners.delete(port);
    // A start in progress may be restoring this listener right now.
    await this.starting?.catch(() => {});
    if (this.state === 'running') await this.protocol!.request('unlisten', { port });
  }

  async setCapture(on: boolean): Promise<void> {
    this.capture = on;
    if (this.state === 'running') await this.protocol!.request('capture', { on });
  }

  async ignore(hosts: string[]): Promise<void> {
    this.ignored = hosts;
    if (this.state === 'running') await this.protocol!.request('ignore', { hosts });
  }

  private set(state: EngineState, reason: string | null): void {
    this.state = state;
    this.reason = reason;
    const status = this.status();
    for (const l of this.statusListeners) l(status);
  }

  private async launch(): Promise<void> {
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.set('starting', null);
    let bin: string;
    let upstream: string;
    try {
      bin = (this.options.find ?? findMitmdump)(this.options.mitmdumpPath());
      this.options.ca.prepare();
      upstream = this.options.ca.upstream(this.options.upstreamCaFile());
    } catch (e) {
      this.set('failed', (e as Error).message);
      throw e;
    }
    const args = [
      '-s',
      this.options.addonPath,
      '--set',
      `confdir=${this.options.ca.confdir}`,
      '--set',
      'listen_host=127.0.0.1',
      // No default listener: the first `listen` switches the server on.
      '--set',
      'server=false',
      '--set',
      'flow_detail=0',
      '--set',
      'termlog_verbosity=error',
      '--set',
      'show_ignored_hosts=true',
      '--set',
      `ssl_verify_upstream_trusted_ca=${upstream}`,
    ];
    const child = (this.options.spawn ?? defaultSpawn)(bin, args);
    this.child = child;
    let hello!: (version: string) => void;
    let gone!: (e: Error) => void;
    const ready = new Promise<string>((resolve, reject) => {
      hello = resolve;
      gone = reject;
    });
    const protocol = new Protocol(
      (line) => child.stdin!.write(line),
      (e) => {
        if (e.type === 'hello') hello(e.version);
        else for (const l of this.eventListeners) l(e);
      },
    );
    this.protocol = protocol;
    let stderr = '';
    child.stdin!.on('drain', () => protocol.drain());
    child.stdin!.on('error', () => {}); // EPIPE after a crash; `exit` reports it
    child.stdout!.setEncoding('utf8').on('data', (d: string) => protocol.receive(d));
    child.stderr!.setEncoding('utf8').on('data', (d: string) => {
      stderr = (stderr + d).slice(-2000);
      this.options.log?.(`mitmdump: ${d.trimEnd()}`);
    });
    child.on('error', (e) => {
      gone(e);
      this.exited(child, `mitmdump did not start: ${e.message}`);
    });
    child.on('exit', (code, signal) => {
      const tail = stderr.trim().split('\n').at(-1);
      const why = `mitmdump exited (${signal ?? code})${tail ? `: ${tail}` : ''}`;
      gone(new Error(why));
      this.exited(child, why);
    });
    const timer = setTimeout(() => gone(new Error('mitmdump did not start within 20 s')), HELLO_MS);
    try {
      this.version = await ready;
    } catch (e) {
      child.kill();
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (!supported(this.version)) {
      const reason = `mitmproxy ${this.version} is not supported (needs >=12.3,<13)`;
      this.unsupported = true;
      child.kill();
      this.set('failed', reason);
      throw new Error(reason);
    }
    this.options.ca.secure();
    this.startedAt = Date.now();
    // Pause and pass-through first: a reconnecting client must not see the defaults.
    if (!this.capture) await protocol.request('capture', { on: false });
    if (this.ignored.length) await protocol.request('ignore', { hosts: this.ignored });
    for (const [port, password] of this.listeners) {
      await protocol.request('listen', { port, password }).catch((e: Error) => {
        if (this.protocol !== protocol) return; // crashed again: the next start retries
        this.listeners.delete(port);
        this.options.log?.(`listener ${port} lost after restart: ${e.message}`);
      });
    }
    if (this.child !== child) throw new Error(this.reason ?? 'mitmdump exited');
    this.set('running', null);
  }

  private exited(child: ChildProcess, why: string): void {
    if (this.child !== child) return;
    this.child = undefined;
    if (this.protocol) {
      for (const k of Object.keys(this.warnings) as (keyof typeof this.warnings)[])
        this.warnings[k] += this.protocol.warnings[k];
      this.protocol.close(why);
      this.protocol = undefined;
    }
    if (this.stopping || this.halted) {
      this.stopping = undefined;
      this.set('stopped', null);
      return;
    }
    if (this.unsupported) {
      this.unsupported = false;
      return;
    }
    if (this.startedAt && Date.now() - this.startedAt >= STABLE_MS) this.crashes = 0;
    this.startedAt = 0;
    const delay = BACKOFF_MS[Math.min(this.crashes++, BACKOFF_MS.length - 1)]!;
    this.options.log?.(`${why}; restarting in ${delay / 1000} s`);
    this.set('restarting', why);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.start().catch(() => {}); // a failed start schedules the next attempt itself
    }, delay);
  }
}

const defaultSpawn = (command: string, args: string[]) =>
  nodeSpawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
