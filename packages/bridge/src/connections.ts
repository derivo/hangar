import { randomUUID } from 'node:crypto';
import type { Decision, PermissionRequest } from '@hangar/bus';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, type Connection } from './client';
import type {
  BayInfo,
  JobAction,
  JobView,
  LocalCaller,
  Notification,
  OfferedFunction,
} from './protocol';
import { remoteListen, sshRemote, type SetupResult, type SetupTarget } from './setup';
import { openTunnel, parseAddress, type SshTarget } from './tunnel';

/** A paired server as saved on the desktop (`<userData>/servers.json`, mode 0600). */
export interface SavedServer {
  id: string;
  name: string;
  /** Loopback bridge URL, or `ssh` for a server behind an SSH tunnel. */
  url?: string;
  ssh?: SshTarget;
  /** Data folder of a server on this machine: its port is read from `listen.json` (ADR 0036). */
  local?: string;
  /**
   * Data folder of a server the app set up on the machine behind `ssh` (ADR 0041): its port is
   * read from `listen.json` there over ssh before each connect.
   */
  remoteData?: string;
  fingerprint: string;
  token: string;
}

type Target = Pick<SavedServer, 'url' | 'ssh' | 'local' | 'remoteData'>;

export type ServerStatus = 'connecting' | 'connected' | 'disconnected' | 'failed';

export interface ServerView {
  id: string;
  name: string;
  status: ServerStatus;
  /** Why the last connection failed (`failed`). */
  error?: string;
  /** The server's bays while connected. */
  bays: BayInfo[];
  /** Their badges while connected (phase 11c). */
  badges: Record<string, number>;
  /** The server on this machine (ADR 0036). */
  local?: true;
  /** How many agent sessions run there while connected, once it said so (tray, ADR 0036). */
  sessions?: number;
  /** Number of the reconnect attempt running or waiting, since it was last connected. */
  retry?: number;
}

interface LiveState {
  status: ServerStatus;
  error?: string;
  connection?: Connection;
  attempt?: number;
}

// The server rejected this desktop: trying again cannot help, the user has to pair anew.
const FINAL =
  /^(Invalid token|Server signature is invalid|Server fingerprint does not match|Protocol version)/;

interface Listeners {
  changed(): void;
  event(server: string, bay: string, channel: string, payload: unknown): void;
  /** A permission question from a server's bus, for the person at this desktop. */
  ask(server: string, request: PermissionRequest, signal: AbortSignal): Promise<Decision>;
  /** A server bay's notification, also those kept while this desktop was away. */
  notify(server: string, bay: string, notification: Notification): void;
  /** A server's jobs or their results changed (phase 11d). */
  jobs(server: string): void;
  /**
   * The bays of this desktop for the local server only (ADR 0036): what it offers, how it runs
   * the server's calls, and an agent session on the server that ended.
   */
  local?: {
    functions(): OfferedFunction[];
    call(
      target: string,
      args: unknown,
      caller: LocalCaller,
      signal?: AbortSignal,
    ): Promise<unknown>;
    sessionEnded(bayId: string, sessionId: string): void;
    /** The local server's workspaces changed (ADR 0036, point 11). */
    workspaces(): void;
  };
}

/** The desktop's connections to paired servers, and pairing new ones. */
export class ServerConnections {
  private saved: SavedServer[];
  private readonly live = new Map<string, LiveState>();
  /** Numbers connection attempts: a disconnect while connecting makes the attempt stale. */
  private attempts = 0;
  /** Pending reconnects and how many failed in a row (for the pause before the next). */
  private readonly retries = new Map<
    string,
    { timer?: ReturnType<typeof setTimeout>; failed: number }
  >();
  private readonly probes = new Map<string, { target: Target; connection: Connection }>();

