import { randomUUID, sign } from 'node:crypto';
import type { Caller, FunctionSpec, RemoteAccess, Transport } from '@hangar/bus';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Endpoint } from './endpoint';
import type { Envelope } from './envelope';
import { fingerprint, verifyIdentity, type Identity, type IdentityDocument } from './identity';
import { Workspace, type MemberList } from './members';
import {
  MAX_MESSAGE_BYTES,
  RELAY_VERSIONS,
  signedChallenge,
  type FromRelay,
  type ToRelay,
} from './protocol';
import { ReplayGuard } from './replay';

/** What the relay client needs from the bus. */
export interface RelayBus {
  call(caller: Caller, target: string, args: unknown): Promise<unknown>;
  registerTransport(bayId: string, spec: FunctionSpec, transport: Transport): void;
  unregisterBay(bayId: string): void;
  list(): { id: string; bayId: string; spec: FunctionSpec }[];
}

export interface RelayClientOptions {
  url: string;
  identity: Identity;
  bus: RelayBus;
  /** Folder for the replay state per workspace. */
  dataDir: string;
  /** Functions `<bay-id>/<name>` a workspace may call; read on every call. */
  shared: (workspace: string) => readonly string[];
  /** Waiting for a result, for the relay's handshake and its answers (ADR 0011: 60 s). */
  callTimeoutMs?: number;
  now?: () => number;
}

// Requests carry an id the client assigns.
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

/** A trusted workspace as the host keeps it between starts. */
export interface StoredWorkspace {
  list: MemberList;
  vouched: Record<string, number>;
}

/** Limits of ADR 0011. */
export const CALL_TIMEOUT_MS = 60_000;
export const MAX_OPEN_CALLS = 10;

type Body =
  /**
   * `list`: the sender's member list, so a list the relay withholds still arrives as long as
   * the members can talk at all (ADR 0011, review of phase 14).
   */
  | { t: 'announce'; functions: { bayId: string; spec: FunctionSpec }[]; list: MemberList }
  | { t: 'call'; id: string; bayId: string; target: string; args: unknown }
  | { t: 'result'; id: string; ok: true; value: unknown }
  | { t: 'result'; id: string; ok: false; error: string }
  /** What a bay shares (ADR 0030); goes only to the same bay of the other instance. */
  | { t: 'state'; bayId: string; state: unknown };

/** The last state a bay of another instance shared, with where it comes from. */
export interface RemoteState {
  workspace: string;
  /** Fingerprint of the instance. */
  instance: string;
  /** Name of the instance from its identity document. */
  name: string;
  bayId: string;
  state: unknown;
}

/**
 * Name of a remote bay on the local bus; the whole fingerprint ties grants to the key (a short
 * part could be matched by a second key made for it, review of phase 15).
 */
export const remoteBayId = (doc: IdentityDocument, bayId: string) => {
  const name =
    doc.name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'instance';
  return `remote.${name}-${fingerprint(doc)}.${bayId}`;
};

const BAY_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const FUNCTION_NAME = /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)*$/;
/** Call ids are kept this long against a resent call with a new number (ADR 0011). */
const CALL_ID_MS = 5 * 60_000;

