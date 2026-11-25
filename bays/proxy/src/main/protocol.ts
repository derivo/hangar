// JSON lines between the bay and the addon in mitmdump (ADR 0049, "Bay and engine").

type Headers = [string, string][];
/** Bodies and chunks are base64, at most 1 MB per direction; the addon redacts URLs and headers. */
export type AddonEvent =
  | { type: 'hello'; version: string }
  | {
      type: 'flow.request';
      id: string;
      port: number;
      time: number;
      method: string;
      url: string;
      headers: Headers;
      body: string | null;
      truncated: boolean;
      /** `Content-Encoding`: the body is as sent, never inflated by the addon. */
      encoding: string | null;
    }
  | {
      type: 'flow.response';
      id: string;
      status: number;
      headers: Headers;
      body: string | null;
      truncated: boolean;
      /** `Content-Encoding`: the body is as sent, never inflated by the addon. */
      encoding: string | null;
    }
  | { type: 'flow.done'; id: string; bytesUp: number; bytesDown: number; closeCode?: number }
  | { type: 'flow.error'; id: string; error: string }
  | { type: 'stream.chunk'; id: string; direction: 'up' | 'down'; data: string }
  | {
      type: 'ws.message';
      id: string;
      direction: 'up' | 'down';
      kind: 'text' | 'binary';
      data: string;
      truncated: boolean;
    }
  | { type: 'ws.tooLarge'; id: string; buffered: number }
  | {
      type: 'tunnel';
      id: string;
      port: number;
      time: number;
      host: string;
      hostPort: number;
      bytesUp: number;
      bytesDown: number;
      error: string | null;
    }
  | { type: 'tls.failed'; port: number; host: string; hostPort: number; error: string | null };

const EVENTS = new Set([
  'hello',
  'flow.request',
  'flow.response',
  'flow.done',
  'flow.error',
  'stream.chunk',
  'ws.message',
  'ws.tooLarge',
  'tunnel',
  'tls.failed',
]);

export interface ProtocolOptions {
  timeoutMs?: number;
  maxLines?: number;
  maxBytes?: number;
}

interface Pending {
  resolve(): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Commands with request ids and a 5 s answer limit; the queue in front of a full pipe and
 * an incoming line are bounded (1 000 lines, 8 MB). Broken or unknown lines are counted.
 */
export class Protocol {
  readonly warnings = { broken: 0, unknown: 0, overflow: 0, dropped: 0 };
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly queue: { id: number; line: string }[] = [];
  private queued = 0;
  private full = false;
  private closed: string | undefined;
  private partial = '';
  private skipping = false;
  private readonly timeoutMs: number;
  private readonly maxLines: number;
  private readonly maxBytes: number;

  /**
   * @param write - Writes one line; `false` means the pipe is full until `drain`.
   * @param onEvent - Receives every known event except replies.
   */
  constructor(
    private readonly write: (line: string) => boolean,
    private readonly onEvent: (event: AddonEvent) => void,
    options: ProtocolOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.maxLines = options.maxLines ?? 1000;
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  }

  /** Sends `op` and resolves on an `ok` reply. */
  request(op: string, args: Record<string, unknown>): Promise<void> {
    if (this.closed) return Promise.reject(new Error(this.closed));
    const id = this.nextId++;
    const line = `${JSON.stringify({ id, op, ...args })}\n`;
    if (
      this.full &&
      (this.queue.length >= this.maxLines || this.queued + line.length > this.maxBytes)
    ) {
      this.warnings.overflow++;
      return Promise.reject(new Error(`${op}: command queue is full`));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Never sent: it must not run after its caller gave up.
        const queued = this.queue.findIndex((q) => q.id === id);
        if (queued !== -1) this.queued -= this.queue.splice(queued, 1)[0]!.line.length;
        reject(new Error(`${op}: no answer within ${this.timeoutMs / 1000} s`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (this.full) {
        this.queue.push({ id, line });
        this.queued += line.length;
      } else this.full = !this.write(line);
    });
  }

  /** The pipe has room again. */
  drain(): void {
    this.full = false;
    while (!this.full && this.queue.length) {
      const { line } = this.queue.shift()!;
      this.queued -= line.length;
      this.full = !this.write(line);
    }
  }

  /** Feeds output of the addon. */
  receive(chunk: string): void {
    let start = 0;
    for (let end = chunk.indexOf('\n'); end !== -1; end = chunk.indexOf('\n', start)) {
      const line = this.partial + chunk.slice(start, end);
      this.partial = '';
      start = end + 1;
      if (this.skipping) this.skipping = false;
      else this.line(line);
    }
    if (this.skipping) return;
    this.partial += chunk.slice(start);
    if (this.partial.length > this.maxBytes) {
      this.warnings.broken++;
      this.partial = '';
      this.skipping = true;
    }
  }

  /** Rejects every open and later command with `reason`. */
  close(reason: string): void {
    this.closed = reason;
    this.queue.length = 0;
    this.queued = 0;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private line(text: string): void {
    if (text.length > this.maxBytes) {
      this.warnings.broken++;
      return;
    }
    if (!text.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      this.warnings.broken++;
      return;
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      this.warnings.broken++;
      return;
    }
    const m = msg as {
      type?: unknown;
      id?: unknown;
      ok?: unknown;
      error?: unknown;
      count?: unknown;
    };
    if (m.type === 'reply') {
      const p = typeof m.id === 'number' ? this.pending.get(m.id) : undefined;
      if (!p) {
        this.warnings.unknown++;
        return;
      }
      this.pending.delete(m.id as number);
      clearTimeout(p.timer);
      if (m.ok === true) p.resolve();
      else p.reject(new Error(String(m.error ?? 'failed')));
    } else if (m.type === 'dropped') this.warnings.dropped += Number(m.count) || 0;
    // The addon could not read one of our lines.
    else if (m.type === 'warning') this.warnings.broken++;
    else if (typeof m.type === 'string' && EVENTS.has(m.type)) this.onEvent(msg as AddonEvent);
    else this.warnings.unknown++;
  }
}
