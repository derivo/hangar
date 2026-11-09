import { createPublicKey, randomBytes, verify } from 'node:crypto';
import type { Decision, PermissionRequest } from '@hangar/bus';
import {
  fingerprint,
  PROTOCOL_VERSION,
  signedHello,
  type BayInfo,
  type ClientMessage,
  type JobAction,
  type JobView,
  type LocalCaller,
  type Notification,
  type OfferedFunction,
  type ServerMessage,
} from './protocol';

export interface ConnectOptions {
  /** e.g. `ws://127.0.0.1:7420/connect`. */
  url: string;
  /** Confirmed fingerprint; a server with another key is rejected. */
  fingerprint?: string;
  /** Token from an earlier pairing; sent only after the server proved its key. */
  token?: string;
  /** How long to wait for the server's `welcome` (default 10 s). */
  timeoutMs?: number;
  /** The desktop's language, sent with `auth` and `pair`; the server's bays speak it. */
  locale?: string;
}

/** A server message, or `undefined` if the text is not JSON. */
function decode(text: unknown): ServerMessage | undefined {
  try {
    return JSON.parse(text as string) as ServerMessage;
  } catch {
    return undefined;
  }
}

// Requests carry an id the connection assigns.
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
type Request = WithoutId<Extract<ClientMessage, { id: number }>>;

/** Open permission questions per connection (shown and waiting); a flooding server gets no more. */
const MAX_OPEN_QUESTIONS = 10;
/** Notifications per connection and minute: the 50 a server keeps and a few more. */
const MAX_NOTIFICATIONS_PER_MINUTE = 60;
/** Badges above are shown as this (the sidebar shows 99+ anyway). */
const MAX_BADGE = 9999;

type Asker = (request: PermissionRequest, signal: AbortSignal) => Promise<Decision>;

/** A question shaped like the bus asks it; anything else reaches no dialog. */
function isQuestion(value: unknown): value is PermissionRequest {
  const q = value as Record<string, unknown> | null;
  if (typeof q !== 'object' || q === null) return false;
  const caller = q.caller as Record<string, unknown> | null;
  return (
    typeof q.target === 'string' &&
    typeof q.sensitive === 'boolean' &&
    (q.kind === 'grant' || q.kind === 'confirm') &&
    typeof caller === 'object' &&
    caller !== null &&
    typeof caller.bayId === 'string' &&
    (caller.kind === 'bay' ||
      (caller.kind === 'session' && typeof caller.sessionId === 'string') ||
      (caller.kind === 'remote' &&
        typeof caller.instance === 'string' &&
        typeof caller.workspace === 'string'))
  );
}

const isNotification = (n: unknown): n is Notification => {
  const v = n as Record<string, unknown> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.title === 'string' &&
    (v.body === undefined || typeof v.body === 'string')
  );
};

const isNumber = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
/** A time `Date` can show (±8.64e15 ms); larger ones make `toISOString` throw. */
const isTime = (v: unknown) => isNumber(v) && Math.abs(v as number) <= 8.64e15;

/** A job as the scheduler lists it; the job list renders these fields. */
function isJob(value: unknown): value is JobView {
  const j = value as Record<string, unknown> | null;
  if (typeof j !== 'object' || j === null) return false;
  const run = j.lastRun as Record<string, unknown> | null | undefined;
  return (
    ['id', 'bayId', 'label', 'schedule'].every((k) => typeof j[k] === 'string') &&
    ['paused', 'running', 'available'].every((k) => typeof j[k] === 'boolean') &&
    (j.nextRun === undefined || isTime(j.nextRun)) &&
    (run === undefined ||
      (typeof run === 'object' &&
        run !== null &&
        isTime(run.at) &&
        isNumber(run.durationMs) &&
        typeof run.ok === 'boolean' &&
        typeof run.output === 'string'))
  );
}

const isCaller = (v: unknown): v is LocalCaller => {
  const c = v as Record<string, unknown> | null;
  return (
    typeof c === 'object' &&
    c !== null &&
    typeof c.bayId === 'string' &&
    (c.sessionId === undefined || typeof c.sessionId === 'string')
  );
};

/** `signal` aborts when the connection closes: the server gave the call up. */
type CallHandler = (
  target: string,
  args: unknown,
  caller: LocalCaller,
  signal: AbortSignal,
) => Promise<unknown>;

