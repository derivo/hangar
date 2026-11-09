import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomInt,
  sign,
  timingSafeEqual,
} from 'node:crypto';
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import {
  fingerprint,
  PROTOCOL_VERSION,
  signedHello,
  SUPPORTED_VERSIONS,
  type BayInfo,
  JOB_ACTIONS,
  type ClientMessage,
  type JobAction,
  type JobView,
  type LocalCaller,
  type Notification,
  type OfferedFunction,
  type ServerMessage,
} from '@hangar/bridge';
import type { Decision, PermissionRequest } from '@hangar/bus';
import { isUiLocale, type UiLocale } from '@hangar/sdk/i18n';
import { WebSocketServer, type WebSocket } from 'ws';

interface BridgeOptions {
  dataDir: string;
  log(line: string): void;
  bays(): BayInfo[];
  invoke(bay: string, channel: string, args: unknown[]): Promise<unknown>;
  /** The scheduler's jobs and what the desktop's job list does with one (phase 11d). */
  jobs(): JobView[];
  job(action: JobAction, id: string): Promise<void>;
  /** How long a desktop has to answer a permission question (default 5 minutes). */
  askTimeoutMs?: number;
  /** Until it settles, desktops are turned away: before it they would see no bays (ADR 0036). */
  ready?: Promise<unknown>;
  /** A paired desktop named its language with `auth` or `pair` (ADR 0019). */
  locale?(locale: UiLocale): void;
  /** A paired desktop offered the functions of its own bays (ADR 0036). */
  offer?(functions: OfferedFunction[]): void;
  /** An action of Settings → Workspaces from a paired desktop (ADR 0036, point 11). */
  workspaces?(action: string, args: (string | boolean)[]): Promise<unknown>;
  /** Why `call` fails without the desktop that offered (default English). */
  desktopClosed?(): string;
}

export interface Bridge {
  /** `SHA256:…` of the server's key, as the desktop checks it. */
  fingerprint: string;
  /**
   * Asks the paired desktop that connected last. Without one, without an answer in time or when it goes
   * away, this throws: the bus then stores nothing, unlike after an answer `deny`.
   */
  ask(request: PermissionRequest): Promise<Decision>;
  /** Sends a bay's UI event to every paired desktop. */
  event(bay: string, channel: string, payload: unknown): void;
  /** To every paired desktop; without one, kept (the last 50) for the next that connects. */
  notify(bay: string, notification: Notification): void;
  /** To every paired desktop; each one gets all current badges when it connects. */
  badge(bay: string, count: number): void;
  /** Tells every paired desktop to list the jobs again. */
  jobsChanged(): void;
  /** Tells every paired desktop to ask for the workspaces again. */
  workspacesChanged(): void;
  /**
   * Calls an offered function on the desktop that offered last (ADR 0036); fails while it is
   * closed or when it goes away before answering.
   */
  call(target: string, args: unknown, caller: LocalCaller): Promise<unknown>;
  /** Tells the desktop that offered that an agent session ended. */
  sessionEnded(bayId: string, sessionId: string): void;
  /** How many agent sessions run, to every paired desktop now and to each that connects. */
  sessions(count: number): void;
  close(): void;
}

interface PairedClient {
  name: string;
  /** SHA-256 of the token; the token itself is not stored. */
  tokenHash: string;
  createdAt: number;
}

/** Open permission questions; the desktop shows no more either (`@hangar/bridge` client). */
const MAX_OPEN_QUESTIONS = 10;
/** Notifications kept while no desktop is connected; older ones are dropped. */
const MAX_KEPT_NOTIFICATIONS = 50;

// No 0/O and 1/I: the code is typed from a log.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** The server's Ed25519 key in `<data>/identity.json`, created on first start. */
function loadIdentity(dataDir: string): { privateKey: KeyObject; publicKey: string } {
  const file = join(dataDir, 'identity.json');
  if (!existsSync(file)) {
    const pair = generateKeyPairSync('ed25519');
    const pem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    writeFileSync(file, JSON.stringify({ privateKey: pem }), { mode: 0o600 });
  }
  const privateKey = createPrivateKey(JSON.parse(readFileSync(file, 'utf8')).privateKey as string);
  const der = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return { privateKey, publicKey: der.toString('base64') };
}

const isId = (v: unknown) => Number.isInteger(v);
const isText = (v: unknown) => typeof v === 'string';
const isOptional = (v: unknown, type: string) => v === undefined || typeof v === type;

/** At most this many functions in one offer; the browser bay has eight. */
const MAX_OFFERED = 500;
/** Session ends kept while no desktop offered (its tabs close with them); older ones dropped. */
const MAX_KEPT_ENDS = 500;