  constructor(
    private readonly file: string,
    /** How this desktop names itself to the server, and its language (ADR 0019). */
    private readonly client: { name: string; locale?: string },
    private readonly listeners: Listeners,
    /** The `ssh` command for tunnels. */
    private readonly ssh = 'ssh',
    /** First pause before reconnecting; doubles per failure, at most 30 times this. */
    private readonly retryMs = 1000,
  ) {
    this.saved = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as SavedServer[]) : [];
  }

  list(): ServerView[] {
    return this.saved.map(({ id, name, local }) => {
      const live = this.live.get(id);
      const retry = this.retries.get(id)?.failed;
      return {
        id,
        name,
        ...(local && { local: true as const }),
        status: live?.status ?? 'disconnected',
        ...(live?.error && { error: live.error }),
        bays: live?.connection?.bays ?? [],
        badges: live?.connection?.badges ?? {},
        ...(live?.connection?.sessions !== undefined && { sessions: live.connection.sessions }),
        ...(retry && { retry }),
      };
    });
  }

  connectAll(): Promise<void> {
    return Promise.all(this.saved.map((s) => this.connect(s.id))).then(() => undefined);
  }

  async connect(id: string): Promise<void> {
    const server = this.saved.find((s) => s.id === id);
    const live = this.live.get(id);
    if (!server || live?.connection || live?.status === 'connecting') return;
    clearTimeout(this.retries.get(id)?.timer);
    const attempt = ++this.attempts;
    const current = () => this.live.get(id)?.attempt === attempt;
    this.set(id, { status: 'connecting', attempt });
    try {
      const { fingerprint, token } = server;
      const connection = await this.open(server, { fingerprint, token });
      if (current()) this.attach(id, connection);
      else connection.close();
    } catch (e) {
      if (!current()) return;
      const error = (e as Error).message;
      // Locally anyone may hold the old port until the own server writes its new one (ADR 0036).
      const foreign = !!server.local && error.startsWith('Server fingerprint does not match');
      // Counted before the change is told: the pause names the attempt that follows it.
      if (!FINAL.test(error) || foreign) this.retry(id);
      else this.stopRetry(id);
      this.set(id, { status: 'failed', error });
    }
  }

  disconnect(id: string): void {
    this.stopRetry(id);
    const connection = this.live.get(id)?.connection;
    this.set(id, { status: 'disconnected' });
    connection?.close();
  }

  remove(id: string): void {
    this.disconnect(id);
    this.live.delete(id);
    this.save(this.saved.filter((s) => s.id !== id));
    this.listeners.changed();
  }

  /** Opens an unpaired connection and returns the server's fingerprint to confirm. */
  async probe(address: string): Promise<{ id: string; fingerprint: string }> {
    const target = parseAddress(address);
    const connection = await this.open(target, {});
    const id = randomUUID();
    this.probes.set(id, { target, connection });
    return { id, fingerprint: connection.fingerprint };
  }

  /** Pairs a probed server with the code from its log; a wrong code may be retried. */
  async pair(probeId: string, name: string, code: string): Promise<string> {
    const probe = this.probes.get(probeId);
    if (!probe) throw new Error('Pairing has ended');
    const token = await probe.connection.pair(
      code.trim().toUpperCase(),
      this.client.name,
      this.client.locale,
    );
    this.probes.delete(probeId);
    const id = randomUUID().slice(0, 8);
    const { target, connection } = probe;
    this.save([...this.saved, { id, name, ...target, fingerprint: connection.fingerprint, token }]);
    this.attach(id, connection);
    return id;
  }

  /**
   * Pairs with the server whose data folder is `dataDir` on this machine, with the code it
   * writes to `pair-code`; only if its key is the one in `listen.json`. Paired once, it stays.
   */
  async pairLocal(dataDir: string, name: string): Promise<string> {
    const known = this.saved.find((s) => s.local === dataDir);
    if (known) {
      // Its server may have just started again, after retries had stopped (rejected version).
      void this.connect(known.id);
      return known.id;
    }
    const target = { local: dataDir };
    const { fingerprint } = readListen(dataDir);
    const connection = await this.open(target, { fingerprint });
    try {
      const code = readFileSync(join(dataDir, 'pair-code'), 'utf8');
      const token = await connection.pair(code, this.client.name, this.client.locale);
      const id = randomUUID().slice(0, 8);
      this.save([...this.saved, { id, name, ...target, fingerprint, token }]);
      this.attach(id, connection);
      return id;
    } catch (e) {
      connection.close();
      throw e;
    }
  }

  /**
   * Pairs with a server the app has just set up on a machine (ADR 0041), with the key and code
   * read over ssh: the ssh host key vouches for them, as the file system does locally.
   */
  async pairSetUp(target: SetupTarget, name: string, setup: SetupResult): Promise<string> {
    const known = this.saved.find(
      (s) =>
        s.remoteData === setup.remoteData &&
        s.ssh?.host === target.host &&
        s.ssh.user === target.user,
    );
    const saved = { ssh: { ...target, port: setup.port }, remoteData: setup.remoteData };
    const { fingerprint } = setup;
    if (known) {
      // Its token is usually still in the server's clients.json: no new pairing then.
      this.disconnect(known.id);
      try {
        const connection = await this.open(saved, { fingerprint, token: known.token });
        this.attach(known.id, connection);
        return known.id;
      } catch {
        // A new data folder or a removed client: pair again under the same ID.
      }
    }
    const connection = await this.open(saved, { fingerprint });
    try {
      const token = await connection.pair(setup.code, this.client.name, this.client.locale);
      const id = known?.id ?? randomUUID().slice(0, 8);
      const entry = { id, name: known?.name ?? name, ...saved, fingerprint, token };
      this.save([...this.saved.filter((s) => s.id !== id), entry]);
      this.attach(id, connection);
      return id;
    } catch (e) {
      connection.close();
      throw e;
    }
  }

  cancel(probeId: string): void {
    this.probes.get(probeId)?.connection.close();
    this.probes.delete(probeId);
  }

  invoke(id: string, bay: string, channel: string, args: unknown[]): Promise<unknown> {
    return this.connection(id).then((c) => c.invoke(bay, channel, args));
  }

  /** Offers the bays of this desktop again to the local server, after they changed (ADR 0036). */
  offerAgain(): void {
    for (const s of this.saved) {
      const connection = this.live.get(s.id)?.connection;
      if (connection) this.offer(s, connection);
    }
  }

  private offer(server: SavedServer, connection: Connection): void {
    const { local } = this.listeners;
    // Never to a server elsewhere: its agents would reach this desktop (ADR 0036).
    if (!server.local || !local || connection.version < 3) return;
    // A failed offer leaves the last one; the next connect offers again.
    connection.offer(local.functions()).catch(() => undefined);
  }

  /** A server that does not answer in time fails, so it holds up no other list. */
  jobs(id: string, timeoutMs = 5000): Promise<JobView[]> {
    return this.connection(id).then((c) => c.jobs(timeoutMs));
  }

  job(id: string, action: JobAction, jobId: string): Promise<void> {
    return this.connection(id).then((c) => c.job(action, jobId));
  }

  /** An action of Settings → Workspaces on a server's workspaces (protocol 4). */
  workspaces(id: string, action: string, args: (string | boolean)[]): Promise<unknown> {
    return this.connection(id).then((c) => c.workspaces(action, args));
  }

  private async connection(id: string): Promise<Connection> {
    const connection = this.live.get(id)?.connection;
    if (!connection) throw new Error(`Not connected: ${id}`);
    return connection;
  }

  closeAll(): void {
    for (const id of this.retries.keys()) this.stopRetry(id);
    const live = [...this.live.values()];
    // Cleared first: attempts still running close what they get.
    this.live.clear();
    for (const state of live) state.connection?.close();
    for (const id of this.probes.keys()) this.cancel(id);
  }

  /** Connects directly or through a tunnel that lives as long as the connection. */
  private async open(
    target: Target,
    auth: { fingerprint?: string; token?: string },
  ): Promise<Connection> {
    const { locale } = this.client;
    if (target.local) {
      const url = `ws://127.0.0.1:${readListen(target.local).port}/connect`;
      return connect({ url, locale, ...auth });
    }
    if (!target.ssh) return connect({ url: target.url!, locale, ...auth });
    const ssh = target.remoteData
      ? {
          ...target.ssh,
          port: (await remoteListen(sshRemote(target.ssh, this.ssh), target.remoteData)).port,
        }
      : target.ssh;
    const tunnel = await openTunnel(ssh, this.ssh);
    try {
      const connection = await connect({
        url: `ws://127.0.0.1:${tunnel.port}/connect`,
        locale,
        ...auth,
      });
      connection.onClose(tunnel.close);
      return connection;
    } catch (e) {
      tunnel.close();
      throw e;
    }
  }

  private attach(id: string, connection: Connection): void {
    connection.onEvent((bay, channel, payload) => this.listeners.event(id, bay, channel, payload));
    connection.onAsk((request, signal) => this.listeners.ask(id, request, signal));
    connection.onNotify((bay, n) => this.listeners.notify(id, bay, n));
    connection.onJobs(() => this.listeners.jobs(id));
    const server = this.saved.find((s) => s.id === id);
    const { local } = this.listeners;
    if (server?.local && local) {
      connection.onCall(local.call);
      connection.onSessionEnded(local.sessionEnded);
      connection.onWorkspaces(local.workspaces);
      this.offer(server, connection);
    }
    const changed = () => {
      if (this.live.get(id)?.connection === connection) this.listeners.changed();
    };
    connection.onBadge(changed);
    connection.onSessions(changed);
    connection.onClose(() => {
      // Only if this connection is still the current one (not after disconnect or remove).
      if (this.live.get(id)?.connection !== connection) return;
      this.retry(id);
      this.set(id, { status: 'disconnected' });
    });
    this.retries.delete(id);
    this.set(id, { status: 'connected', connection });
  }

  /** Connects again after 1, 2, 4 … at most 30 pauses of `retryMs`. */
  private retry(id: string): void {
    const failed = this.retries.get(id)?.failed ?? 0;
    const pause = this.retryMs * Math.min(2 ** failed, 30);
    const timer = setTimeout(() => void this.connect(id), pause);
    this.retries.set(id, { timer, failed: failed + 1 });
  }

  private stopRetry(id: string): void {
    clearTimeout(this.retries.get(id)?.timer);
    this.retries.delete(id);
  }

  private set(id: string, state: LiveState) {
    this.live.set(id, state);
    this.listeners.changed();
  }

  private save(servers: SavedServer[]): void {
    this.saved = servers;
    // Holds tokens: readable by the user only.
    writeFileSync(`${this.file}.tmp`, JSON.stringify(servers, null, 2), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
}

/** Port and key of the local server, as it wrote them after listening. */
function readListen(dataDir: string): { port: number; fingerprint: string } {
  return JSON.parse(readFileSync(join(dataDir, 'listen.json'), 'utf8')) as {
    port: number;
    fingerprint: string;
  };
}
