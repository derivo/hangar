import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Bus, RemoteAccess } from '@hangar/bus';
import type { BayWorkspaces, RemoteBayState } from '@hangar/sdk';
import {
  createIdentity,
  exportIdentity,
  fingerprint,
  importIdentity,
  RelayClient,
  type Identity,
  type IdentityDocument,
  type RelayBus,
  type RemoteState,
  type StoredWorkspace,
} from '@hangar/relay';

/** `wss:`; `ws:` only on this computer (tests, a relay next to Hangar). */
function relayAddress(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const { protocol, hostname } = new URL(url);
  return (
    protocol === 'wss:' ||
    (protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(hostname))
  );
}

export interface WorkspacesView {
  relay?: string;
  status: 'off' | 'connecting' | 'connected' | 'error';
  error?: string;
  /** This instance. */
  name: string;
  fingerprint: string;
  workspaces: {
    name: string;
    /** Joined, waiting for the inviter's list. */
    waiting: boolean;
    members: { name: string; fingerprint: string }[];
    /** Instances that joined and wait for their inviter (fingerprint) to confirm them. */
    joined: { name: string; fingerprint: string; inviter?: string }[];
    /** Functions `<bay-id>/<name>` the workspace may call. */
    shared: string[];
  }[];
}

export interface WorkspacesOptions {
  /** Holds `workspaces.json`, `relay-identity.json` and the replay state. */
  dir: string;
  /** Name of a new identity (the instance as others see it). */
  name: string;
  bus: RelayBus;
  /** Protects the private keys at rest (desktop: `safeStorage`). */
  protect: { encrypt(text: string): string; decrypt(text: string): string };
  onChange(): void;
  /** Wait before connecting again after the relay went away. */
  retryMs?: number;
  /** Renew own member lists older than this, so a quiet workspace does not expire (7 days). */
  renewMs?: number;
}

interface Stored {
  relay?: string;
  workspaces: StoredWorkspace[];
  shared: Record<string, string[]>;
  waiting: Record<string, string>;
}

/**
 * What Settings → Workspaces does, by name: from the app's IPC on its own workspaces, or over
 * the bridge on the local server's (ADR 0036, point 11). `view` also lists the functions that
 * may be shared (`remote`, not sensitive, not of other instances).
 */
export async function workspaceAction(
  ws: Workspaces,
  bus: Pick<Bus, 'list'>,
  action: string,
  args: unknown[],
): Promise<unknown> {
  // Texts, and for `share` on or off: a missing value must not switch a share off (Codex).
  const texts = {
    connect: 1,
    create: 2,
    invite: 1,
    join: 3,
    accept: 2,
    reject: 2,
    remove: 2,
    share: 2,
  }[action];
  if (
    texts !== undefined &&
    (args.length !== texts + (action === 'share' ? 1 : 0) ||
      args.slice(0, texts).some((v) => typeof v !== 'string') ||
      (action === 'share' && typeof args[2] !== 'boolean'))
  )
    throw new Error(`Invalid arguments for ${action}`);
  const [a, b, c] = args.map((v) => String(v));
  switch (action) {
    case 'view':
      return {
        ...ws.view(),
        functions: bus
          .list()
          .filter(
            (f) => f.spec.remote === true && !f.spec.sensitive && !f.bayId.startsWith('remote.'),
          )
          .map((f) => ({
            id: f.id,
            ...(f.spec.description && { description: f.spec.description }),
          })),
      };
    case 'connect':
      return ws.connect(a!);
    case 'create':
      return ws.create(a!, b!);
    case 'invite':
      return ws.invite(a!);
    case 'join':
      return ws.join(a!, b!, c!);
    case 'accept':
      return ws.accept(a!, b!);
    case 'reject':
      return ws.reject(a!, b!);
    case 'remove':
      return ws.remove(a!, b!);
    case 'share':
      return ws.setShared(a!, b!, args[2] === true);
    default:
      throw new Error(`Unknown workspace action: ${action}`);
  }
}

/**
 * The workspaces of one Hangar (ADR 0030): identity, one relay connection, trusted workspaces,
 * share lists and the states bays share. Also the bus's `RemoteAccess`.
 */
export class Workspaces implements RemoteAccess {
  private readonly identity: Identity;
  private stored: Stored;
  private client?: RelayClient;
  private status: WorkspacesView['status'] = 'off';
  private error?: string;
  private closed = false;
  private retry?: ReturnType<typeof setTimeout>;
  private renewal?: ReturnType<typeof setInterval>;
  /** Counts connection attempts: only the newest one may become the connection. */
  private attempt = 0;
  /** Join requests per workspace, until a member adds or refuses them. */
  private readonly joined = new Map<
    string,
    Map<string, { doc: IdentityDocument; inviter?: string }>
  >();
  private readonly stateListeners = new Map<string, Set<(states: RemoteBayState[]) => void>>();
  private readonly ownStates = new Map<string, unknown>();