/** An offered function with the fields the bus knows, or `undefined`. */
export function offered(v: unknown): OfferedFunction | undefined {
  const f = v as Record<string, unknown> | null;
  const spec = f?.spec as Record<string, unknown> | null | undefined;
  if (typeof f !== 'object' || f === null || !isText(f.bayId)) return undefined;
  if (typeof spec !== 'object' || spec === null || !isText(spec.name)) return undefined;
  if (typeof spec.sensitive !== 'boolean' || !isOptional(spec.openToAgents, 'boolean')) return;
  if (!isOptional(spec.description, 'string') || spec.inputSchema === null) return;
  if (!isOptional(spec.bayOnly, 'boolean')) return;
  if (!isOptional(spec.inputSchema, 'object')) return;
  // Without `remote`: the local server shares nothing with other instances.
  const { name, sensitive, openToAgents, bayOnly, description, inputSchema } = spec;
  return {
    bayId: f.bayId as string,
    spec: {
      name: name as string,
      sensitive,
      ...(openToAgents !== undefined && { openToAgents: openToAgents as boolean }),
      ...(bayOnly !== undefined && { bayOnly: bayOnly as boolean }),
      ...(description !== undefined && { description: description as string }),
      ...(inputSchema !== undefined && { inputSchema: inputSchema as Record<string, unknown> }),
    },
  };
}

/** A message with the fields its type needs; anything else is `undefined`. */
function parse(text: string): ClientMessage | undefined {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof m !== 'object' || m === null) return undefined;
  // A switch, not a lookup table: `__proto__` must not find a validator.
  const valid = (() => {
    switch (m.type) {
      case 'hello':
        return isId(m.version) && isText(m.nonce);
      case 'auth':
        return isId(m.id) && isText(m.token);
      case 'pair':
        return isId(m.id) && isText(m.code) && isText(m.name);
      case 'invoke':
        return isId(m.id) && isText(m.bay) && isText(m.channel) && Array.isArray(m.args);
      case 'answer':
        return isId(m.id) && isText(m.decision);
      case 'jobs':
        return isId(m.id);
      case 'workspaces':
        return (
          isId(m.id) &&
          isText(m.action) &&
          Array.isArray(m.args) &&
          m.args.every((a) => isText(a) || typeof a === 'boolean')
        );
      case 'job':
        return isId(m.id) && JOB_ACTIONS.includes(m.action as JobAction) && isText(m.job);
      case 'offer':
        return (
          isId(m.id) &&
          Array.isArray(m.functions) &&
          m.functions.length <= MAX_OFFERED &&
          m.functions.every((f) => offered(f))
        );
      case 'reply':
        return isId(m.id) && typeof m.ok === 'boolean' && (m.ok || isText(m.error));
      default:
        // Unknown types pass: they are answered with `Unknown message`.
        return true;
    }
  })();
  return valid ? (m as unknown as ClientMessage) : undefined;
}

/** Choices the desktop offers for this question (as in the desktop's dialog, spec §7). */
function valid(request: PermissionRequest, decision: string): decision is Decision {
  const choices =
    request.kind === 'grant' && request.sensitive
      ? ['allow', 'session', 'ask', 'deny']
      : ['allow', 'deny'];
  return choices.includes(decision);
}

