import { createHash, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import {
  fingerprint,
  MAX_MESSAGE_BYTES,
  publicKey,
  RELAY_PROTOCOL_VERSION,
  RELAY_VERSIONS,
  signedChallenge,
  verifyIdentity,
  Workspace,
  writeDurable,
  type FromRelay,
  type IdentityDocument,
  type MemberList,
  type ToRelay,
} from '@hangar/relay';
import { WebSocketServer, type WebSocket } from 'ws';

export interface RelayOptions {
  /** `relay.json`: workspaces, their members' fingerprints, invitations and member lists. */
  file: string;
  host?: string;
  port?: number;
  /**
   * Address instances use (`wss://relay.example.com:7430`); proofs are bound to it. Defaults
   * to the address the relay listens on.
   */
  origin?: string;
  /** Token of the operator; whoever knows it may create workspaces. */
  operatorToken: string;
  /** PEM certificate and key; without them only a loopback address is allowed. */
  tls?: { cert: string; key: string };
  /** Lines for the log; never the content of a message. */
  log?: (line: string) => void;
  now?: () => number;
}

export interface Relay {
  url: string;
  close(): Promise<void>;
}

/** Invitations expire after a week (ADR 0011: no account, no mail, only this token). */
const INVITE_MS = 7 * 24 * 60 * 60 * 1000;
const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
/** Open invitations per workspace; each one is kept in `relay.json`. */
const MAX_INVITES = 20;
/** Bytes queued for one connection before the relay drops it instead of buffering on. */
const MAX_BUFFERED = 8 * MAX_MESSAGE_BYTES;

interface WorkspaceRecord {
  /** Fingerprints the relay forwards between. */
  members: string[];
  /** `by`: fingerprint of the member who invited (missing in older `relay.json`). */
  invites: { hash: string; expires: number; by?: string }[];
  list: MemberList;
  /** Identity documents of instances that joined and are not in the list yet. */
  joined: Record<string, IdentityDocument>;
  /** Per joined instance the member who invited it. */
  invitedBy?: Record<string, string>;
}
type State = Record<string, WorkspaceRecord>;

/** The `inviter` field of a `joined` message, if the relay knows who invited `fp`. */
const inviter = (w: WorkspaceRecord, fp: string) =>
  w.invitedBy && Object.hasOwn(w.invitedBy, fp) ? { inviter: w.invitedBy[fp]! } : {};
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const sameToken = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
/** `check` throws for a list the instances would refuse. */
function validList(check: () => void, list: MemberList, name: string, signer?: string): boolean {
  try {
    check();
  } catch {
    return false;
  }
  return list.workspace === name && (signer === undefined || list.signer === signer);
}
const listed = (w: WorkspaceRecord) => new Set(w.list.members.map(fingerprint));
const isLoopback = (host: string) => host === '127.0.0.1' || host === '::1' || host === 'localhost';

/** Starts the relay: authenticates instances by their key and forwards sealed envelopes. */
export async function startRelay(options: RelayOptions): Promise<Relay> {
  const host = options.host ?? '127.0.0.1';
  if (!options.tls && !isLoopback(host))
    throw new Error('Without TLS the relay listens on loopback only');
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const state: State = existsSync(options.file)
    ? (JSON.parse(readFileSync(options.file, 'utf8')) as State)
    : Object.create(null);
  // Durable before the answer: a consumed invitation or a revocation must not come back.
  const save = () => writeDurable(options.file, JSON.stringify(state), 0o600);
  /** Sends, or drops a connection that does not read (it would fill the relay's memory). */
  const push = (ws: WebSocket, m: FromRelay): boolean => {
    // A closing socket is still in `online` until its close event; `ws` would drop silently.
    if (ws.readyState !== ws.OPEN) return false;
    if (ws.bufferedAmount > MAX_BUFFERED) {
      ws.terminate();
      return false;
    }
    ws.send(JSON.stringify(m));
    return true;
  };
  const workspace = (name: string) => (Object.hasOwn(state, name) ? state[name] : undefined);

  const online = new Map<string, WebSocket>();
  // Known once listening (the port may be chosen by the system); no proof is checked before.
  let origin = '';
  // Plain requests: only the health check for the container and monitoring, no content.
  const respond = (req: IncomingMessage, res: ServerResponse) => {
    const ok = req.method === 'GET' && req.url === '/health';
    res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
    res.end(ok ? JSON.stringify({ ok: true, version: RELAY_PROTOCOL_VERSION }) : '{}');
  };
  const http: Server = options.tls
    ? createHttpsServer(options.tls, respond)
    : createHttpServer(respond);
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_MESSAGE_BYTES });

  wss.on('connection', (ws) => {
    let nonce: string | undefined;
    let identity: IdentityDocument | undefined;
    let me: string | undefined;
    const send = (m: FromRelay) => void push(ws, m);
    // An oversized frame ends in an error event; without a listener it would end the process.
    ws.on('error', () => ws.terminate());
    const fail = (message: string) => {
      send({ type: 'error', message });
      ws.close();
    };
    ws.on('close', () => {
      if (me && online.get(me) === ws) online.delete(me);
    });
    ws.on('message', (data) => {
      try {
        handle(data);
      } catch {
        // Malformed fields deep inside a message: never take the relay down.
        fail('Invalid message');
      }
    });
    const handle = (data: unknown) => {
      let m: ToRelay;
      try {
        m = JSON.parse(String(data)) as ToRelay;
      } catch {
        return fail('Invalid message');
      }
      if (typeof m !== 'object' || m === null) return fail('Invalid message');
      if (!me) {
        if (m.type === 'hello' && !nonce) {
          if (!Array.isArray(m.versions) || !m.versions.some((v) => RELAY_VERSIONS.includes(v))) {
            return fail('No common protocol version');
          }
          if (!verifyIdentity(m.identity)) return fail('Invalid identity document');
          identity = m.identity;
          nonce = randomBytes(32).toString('base64url');
          return send({ type: 'challenge', version: RELAY_PROTOCOL_VERSION, nonce });
        }
        if (m.type === 'prove' && nonce && identity && typeof m.sig === 'string') {
          const ok = verify(
            null,
            signedChallenge(nonce, origin),
            publicKey('Ed25519', identity.ed25519),
            Buffer.from(m.sig, 'base64url'),
          );
          if (!ok) return fail('Invalid proof');
          me = fingerprint(identity);
          online.get(me)?.close();
          online.set(me, ws);
          log(`connected ${me.slice(0, 16)}`);
          const mine = Object.entries(state)
            .filter(([, w]) => w.members.includes(me!))
            .map(([name, w]) => ({ workspace: name, list: w.list }));
          send({ type: 'ready', workspaces: mine });
          // Joined instances a member has not added yet: asked again until someone does.
          for (const { workspace: name } of mine) {
            const w = state[name]!;
            const inList = listed(w);
            for (const [fp, doc] of Object.entries(w.joined)) {
              if (!inList.has(fp) && fp !== me)
                send({ type: 'joined', workspace: name, identity: doc, ...inviter(w, fp) });
            }
          }
          return;
        }
        return fail('Not authenticated');
      }
      const reply = (id: number, error?: string, value?: unknown) =>
        send(
          error
            ? { type: 'result', id, ok: false, error }
            : { type: 'result', id, ok: true, value },
        );
      switch (m.type) {
        case 'create': {
          if (typeof m.workspace !== 'string' || !WORKSPACE_NAME.test(m.workspace))
            return reply(m.id, 'Invalid workspace name');
          if (typeof m.token !== 'string' || !sameToken(m.token, options.operatorToken))
            return reply(m.id, 'Invalid operator token');
          if (workspace(m.workspace)) return reply(m.id, 'Workspace exists');
          if (!validList(() => new Workspace(m.list, new Date(now())), m.list, m.workspace, me)) {
            return reply(m.id, 'Invalid member list');
          }
          state[m.workspace] = { members: [me], invites: [], list: m.list, joined: {} };
          save();
          log(`workspace created ${m.workspace}`);
          return reply(m.id);
        }
        case 'invite': {
          const w = workspace(m.workspace);
          if (!w?.members.includes(me)) return reply(m.id, 'Not a member');
          w.invites = w.invites.filter((i) => i.expires > now());
          if (w.invites.length >= MAX_INVITES) return reply(m.id, 'Too many open invitations');
          const token = randomBytes(24).toString('base64url');
          w.invites.push({ hash: hash(token), expires: now() + INVITE_MS, by: me });
          save();
          return reply(m.id, undefined, token);
        }
        case 'join': {
          const w = workspace(m.workspace);
          const invite =
            typeof m.token === 'string'
              ? w?.invites.find((i) => i.hash === hash(m.token) && i.expires > now())
              : undefined;
          if (!w || !invite) return reply(m.id, 'Invalid invitation');
          if (w.list.revoked.includes(me)) return reply(m.id, 'Revoked');
          w.invites = w.invites.filter((i) => i !== invite);
          if (!w.members.includes(me)) w.members.push(me);
          w.joined[me] = identity!;
          if (invite.by) (w.invitedBy ??= {})[me] = invite.by;
          save();
          log(`joined ${m.workspace} ${me.slice(0, 16)}`);
          for (const fp of w.members) {
            const peer = online.get(fp);
            if (fp !== me && peer)
              push(peer, {
                type: 'joined',
                workspace: m.workspace,
                identity: identity!,
                ...inviter(w, me),
              });
          }
          return reply(m.id, undefined, w.list);
        }
        case 'list': {
          const w =
            m.list && typeof m.list.workspace === 'string'
              ? workspace(m.list.workspace)
              : undefined;
          if (!w?.members.includes(me)) return reply(m.id, 'Not a member');
          // Every instance checks trust itself; the relay applies the same rules so nobody can
          // block the workspace with a junk list of a huge version.
          if (m.list.version <= w.list.version)
            return reply(m.id, 'Not newer than the stored list');
          const valid = validList(
            () => new Workspace(w.list, new Date(now())).accept(m.list, new Date(now())),
            m.list,
            m.list.workspace,
          );
          if (!valid) return reply(m.id, 'Invalid member list');
          w.list = m.list;
          w.members = w.members.filter((fp) => !m.list.revoked.includes(fp));
          const inList = listed(w);
          for (const fp of Object.keys(w.joined))
            if (inList.has(fp) || !w.members.includes(fp)) {
              delete w.joined[fp];
              delete w.invitedBy?.[fp];
            }
          save();
          for (const fp of w.members) {
            const peer = online.get(fp);
            if (fp !== me && peer) push(peer, { type: 'list', list: m.list });
          }
          return reply(m.id);
        }
        case 'send': {
          const h = m.envelope?.header;
          if (
            typeof h?.to !== 'string' ||
            typeof h.workspace !== 'string' ||
            typeof h.seq !== 'number'
          ) {
            return send({ type: 'error', message: 'Not allowed' });
          }
          const undeliverable = (reason: 'offline' | 'refused') =>
            send({ type: 'undeliverable', to: h.to, workspace: h.workspace, seq: h.seq, reason });
          const w = workspace(h.workspace);
          if (h.from !== me || !w?.members.includes(me) || !w.members.includes(h.to)) {
            return undeliverable('refused');
          }
          const target = online.get(h.to);
          if (!target || !push(target, { type: 'deliver', envelope: m.envelope }))
            return undeliverable('offline');
          return;
        }
        default:
          return fail('Unknown message');
      }
    };
  });

  await new Promise<void>((resolve) => http.listen(options.port ?? 0, host, resolve));
  const { port } = http.address() as AddressInfo;
  const url = `${options.tls ? 'wss' : 'ws'}://${host.includes(':') ? `[${host}]` : host}:${port}`;
  origin = new URL(options.origin ?? url).origin;
  log(`relay listening on ${url}`);
  return {
    url,
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