  constructor(private readonly options: WorkspacesOptions) {
    mkdirSync(options.dir, { recursive: true });
    this.identity = this.loadIdentity();
    const file = this.file('workspaces.json');
    this.stored = existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as Stored)
      : { workspaces: [], shared: {}, waiting: {} };
  }

  /** Connects to the stored relay, if any; a failure only shows in the view. */
  async start(): Promise<void> {
    if (this.stored.relay) await this.connect(this.stored.relay).catch(() => {});
  }

  async connect(url: string): Promise<void> {
    if (!relayAddress(url)) throw new Error('Invalid relay address');
    const attempt = ++this.attempt;
    this.disconnect();
    this.stored.relay = url;
    this.save();
    this.setStatus('connecting');
    let client: RelayClient;
    try {
      client = await RelayClient.connect(
        {
          url,
          identity: this.identity,
          bus: this.options.bus,
          dataDir: this.file('replay'),
          shared: (w) => this.sharedOf(w),
        },
        this.stored.workspaces,
        this.stored.waiting,
      );
    } catch (error) {
      if (attempt === this.attempt) {
        this.setStatus('error', (error as Error).message);
        this.retryLater();
      }
      throw error;
    }
    if (attempt !== this.attempt) {
      client.close();
      return;
    }
    this.client = client;
    const adopt = (w: StoredWorkspace) => {
      this.stored.workspaces = [
        ...this.stored.workspaces.filter((s) => s.list.workspace !== w.list.workspace),
        w,
      ];
      delete this.stored.waiting[w.list.workspace];
      const asking = this.joined.get(w.list.workspace);
      for (const m of w.list.members) asking?.delete(fingerprint(m));
      for (const fp of w.list.revoked) asking?.delete(fp);
      this.save();
      this.options.onChange();
    };
    client.onChange(adopt);
    // Lists taken during the handshake came before the listener: a newer list or the end of
    // a waiting join must reach the store too.
    for (const name of [
      ...this.stored.workspaces.map((s) => s.list.workspace),
      ...Object.keys(this.stored.waiting),
    ]) {
      const w = client.workspace(name);
      const before = this.stored.workspaces.find((s) => s.list.workspace === name);
      if (w && w.list.version !== before?.list.version)
        adopt({ list: w.list, vouched: w.vouchedTimes });
    }
    client.onJoined((workspace, doc, inviter) => {
      const asking = this.joined.get(workspace) ?? new Map();
      const listed = client.workspace(workspace)?.list.members.map(fingerprint) ?? [];
      if (!listed.includes(fingerprint(doc))) asking.set(fingerprint(doc), { doc, inviter });
      this.joined.set(workspace, asking);
      this.options.onChange();
    });
    client.onRemoteStates((states) => this.statesChanged(states));
    client.onClosed(() => {
      if (this.client !== client) return;
      this.disconnect();
      this.setStatus('error', 'Relay connection closed');
      this.retryLater();
    });
    for (const [bayId, state] of this.ownStates) client.publishState(bayId, state);
    this.renewal = setInterval(() => this.renew(), this.renewMs() / 4);
    this.renew();
    this.setStatus('connected');
  }

  async create(name: string, operatorToken: string): Promise<void> {
    await this.relay().create(name, operatorToken);
  }

  async invite(
    workspace: string,
  ): Promise<{ workspace: string; token: string; fingerprint: string }> {
    const token = await this.relay().invite(workspace);
    return { workspace, token, fingerprint: this.identity.fingerprint };
  }

  async join(workspace: string, token: string, inviter: string): Promise<'trusted' | 'waiting'> {
    const result = await this.relay().join(workspace, token, inviter);
    if (result === 'waiting') {
      this.stored.waiting[workspace] = inviter;
      this.save();
      this.options.onChange();
    }
    return result;
  }

  /** A person compared the fingerprint of an instance that joined: it becomes a member. */
  async accept(workspace: string, instance: string): Promise<void> {
    const request = this.joined.get(workspace)?.get(instance);
    if (!request) throw new Error('No such join request');
    // The instance trusts only a list its inviter signed (ADR 0030).
    if (request.inviter && request.inviter !== this.identity.fingerprint)
      throw new Error('Only the inviter can add this instance');
    await this.relay().addMember(workspace, request.doc);
  }

  /** Refuses an instance that joined: revoked, so the relay forgets it too. */
  async reject(workspace: string, instance: string): Promise<void> {
    await this.remove(workspace, instance);
    this.joined.get(workspace)?.delete(instance);
    this.options.onChange();
  }

  async remove(workspace: string, instance: string): Promise<void> {
    await this.relay().removeMember(workspace, instance);
  }

  setShared(workspace: string, target: string, on: boolean): void {
    const list = this.sharedOf(workspace).filter((t) => t !== target);
    this.stored.shared[workspace] = on ? [...list, target] : list;
    this.save();
    this.client?.announceAll(workspace);
    this.options.onChange();
  }

  /** Shares a bay's state; kept and sent again after reconnecting. */
  publish(bayId: string, state: unknown): void {
    this.ownStates.set(bayId, state);
    this.client?.publishState(bayId, state);
  }

  /** What the same bay of other instances shares. */
  states(bayId: string): RemoteBayState[] {
    return this.ofBay(this.client?.remoteStates() ?? [], bayId);
  }

  onStates(bayId: string, listener: (states: RemoteBayState[]) => void): void {
    const set = this.stateListeners.get(bayId) ?? new Set();
    set.add(listener);
    this.stateListeners.set(bayId, set);
  }

  /** `ctx.workspaces` of one bay: it shares and sees only states of its own bay id. */
  forBay(bayId: string): BayWorkspaces {
    return {
      publish: (state) => this.publish(bayId, state),
      states: () => this.states(bayId),
      onState: (listener) => this.onStates(bayId, listener),
    };
  }

  isMember(workspace: string, instance: string): boolean {
    return this.client?.isMember(workspace, instance) === true;
  }

  isShared(workspace: string, target: string): boolean {
    return this.sharedOf(workspace).includes(target);
  }

  view(): WorkspacesView {
    const trusted = this.stored.workspaces.map((s) => ({
      name: s.list.workspace,
      waiting: false,
      members: s.list.members.map((m) => ({ name: m.name, fingerprint: fingerprint(m) })),
      joined: [...(this.joined.get(s.list.workspace)?.values() ?? [])].map(({ doc, inviter }) => ({
        name: doc.name,
        fingerprint: fingerprint(doc),
        inviter,
      })),
      shared: this.sharedOf(s.list.workspace),
    }));
    const waiting = Object.keys(this.stored.waiting).map((name) => ({
      name,
      waiting: true,
      members: [],
      joined: [],
      shared: [],
    }));
    return {
      ...(this.stored.relay && { relay: this.stored.relay }),
      status: this.status,
      ...(this.error && { error: this.error }),
      name: this.identity.document.name,
      fingerprint: this.identity.fingerprint,
      workspaces: [...trusted, ...waiting],
    };
  }

  close(): void {
    this.closed = true;
    this.disconnect();
  }

  /** Ends the connection and its timers. */
  private disconnect(): void {
    clearTimeout(this.retry);
    clearInterval(this.renewal);
    const client = this.client;
    this.client = undefined;
    client?.close();
  }

  private retryLater(): void {
    if (this.closed) return;
    // A newer `connect` clears this timer (`disconnect`).
    this.retry = setTimeout(() => void this.start(), this.options.retryMs ?? 5000);
  }

  /** Signs own lists again before they age out; a refused renewal waits for the next round. */
  private renew(): void {
    for (const s of this.stored.workspaces) {
      const w = this.client?.workspace(s.list.workspace);
      if (w && Date.now() - Date.parse(w.list.issued) >= this.renewMs())
        this.client!.renew(w.name).catch(() => {});
    }
  }

  private renewMs(): number {
    return this.options.renewMs ?? 24 * 60 * 60 * 1000;
  }

  /** Workspace names are object keys: `constructor` must not read `Object.prototype`. */
  private sharedOf(workspace: string): string[] {
    return Object.hasOwn(this.stored.shared, workspace) ? this.stored.shared[workspace]! : [];
  }

  private relay(): RelayClient {
    if (!this.client) throw new Error('Not connected to a relay');
    return this.client;
  }

  private statesChanged(states: RemoteState[]): void {
    for (const [bayId, listeners] of this.stateListeners) {
      const mine = this.ofBay(states, bayId);
      for (const l of listeners) l(mine);
    }
  }

  private ofBay(states: RemoteState[], bayId: string): RemoteBayState[] {
    return states
      .filter((s) => s.bayId === bayId)
      .map(({ workspace, instance, name, state }) => ({ workspace, instance, name, state }));
  }

  private setStatus(status: WorkspacesView['status'], error?: string): void {
    this.status = status;
    this.error = error;
    this.options.onChange();
  }

  private file(name: string): string {
    return join(this.options.dir, name);
  }

  private save(): void {
    writeFileSync(this.file('workspaces.json'), JSON.stringify(this.stored), { mode: 0o600 });
  }

  /** The instance's keys: created once, the private parts stored protected. */
  private loadIdentity(): Identity {
    const file = this.file('relay-identity.json');
    const { protect } = this.options;
    if (existsSync(file)) {
      const { document, keys } = JSON.parse(readFileSync(file, 'utf8')) as {
        document: IdentityDocument;
        keys: string;
      };
      return importIdentity({ document, ...JSON.parse(protect.decrypt(keys)) });
    }
    const identity = createIdentity(this.options.name);
    const { document, ed25519, x25519 } = exportIdentity(identity);
    const keys = protect.encrypt(JSON.stringify({ ed25519, x25519 }));
    writeFileSync(file, JSON.stringify({ document, keys }), { mode: 0o600 });
    return identity;
  }
}