interface OpenCall {
  peer: string;
  workspace: string;
  seq: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Connection of one instance to a relay: trusted workspaces, remote functions on the local
 * bus (`remote.<name>-<fp>.<bay-id>/<function>`) and the answer to calls from members.
 * Also the bus's `RemoteAccess`: membership from the member list, share list from `shared`.
 */
export class RelayClient implements RemoteAccess {
  private readonly trusted = new Map<string, { workspace: Workspace; endpoint: Endpoint }>();
  private readonly requests = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly calls = new Map<string, OpenCall>();
  private readonly seenCalls = new Map<string, number>();
  /** Remote bay ids on the bus this route registered, per `workspace\npeer`. */
  private readonly remoteBays = new Map<string, string[]>();
  /** The functions each route announced last; another route of the peer may take over a bay. */
  private readonly offers = new Map<string, unknown>();
  /** Calls of each peer being answered here. */
  private readonly answering = new Map<string, number>();
  /** States this instance's bays share, by bay id. */
  private readonly ownStates = new Map<string, unknown>();
  /** States of other instances, per `workspace\npeer\nbay-id`. */
  private readonly peerStates = new Map<string, RemoteState>();
  private readonly stateListeners = new Set<(states: RemoteState[]) => void>();
  private readonly closeListeners = new Set<() => void>();
  /** Joined workspaces waiting for a list signed by the confirmed inviter. */
  private readonly pending = new Map<string, string>();
  /** Peers that got our announce since this connection started. */
  private readonly announced = new Set<string>();
  private readonly joinedListeners = new Set<
    (workspace: string, identity: IdentityDocument, inviter?: string) => void
  >();
  private readonly changeListeners = new Set<(state: StoredWorkspace) => void>();
  private nextId = 1;
  private publishing: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  private constructor(
    private readonly socket: WebSocket,
    private readonly options: RelayClientOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Connects, proves the instance key and trusts the workspaces stored at the last start.
   * `waiting`: joined workspaces still waiting for their inviter's list (workspace → fingerprint).
   */
  static async connect(
    options: RelayClientOptions,
    stored: StoredWorkspace[] = [],
    waiting: Record<string, string> = {},
  ): Promise<RelayClient> {
    // `ws` (not the WebSocket of Node): it limits what the untrusted relay may send.
    const socket = new WebSocket(options.url, { maxPayload: 2 * MAX_MESSAGE_BYTES });
    const client = new RelayClient(socket, options);
    // Errors also after the handshake (an oversized frame): the close that follows cleans up.
    socket.on('error', () => {});
    const now = new Date(client.now());
    for (const s of stored) client.trust(new Workspace(s.list, now, s.vouched));
    for (const [name, inviter] of Object.entries(waiting)) client.pending.set(name, inviter);
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      const fail = (message: string) => {
        socket.close();
        reject(new Error(message));
      };
      const timer = setTimeout(
        () => fail('The relay did not answer'),
        options.callTimeoutMs ?? CALL_TIMEOUT_MS,
      );
      socket.addEventListener('error', () => fail('Relay not reachable'), { once: true });
      socket.addEventListener('close', () => fail('Relay connection closed'), { once: true });
      socket.addEventListener('open', () =>
        client.send({
          type: 'hello',
          versions: RELAY_VERSIONS,
          identity: options.identity.document,
        }),
      );
      // The relay is not trusted: a message of the wrong shape ends the connection, it never
      // throws inside the listener (that would take the whole process down).
      socket.addEventListener('message', (event) => {
        try {
          receive(JSON.parse(String(event.data)) as FromRelay);
        } catch {
          fail('Invalid message from the relay');
        }
      });
      const receive = (m: FromRelay) => {
        if (m.type === 'challenge') {
          const sig = sign(
            null,
            signedChallenge(m.nonce, options.url),
            options.identity.signKey,
          ).toString('base64url');
          return client.send({ type: 'prove', sig });
        }
        if (m.type === 'ready') {
          for (const w of m.workspaces) client.offerList(w.list);
          ready = true;
          clearTimeout(timer);
          resolve();
          for (const name of client.trusted.keys()) client.announceAll(name);
        }
        // Before ready an error ends the attempt; after it, it answers one message only.
        if (m.type === 'error' && !ready) fail(m.message);
        client.handle(m);
      };
    });
    socket.addEventListener('close', () => client.closed());
    return client;
  }

  // RemoteAccess for the bus.
  isMember(workspace: string, instance: string): boolean {
    return this.trusted.get(workspace)?.workspace.isMember(instance, new Date(this.now())) === true;
  }

  isShared(workspace: string, target: string): boolean {
    return this.options.shared(workspace).includes(target);
  }

  workspace(name: string): Workspace | undefined {
    return this.trusted.get(name)?.workspace;
  }

  /** An instance joined; `inviter` (fingerprint) is the member who has to add it. */
  onJoined(
    listener: (workspace: string, identity: IdentityDocument, inviter?: string) => void,
  ): void {
    this.joinedListeners.add(listener);
  }