/** An open connection to a Hangar server. */
export class Connection {
  paired = false;
  bays: BayInfo[] = [];
  /** How many agent sessions run on the server, once it said so (ADR 0036). */
  sessions?: number;
  /** The server bays' badges (phase 11c), only for bays in `bays`. */
  badges: Record<string, number> = {};
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve(v: unknown): void; reject(e: Error): void }
  >();
  private readonly listeners: ((bay: string, channel: string, payload: unknown) => void)[] = [];
  private readonly closeListeners: (() => void)[] = [];
  private readonly badgeListeners: (() => void)[] = [];
  private readonly jobListeners: (() => void)[] = [];
  private readonly workspaceListeners: (() => void)[] = [];
  private readonly sessionListeners: (() => void)[] = [];
  private notifier?: (bay: string, notification: Notification) => void;
  /** Notifications that came before `onNotify` (right after auth: those kept on the server). */
  private readonly notifications: [string, Notification][] = [];
  /**
   * `notify` and `badge` before `pair`/`auth` resolved: the server sends them right after its
   * answer, and several messages may arrive in one task, before `bays` is set.
   */
  private early: ServerMessage[] = [];
  private notified = { since: 0, count: 0 };
  private asker?: Asker;
  // One question at a time; waiting ones are kept until the asker is set (right after auth).
  private readonly waiting: { id: number; request: PermissionRequest }[] = [];
  private shown?: { id: number; dialog: AbortController };
  /** The server numbers its questions upwards: an id not above the last is a replay. */
  private lastQuestion = 0;
  private closed = false;
  private caller?: CallHandler;
  private readonly calls = new Set<AbortController>();
  private readonly sessionEndListeners: ((bayId: string, sessionId: string) => void)[] = [];

  constructor(
    private readonly ws: WebSocket,
    readonly fingerprint: string,
    /** The protocol version both speak (`welcome`). */
    readonly version = PROTOCOL_VERSION,
  ) {
    ws.addEventListener('message', (e) => {
      const message = decode(e.data);
      // A server that sends garbage is not one to keep talking to.
      if (!message) return ws.close();
      this.receive(message);
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      this.shown?.dialog.abort();
      for (const c of this.calls) c.abort();
      this.waiting.length = 0;
      for (const p of this.pending.values()) p.reject(new Error('Connection closed'));
      this.pending.clear();
      for (const l of this.closeListeners) l();
    });
  }

  /** Pairs with the code the server logged; resolves to the token for later connections. */
  async pair(code: string, name: string, locale?: string): Promise<string> {
    const { token, bays } = (await this.request({ type: 'pair', code, name, locale })) as {
      token: string;
      bays: BayInfo[];
    };
    this.bays = bays;
    this.ready();
    return token;
  }

  async auth(token: string, locale?: string): Promise<void> {
    this.bays = (await this.request({ type: 'auth', token, locale })) as BayInfo[];
    this.ready();
  }

  private ready(): void {
    this.paired = true;
    for (const m of this.early.splice(0)) this.receive(m);
  }

  /** Calls a UI channel of a bay on the server, like `window.hangar.invoke`. */
  invoke(bay: string, channel: string, args: unknown[]): Promise<unknown> {
    return this.request({ type: 'invoke', bay, channel, args });
  }

  /** The server's jobs (phase 11d); without an answer in `timeoutMs` this fails. */
  async jobs(timeoutMs?: number): Promise<JobView[]> {
    const jobs = await this.request({ type: 'jobs' }, timeoutMs);
    if (!Array.isArray(jobs) || !jobs.every(isJob)) {
      throw new Error('Invalid message from the server');
    }
    return jobs;
  }

  /** Pauses, resumes, runs (resolves after the run) or removes a server job. */
  async job(action: JobAction, id: string): Promise<void> {
    await this.request({ type: 'job', action, job: id });
  }

  /** Offers functions of the desktop's bays to the local server (ADR 0036, protocol 3). */
  async offer(functions: OfferedFunction[]): Promise<void> {
    await this.request({ type: 'offer', functions });
  }

  /** Runs an action of Settings → Workspaces on the server's workspaces (protocol 4). */
  workspaces(action: string, args: (string | boolean)[]): Promise<unknown> {
    return this.request({ type: 'workspaces', action, args });
  }

  /** Called when the server's workspaces changed. */
  onWorkspaces(listener: () => void): void {
    this.workspaceListeners.push(listener);
  }

  /** Runs the server's calls of offered functions; the last handler set counts. */
  onCall(handler: CallHandler): void {
    this.caller = handler;
  }

  /** Called after `sessions` changed. */
  onSessions(listener: () => void): void {
    this.sessionListeners.push(listener);
  }

  /** An agent session on the server ended. */
  onSessionEnded(listener: (bayId: string, sessionId: string) => void): void {
    this.sessionEndListeners.push(listener);
  }

  /** Called when the server's jobs or their results changed. */
  onJobs(listener: () => void): void {
    this.jobListeners.push(listener);
  }

  /** Events the server's bays send to their UI (`ctx.ui.send`). */
  onEvent(listener: (bay: string, channel: string, payload: unknown) => void): void {
    this.listeners.push(listener);
  }

  /**
   * Answers the server's permission questions (phase 11b), one at a time; `signal` aborts
   * when the connection closes or the server withdraws the question. Without an answer the
   * server gives up and stores nothing.
   */
  onAsk(asker: Asker): void {
    this.asker = asker;
    void this.nextQuestion();
  }

  /** Notifications of the server's bays; those that came before are passed on now. */
  onNotify(notifier: (bay: string, notification: Notification) => void): void {
    this.notifier = notifier;
    for (const [bay, n] of this.notifications.splice(0)) notifier(bay, n);
  }

  /** Called after a badge in `badges` changed. */
  onBadge(listener: () => void): void {
    this.badgeListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  close(): void {
    // At once: the `close` event follows only after the closing handshake (Codex).
    for (const c of this.calls) c.abort();
    this.ws.close();
  }

  private async nextQuestion(): Promise<void> {
    if (this.shown || !this.asker) return;
    const question = this.waiting.shift();
    if (!question) return;
    // One signal per question: Electron keeps a dialog's abort listener on its signal.
    const dialog = new AbortController();
    this.shown = { id: question.id, dialog };
    try {
      const decision = await this.asker(question.request, dialog.signal);
      if (!dialog.signal.aborted && !this.closed) {
        this.ws.send(JSON.stringify({ type: 'answer', id: question.id, decision }));
      }
    } catch {
      // No answer: the server gives up after its timeout.
    } finally {
      this.shown = undefined;
      void this.nextQuestion();
    }
  }

  private request(message: Request, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // Given up on: the request is dropped, a late answer finds nothing.
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`No answer from the server within ${timeoutMs / 1000} s`));
            }, timeoutMs);
      const done =
        <T>(f: (v: T) => void) =>
        (v: T) => {
          clearTimeout(timer);
          f(v);
        };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      this.ws.send(JSON.stringify({ ...message, id }));
    });
  }

  private receive(message: ServerMessage): void {
    if (message.type === 'ask') {
      const { id, request } = message;
      if (!Number.isInteger(id) || id <= this.lastQuestion || !isQuestion(request)) return;
      if (this.waiting.length + (this.shown ? 1 : 0) >= MAX_OPEN_QUESTIONS) return;
      this.lastQuestion = id;
      this.waiting.push({ id, request });
      void this.nextQuestion();
    } else if (message.type === 'withdraw') {
      const waiting = this.waiting.findIndex((q) => q.id === message.id);
      if (waiting >= 0) this.waiting.splice(waiting, 1);
      if (this.shown?.id === message.id) this.shown.dialog.abort();
    } else if ((message.type === 'notify' || message.type === 'badge') && !this.paired) {
      // ponytail: the server sends at most 50 kept notifications plus one badge per bay.
      if (this.early.length < 500) this.early.push(message);
    } else if (message.type === 'notify') {
      const { bay, notification } = message;
      // Only the server's own bays, shaped like a notification; the rest is dropped.
      if (!this.bays.some((b) => b.id === bay) || !isNotification(notification)) return;
      const now = Date.now();
      if (now - this.notified.since > 60_000) this.notified = { since: now, count: 0 };
      if (++this.notified.count > MAX_NOTIFICATIONS_PER_MINUTE) return;
      const n = {
        title: notification.title.slice(0, 200),
        ...(notification.body !== undefined && { body: notification.body.slice(0, 1000) }),
      };
      if (this.notifier) this.notifier(bay, n);
      // Kept until onNotify, which follows pair or auth at once.
      else this.notifications.push([bay, n]);
    } else if (message.type === 'badge') {
      const { bay, count } = message;
      if (!this.bays.some((b) => b.id === bay) || !Number.isInteger(count) || count < 0) return;
      if (this.badges[bay] === Math.min(count, MAX_BADGE)) return;
      this.badges[bay] = Math.min(count, MAX_BADGE);
      for (const l of this.badgeListeners) l();
    } else if (message.type === 'call') {
      const { id, target, args, caller } = message;
      if (!Number.isInteger(id) || typeof target !== 'string' || !isCaller(caller)) return;
      const reply = (m: object) => {
        if (!this.closed) this.ws.send(JSON.stringify({ type: 'reply', id, ...m }));
      };
      const run = this.caller ?? (() => Promise.reject(new Error(`Unknown function: ${target}`)));
      const call = new AbortController();
      this.calls.add(call);
      // ponytail: no limit on calls in flight; the server is the one on this machine.
      void Promise.resolve()
        .then(() => run(target, args, caller, call.signal))
        .then(
          (value) => reply({ ok: true, value }),
          (e: Error) => reply({ ok: false, error: e.message }),
        )
        .finally(() => this.calls.delete(call));
    } else if (message.type === 'sessionEnded') {
      const { bayId, sessionId } = message;
      if (typeof bayId !== 'string' || typeof sessionId !== 'string') return;
      for (const l of this.sessionEndListeners) l(bayId, sessionId);
    } else if (message.type === 'sessions') {
      if (!Number.isInteger(message.count) || message.count < 0) return;
      this.sessions = message.count;
      for (const l of this.sessionListeners) l();
    } else if (message.type === 'jobs') {
      for (const l of this.jobListeners) l();
    } else if (message.type === 'workspaces') {
      for (const l of this.workspaceListeners) l();
    } else if (message.type === 'event') {
      for (const l of this.listeners) l(message.bay, message.channel, message.payload);
    } else if (message.type === 'result') {
      const p = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.ok) p?.resolve(message.value);
      // A server that answers with something else than a text gets no say in the error.
      else
        p?.reject(
          new Error(
            typeof message.error === 'string' ? message.error : 'Invalid message from the server',
          ),
        );
    }
  }
}