/** Replaces `file` in one step, readable by the owner only. */
export function writePrivate(file: string, text: string): void {
  writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** WebSocket endpoint `/connect` for desktops (ADR 0019): pairing, tokens, invoke, events. */
export function attachBridge(http: Server, options: BridgeOptions): Bridge {
  const { log } = options;
  const identity = loadIdentity(options.dataDir);
  const clientsFile = join(options.dataDir, 'clients.json');
  const clients = (): PairedClient[] =>
    existsSync(clientsFile)
      ? (JSON.parse(readFileSync(clientsFile, 'utf8')) as PairedClient[])
      : [];
  let code = '';
  const newCode = () => {
    const pick = () =>
      Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    code = `${pick()}-${pick()}`;
    log(`pairing code ${code}`);
    // For the desktop on this machine, which pairs with its local server by itself (ADR 0036).
    writePrivate(join(options.dataDir, 'pair-code'), code);
  };
  log(`fingerprint ${fingerprint(identity.publicKey)}`);
  newCode();

  const paired = new Set<WebSocket>();
  // ponytail: in memory; a server restart loses them, like the desktop's own notifications.
  const kept: ServerMessage[] = [];
  const badges = new Map<string, number>();
  let sessions: number | undefined;
  /** A desktop just paired or authenticated: what it missed, then the current badges. */
  const welcomeDesktop = (ws: WebSocket) => {
    // A socket that closed meanwhile would take the kept notifications with it.
    if (!paired.has(ws) || ws.readyState !== ws.OPEN) return;
    for (const m of kept.splice(0)) ws.send(JSON.stringify(m));
    for (const [bay, count] of badges)
      ws.send(JSON.stringify({ type: 'badge', bay, count } satisfies ServerMessage));
    if (sessions !== undefined) {
      ws.send(JSON.stringify({ type: 'sessions', count: sessions } satisfies ServerMessage));
    }
  };
  // A closing socket stays in `paired` until its `close` event; what it gets is lost.
  const open = () => [...paired].filter((ws) => ws.readyState === ws.OPEN);
  const toDesktops = (m: ServerMessage) => {
    const text = JSON.stringify(m);
    for (const ws of open()) ws.send(text);
  };
  let asks = 0;
  const questions = new Map<
    number,
    {
      ws: WebSocket;
      request: PermissionRequest;
      resolve(d: Decision): void;
      fail(why: string): void;
    }
  >();
  /** The desktop whose bays the server calls: the one that offered last (ADR 0036). */
  let offerer: WebSocket | undefined;
  // ponytail: in memory; a server restart loses them, the app's tabs end with its own restart.
  const endedAway: ServerMessage[] = [];
  let nextCall = 0;
  const calls = new Map<
    number,
    { ws: WebSocket; resolve(v: unknown): void; reject(e: Error): void }
  >();
  const desktopClosed = () => new Error(options.desktopClosed?.() ?? 'Hangar is not open');
  // ponytail: 16 MB per message covers terminal scrollback; raise if a bay sends more.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  let ready = !options.ready;
  void options.ready?.finally(() => (ready = true));
  http.on('upgrade', (req, socket, head) => {
    if (req.url !== '/connect') return void socket.destroy();
    // Still starting: the desktop tries again (ServerConnections retries, pairWhenReady too).
    if (!ready) return void socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    wss.handleUpgrade(req, socket, head, (ws) => serve(ws));
  });

  function serve(ws: WebSocket): void {
    let hello = false;
    const send = (m: ServerMessage) => ws.send(JSON.stringify(m));
    const fail = (message: string) => {
      send({ type: 'error', message });
      ws.close();
    };
    // A broken frame (anyone on the loopback can send one) closes this socket, not the server.
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      paired.delete(ws);
      if (offerer === ws) offerer = undefined;
      for (const [id, c] of calls) {
        if (c.ws !== ws) continue;
        calls.delete(id);
        c.reject(desktopClosed());
      }
      for (const q of questions.values()) {
        if (q.ws === ws) q.fail('the desktop went away before answering');
      }
    });
    ws.on('message', (data) => {
      const m = parse(data.toString());
      if (!m) return fail('Invalid message');
      if (m.type === 'hello') {
        if (!SUPPORTED_VERSIONS.includes(m.version)) {
          return fail(
            `Protocol version ${m.version} not supported (server speaks ${PROTOCOL_VERSION})`,
          );
        }
        hello = true;
        const signature = sign(null, signedHello(m.nonce), identity.privateKey);
        return send({
          type: 'welcome',
          version: m.version,
          publicKey: identity.publicKey,
          signature: signature.toString('base64'),
        });
      }
      if (!hello) return fail('Say hello first');
      if (m.type === 'answer') {
        // Only the desktop asked answers; an unknown id or another socket changes nothing.
        const q = questions.get(m.id);
        if (q?.ws !== ws) return;
        return valid(q.request, m.decision)
          ? q.resolve(m.decision)
          : q.fail('invalid answer from the desktop');
      }
      const reply = (work: () => unknown) =>
        Promise.resolve()
          .then(work)
          .then(
            (value) => send({ type: 'result', id: m.id, ok: true, value }),
            (e: Error) => send({ type: 'result', id: m.id, ok: false, error: e.message }),
          );
      if (m.type === 'auth') {
        return void reply(() => {
          const hash = sha256(m.token).toString('hex');
          if (!clients().some((c) => c.tokenHash === hash)) {
            setImmediate(() => ws.close());
            throw new Error('Invalid token');
          }
          paired.add(ws);
          if (isUiLocale(m.locale)) options.locale?.(m.locale);
          return options.bays();
        }).then(() => welcomeDesktop(ws));
      }
      if (m.type === 'pair') {
        return void reply(() => {
          if (m.code.length !== code.length || !timingSafeEqual(sha256(m.code), sha256(code))) {
            throw new Error('Wrong pairing code');
          }
          const token = randomBytes(32).toString('base64url');
          const entry = {
            name: m.name,
            tokenHash: sha256(token).toString('hex'),
            createdAt: Date.now(),
          };
          writeFileSync(clientsFile, JSON.stringify([...clients(), entry], null, 2), {
            mode: 0o600,
          });
          log(`paired ${m.name}`);
          newCode();
          paired.add(ws);
          if (isUiLocale(m.locale)) options.locale?.(m.locale);
          return { token, bays: options.bays() };
        }).then(() => welcomeDesktop(ws));
      }
      if (m.type === 'invoke') {
        return void reply(() => {
          if (!paired.has(ws)) throw new Error('Not paired');
          return options.invoke(m.bay, m.channel, m.args);
        });
      }
      if (m.type === 'reply') {
        // Only the desktop called answers; an unknown id or another socket changes nothing.
        const c = calls.get(m.id);
        if (c?.ws !== ws) return;
        calls.delete(m.id);
        return m.ok ? c.resolve(m.value) : c.reject(new Error(m.error));
      }
      if (m.type === 'offer') {
        return void reply(() => {
          if (!paired.has(ws)) throw new Error('Not paired');
          offerer = ws;
          options.offer?.(m.functions.map((f) => offered(f)!));
          for (const e of endedAway.splice(0)) ws.send(JSON.stringify(e));
        });
      }
      if (m.type === 'workspaces') {
        return void reply(() => {
          if (!paired.has(ws)) throw new Error('Not paired');
          if (!options.workspaces) throw new Error('No workspaces on this server');
          return options.workspaces(m.action, m.args);
        });
      }
      if (m.type === 'jobs' || m.type === 'job') {
        return void reply(() => {
          if (!paired.has(ws)) throw new Error('Not paired');
          return m.type === 'jobs' ? options.jobs() : options.job(m.action, m.job);
        });
      }
      fail('Unknown message');
    });
  }

  return {
    fingerprint: fingerprint(identity.publicKey),
    ask(request) {
      const denied = (why: string) =>
        new Error(`Access denied: ${request.caller.bayId} → ${request.target} (${why})`);
      // ponytail: the paired desktop that connected last; ask all, first answer wins, if needed.
      const ws = [...paired].at(-1);
      if (!ws) {
        return Promise.reject(
          denied('no desktop connected to ask: set a rule in permissions.json'),
        );
      }
      // The desktop shows at most this many too; more would only hold timers here.
      if (questions.size >= MAX_OPEN_QUESTIONS) {
        return Promise.reject(denied('too many open questions'));
      }
      const id = ++asks;
      const timeoutMs = options.askTimeoutMs ?? 5 * 60_000;
      return new Promise<Decision>((resolve, reject) => {
        const end = () => {
          clearTimeout(timer);
          questions.delete(id);
        };
        const timer = setTimeout(() => {
          // Closes the dialog there; a late answer would find no question anyway.
          ws.send(JSON.stringify({ type: 'withdraw', id } satisfies ServerMessage));
          question.fail(`no answer from the desktop within ${timeoutMs / 1000} s`);
        }, timeoutMs);
        const question = {
          ws,
          request,
          resolve: (d: Decision) => (end(), resolve(d)),
          fail: (why: string) => (end(), reject(denied(why))),
        };
        questions.set(id, question);
        ws.send(JSON.stringify({ type: 'ask', id, request } satisfies ServerMessage));
      });
    },
    event(bay, channel, payload) {
      toDesktops({ type: 'event', bay, channel, payload });
    },
    notify(bay, notification) {
      const message = { type: 'notify', bay, notification } satisfies ServerMessage;
      if (open().length > 0) return toDesktops(message);
      kept.push(message);
      if (kept.length > MAX_KEPT_NOTIFICATIONS) kept.shift();
    },
    badge(bay, count) {
      badges.set(bay, count);
      toDesktops({ type: 'badge', bay, count });
    },
    jobsChanged() {
      toDesktops({ type: 'jobs' });
    },
    workspacesChanged() {
      toDesktops({ type: 'workspaces' });
    },
    call(target, args, caller) {
      const ws = offerer;
      if (!ws || ws.readyState !== ws.OPEN) return Promise.reject(desktopClosed());
      const id = ++nextCall;
      return new Promise((resolve, reject) => {
        calls.set(id, { ws, resolve, reject });
        ws.send(JSON.stringify({ type: 'call', id, target, args, caller } satisfies ServerMessage));
      });
    },
    sessions(count) {
      sessions = count;
      toDesktops({ type: 'sessions', count });
    },
    sessionEnded(bayId, sessionId) {
      const message = { type: 'sessionEnded', bayId, sessionId } satisfies ServerMessage;
      if (offerer && offerer.readyState === offerer.OPEN)
        return offerer.send(JSON.stringify(message));
      endedAway.push(message);
      if (endedAway.length > MAX_KEPT_ENDS) endedAway.shift();
    },
    close() {
      for (const q of questions.values()) q.fail('the server is shutting down');
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