  /** A trusted workspace changed; store it for the next start (`connect`). */
  onChange(listener: (state: StoredWorkspace) => void): void {
    this.changeListeners.add(listener);
  }

  /** Shares the state of a bay with every member of every trusted workspace (ADR 0030). */
  publishState(bayId: string, state: unknown): void {
    this.ownStates.set(bayId, state);
    for (const [workspace, { workspace: w }] of this.trusted) {
      for (const m of w.list.members) {
        const fp = fingerprint(m);
        if (fp !== this.options.identity.fingerprint)
          this.trySeal(workspace, fp, { t: 'state', bayId, state });
      }
    }
  }

  /** The states other instances share, as last received. */
  remoteStates(): RemoteState[] {
    return [...this.peerStates.values()];
  }

  onRemoteStates(listener: (states: RemoteState[]) => void): void {
    this.stateListeners.add(listener);
  }

  /** The connection to the relay ended (also after `close`). */
  onClosed(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  /** Founds a workspace on the relay; needs the operator's token. */
  async create(name: string, operatorToken: string): Promise<void> {
    const workspace = Workspace.found(name, this.options.identity, new Date(this.now()));
    await this.request({
      type: 'create',
      workspace: name,
      token: operatorToken,
      list: workspace.list,
    });
    this.trust(workspace);
  }

  invite(workspace: string): Promise<string> {
    return this.request({ type: 'invite', workspace }) as Promise<string>;
  }

  /**
   * Joins with an invitation. `inviter` is the fingerprint a person confirmed over a second
   * channel; a list counts only if that member signed it. If another member signed the current
   * one, the workspace waits (`'waiting'`) for the inviter's next list, which adds this instance.
   */
  async join(name: string, token: string, inviter: string): Promise<'trusted' | 'waiting'> {
    const list = (await this.request({ type: 'join', workspace: name, token })) as MemberList;
    this.pending.set(name, inviter);
    this.offerList(list);
    return this.trusted.has(name) ? 'trusted' : 'waiting';
  }

  /** Adds an instance whose fingerprint a person confirmed and sends the new list. */
  addMember(name: string, identity: IdentityDocument): Promise<void> {
    return this.publish(name, (list) => ({
      members: [...list.members.filter((m) => fingerprint(m) !== fingerprint(identity)), identity],
    }));
  }

  removeMember(name: string, instance: string): Promise<void> {
    return this.publish(name, (list) => ({
      members: list.members.filter((m) => fingerprint(m) !== instance),
      revoked: [...new Set([...list.revoked, instance])],
    }));
  }

  /** Signs the same members again so the list stays younger than seven days. */
  renew(name: string): Promise<void> {
    return this.publish(name, () => ({}));
  }

  /** Tells all members which functions this workspace may call (after the share list changed). */
  announceAll(workspace: string): void {
    const w = this.trusted.get(workspace);
    if (!w) return;
    for (const m of w.workspace.list.members) {
      const fp = fingerprint(m);
      if (fp !== this.options.identity.fingerprint) this.announce(workspace, fp);
    }
  }

  close(): void {
    this.socket.close();
  }

  private require(name: string): Workspace {
    const w = this.trusted.get(name)?.workspace;
    if (!w) throw new Error(`Unknown workspace: ${name}`);
    return w;
  }

  /**
   * The relay orders changes: a list counts here only after it took it. Two members changing
   * at once get one version through; the other learns `Not newer than the stored list`.
   * Own changes wait for each other: each one drafts from the list the one before left.
   */
  private publish(
    name: string,
    change: (list: MemberList) => Parameters<Workspace['next']>[1],
  ): Promise<void> {
    const run = this.publishing.then(async () => {
      const w = this.require(name);
      const list = w.draft(this.options.identity, change(w.list), new Date(this.now()));
      await this.request({ type: 'list', list });
      this.offerList(list);
    });
    this.publishing = run.catch(() => {});
    return run;
  }

  private trust(workspace: Workspace): void {
    const guard = new ReplayGuard(
      join(this.options.dataDir, `replay-${Buffer.from(workspace.name).toString('hex')}.json`),
    );
    this.trusted.set(workspace.name, {
      workspace,
      endpoint: new Endpoint(this.options.identity, workspace, guard, this.now),
    });
    this.changed(workspace);
  }

  /**
   * A list from the relay or a member: taken if a current member signed it (or, after `join`,
   * the confirmed inviter in a list that holds this instance), ignored otherwise.
   */
  private offerList(list: MemberList): void {
    const inviter = this.pending.get(list?.workspace);
    if (inviter !== undefined && list.signer === inviter) {
      // Before the inviter added this instance, the list is not the one to wait for.
      const own = this.options.identity.fingerprint;
      if (!list.members?.some((m) => fingerprint(m) === own)) return;
      try {
        this.trust(new Workspace(list, new Date(this.now())));
        this.pending.delete(list.workspace);
        this.announceAll(list.workspace);
      } catch {
        // Not a valid list: keep waiting.
      }
      return;
    }
    const w = this.trusted.get(list?.workspace)?.workspace;
    if (!w || list.version <= w.list.version) return;
    try {
      w.accept(list, new Date(this.now()));
    } catch {
      return;
    }
    this.changed(w);
    this.membersChanged(w.name);
  }

  private changed(w: Workspace): void {
    for (const l of this.changeListeners) l({ list: w.list, vouched: w.vouchedTimes });
  }

  /** Drops the functions and states of instances that left; announces to new members. */
  private membersChanged(workspace: string): void {
    let dropped = false;
    for (const [key, s] of this.peerStates) {
      if (s.workspace === workspace && !this.isMember(workspace, s.instance)) {
        this.peerStates.delete(key);
        dropped = true;
      }
    }
    if (dropped) this.statesChanged();
    for (const [key, bays] of this.remoteBays) {
      const [ws, peer] = key.split('\n') as [string, string];
      if (ws === workspace && !this.isMember(ws, peer)) {
        for (const bay of bays) this.options.bus.unregisterBay(bay);
        this.remoteBays.delete(key);
        this.offers.delete(key);
        this.takeOver(peer);
      }
    }
    this.announceAll(workspace);
  }

  private send(m: ToRelay): void {
    // `ws` drops what is sent on a closed socket without a word.
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Relay connection closed');
    this.socket.send(JSON.stringify(m));
  }

  private request(m: WithoutId<Extract<ToRelay, { id: number }>>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error('The relay did not answer'));
      }, this.options.callTimeoutMs ?? CALL_TIMEOUT_MS);
      this.requests.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      try {
        this.send({ ...m, id } as ToRelay);
      } catch (error) {
        this.requests.get(id)!.reject(error as Error);
        this.requests.delete(id);
      }
    });
  }

  /** Only for trusted workspaces: callers come from one. */
  private seal(workspace: string, peer: string, body: Body): Envelope {
    const envelope = this.trusted.get(workspace)!.endpoint.send(peer, JSON.stringify(body));
    if (JSON.stringify(envelope).length > MAX_MESSAGE_BYTES) throw new Error('Message too large');
    this.send({ type: 'send', envelope });
    return envelope;
  }

  private statesChanged(): void {
    const states = this.remoteStates();
    for (const l of this.stateListeners) l(states);
  }

  /** Seals if the peer can still be reached; a peer that left or expired gets nothing. */
  private trySeal(workspace: string, peer: string, body: Body): void {
    try {
      this.seal(workspace, peer, body);
    } catch {
      // Nothing to tell.
    }
  }

  private announce(workspace: string, peer: string): void {
    this.announced.add(`${workspace}\n${peer}`);
    const shared = new Set(this.options.shared(workspace));
    const functions = this.options.bus
      .list()
      .filter((f) => shared.has(f.id) && f.spec.remote === true && !f.spec.sensitive)
      .map(({ bayId, spec }) => ({ bayId, spec }));
    try {
      const list = this.trusted.get(workspace)!.workspace.list;
      this.seal(workspace, peer, { t: 'announce', functions, list });
    } catch {
      // The peer's list expired or it left; nothing to tell.
      return;
    }
    for (const [bayId, state] of this.ownStates)
      this.trySeal(workspace, peer, { t: 'state', bayId, state });
  }

  private handle(m: FromRelay): void {
    switch (m.type) {
      case 'result': {
        const r = this.requests.get(m.id);
        this.requests.delete(m.id);
        if (m.ok) r?.resolve(m.value);
        else r?.reject(new Error(m.error));
        return;
      }
      case 'list':
        return this.offerList(m.list);
      case 'joined': {
        // From the relay: a forged document would reach the members' join requests.
        if (!verifyIdentity(m.identity)) return;
        const inviter = typeof m.inviter === 'string' ? m.inviter : undefined;
        for (const l of this.joinedListeners) l(m.workspace, m.identity, inviter);
        return;
      }
      case 'undeliverable':
        for (const [id, call] of this.calls) {
          if (call.peer === m.to && call.workspace === m.workspace && call.seq === m.seq) {
            const why =
              m.reason === 'offline'
                ? 'The instance is not connected'
                : 'The relay refused the message: no member of the workspace';
            this.finish(id, new Error(why));
          }
        }
        return;
      case 'deliver':
        return this.deliver(m.envelope);
    }
  }

  private deliver(envelope: Envelope): void {
    const workspace = envelope?.header?.workspace;
    const w = this.trusted.get(workspace);
    if (!w) return;
    let body: Body;
    try {
      body = JSON.parse(w.endpoint.receive(envelope)) as Body;
    } catch {
      return; // forged, replayed or from a non-member: dropped, nothing runs
    }
    const peer = envelope.header.from;
    if (!this.announced.has(`${workspace}\n${peer}`)) this.announce(workspace, peer);
    if (body.t === 'announce') {
      if (body.list?.workspace === workspace) this.offerList(body.list);
      // The new list may have removed the sender.
      if (!this.isMember(workspace, peer)) return;
      return this.registerRemote(workspace, peer, body.functions);
    }
    if (body.t === 'call') return void this.answer(workspace, peer, body);
    if (body.t === 'state') {
      if (typeof body.bayId !== 'string' || !BAY_ID.test(body.bayId)) return;
      const doc = w.workspace.member(peer, new Date(this.now()))!;
      this.peerStates.set(`${workspace}\n${peer}\n${body.bayId}`, {
        workspace,
        instance: peer,
        name: doc.name,
        bayId: body.bayId,
        state: body.state,
      });
      return this.statesChanged();
    }
    if (body.t === 'result') {
      const call = this.calls.get(body.id);
      if (call?.peer !== peer || call.workspace !== workspace) return;
      this.finish(
        body.id,
        body.ok ? undefined : new Error(body.error),
        body.ok ? body.value : undefined,
      );
    }
  }

  private registerRemote(
    workspace: string,
    peer: string,
    functions: unknown,
    takeOver = true,
  ): void {
    const key = `${workspace}\n${peer}`;
    const dropped = this.remoteBays.get(key) ?? [];
    for (const bay of dropped) this.options.bus.unregisterBay(bay);
    this.offers.set(key, functions);
    // A bay this route dropped may still be offered through another workspace of the peer.
    if (takeOver && dropped.length > 0) {
      this.remoteBays.delete(key);
      this.takeOver(peer, key);
    }
    const doc = this.trusted.get(workspace)!.workspace.member(peer, new Date(this.now()))!;
    const bays = new Set<string>();
    if (!Array.isArray(functions)) return void this.remoteBays.delete(key);
    for (const f of functions as { bayId?: unknown; spec?: Partial<FunctionSpec> }[]) {
      const name = f?.spec?.name;
      if (
        typeof f?.bayId !== 'string' ||
        !BAY_ID.test(f.bayId) ||
        typeof name !== 'string' ||
        !FUNCTION_NAME.test(name)
      )
        continue;
      const bayId = remoteBayId(doc, f.bayId);
      const target = `${f.bayId}/${name}`;
      try {
        this.options.bus.registerTransport(
          bayId,
          {
            name,
            // Outgoing: asking locally is enough; the other side decides about its own function.
            sensitive: false,
            ...(typeof f.spec?.description === 'string' && { description: f.spec.description }),
            ...(isObject(f.spec?.inputSchema) && { inputSchema: f.spec.inputSchema }),
          },
          {
            invoke: (_t, args, info) => this.callRemote(workspace, peer, target, args, info.caller),
          },
        );
        bays.add(bayId);
      } catch {
        // Same function already known through another workspace.
      }
    }
    this.remoteBays.set(key, [...bays]);
  }

  /** The peer's other routes register again what is missing on the bus. */
  private takeOver(peer: string, except?: string): void {
    for (const [key, functions] of this.offers) {
      const [ws, p] = key.split('\n') as [string, string];
      if (p === peer && key !== except) this.registerRemote(ws, p, functions, false);
    }
  }

  private callRemote(
    workspace: string,
    peer: string,
    target: string,
    args: unknown,
    caller: Caller,
  ): Promise<unknown> {
    const open = [...this.calls.values()].filter((c) => c.peer === peer).length;
    if (open >= MAX_OPEN_CALLS)
      return Promise.reject(new Error('Too many open calls to this instance'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let seq: number;
      try {
        seq = this.seal(workspace, peer, { t: 'call', id, bayId: caller.bayId, target, args })
          .header.seq;
      } catch (error) {
        return reject(error as Error);
      }
      const timer = setTimeout(
        () => this.finish(id, new Error('The call timed out')),
        this.options.callTimeoutMs ?? CALL_TIMEOUT_MS,
      );
      this.calls.set(id, { peer, workspace, seq, resolve, reject, timer });
    });
  }

  private finish(id: string, error?: Error, value?: unknown): void {
    const call = this.calls.get(id);
    if (!call) return;
    this.calls.delete(id);
    clearTimeout(call.timer);
    if (error) call.reject(error);
    else call.resolve(value);
  }

  private async answer(
    workspace: string,
    peer: string,
    body: Extract<Body, { t: 'call' }>,
  ): Promise<void> {
    const now = this.now();
    for (const [id, at] of this.seenCalls) if (at < now - CALL_ID_MS) this.seenCalls.delete(id);
    if (typeof body.id !== 'string' || this.seenCalls.has(`${peer}\n${body.id}`)) return;
    this.seenCalls.set(`${peer}\n${body.id}`, now);
    let result: Body;
    // Handlers here may run longer than the caller waits: count until they end (ADR 0011).
    const running = this.answering.get(peer) ?? 0;
    this.answering.set(peer, running + 1);
    try {
      if (running >= MAX_OPEN_CALLS) throw new Error('Too many open calls from this instance');
      if (
        typeof body.bayId !== 'string' ||
        !BAY_ID.test(body.bayId) ||
        typeof body.target !== 'string'
      ) {
        throw new Error('Invalid call');
      }
      const caller: Caller = { kind: 'remote', instance: peer, workspace, bayId: body.bayId };
      result = {
        t: 'result',
        id: body.id,
        ok: true,
        value: await this.options.bus.call(caller, body.target, body.args),
      };
    } catch (error) {
      result = { t: 'result', id: body.id, ok: false, error: (error as Error).message };
    } finally {
      this.answering.set(peer, this.answering.get(peer)! - 1);
    }
    try {
      this.seal(workspace, peer, result);
    } catch {
      // The caller left meanwhile.
    }
  }

  private closed(): void {
    for (const id of [...this.calls.keys()]) this.finish(id, new Error('Relay connection closed'));
    for (const r of this.requests.values()) r.reject(new Error('Relay connection closed'));
    this.requests.clear();
    for (const bays of this.remoteBays.values())
      for (const bay of bays) this.options.bus.unregisterBay(bay);
    this.remoteBays.clear();
    this.offers.clear();
    this.peerStates.clear();
    this.statesChanged();
    for (const l of this.closeListeners) l();
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