/**
 * Opens a connection and checks the server's key: it must sign a fresh nonce and,
 * if `fingerprint` is given, match it. With `token`, the connection is paired.
 */
export async function connect(options: ConnectOptions): Promise<Connection> {
  const ws = new WebSocket(options.url);
  const nonce = randomBytes(32).toString('base64');
  const timeoutMs = options.timeoutMs ?? 10_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const welcome = await new Promise<ServerMessage>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${options.url} did not answer within ${timeoutMs / 1000} s`)),
        timeoutMs,
      );
      ws.addEventListener('error', () => reject(new Error(`Cannot reach ${options.url}`)));
      ws.addEventListener('close', () =>
        reject(new Error(`Connection to ${options.url} closed before the server answered`)),
      );
      ws.addEventListener('open', () =>
        ws.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, nonce })),
      );
      ws.addEventListener(
        'message',
        (e) => {
          const message = decode(e.data);
          if (message) resolve(message);
          else reject(new Error('Invalid message from the server'));
        },
        { once: true },
      );
    });
    clearTimeout(timer);
    if (welcome.type === 'error') throw new Error(welcome.message);
    if (welcome.type !== 'welcome') throw new Error(`Unexpected message: ${welcome.type}`);
    const key = createPublicKey({
      key: Buffer.from(welcome.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    if (!verify(null, signedHello(nonce), key, Buffer.from(welcome.signature, 'base64'))) {
      throw new Error('Server signature is invalid');
    }
    const actual = fingerprint(welcome.publicKey);
    if (options.fingerprint && actual !== options.fingerprint) {
      throw new Error(
        `Server fingerprint does not match: expected ${options.fingerprint}, got ${actual}`,
      );
    }
    const connection = new Connection(ws, actual, welcome.version);
    if (options.token) await connection.auth(options.token, options.locale);
    return connection;
  } catch (e) {
    clearTimeout(timer);
    ws.close();
    throw e;
  }
}
