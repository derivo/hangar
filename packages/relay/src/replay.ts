import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { Header } from './envelope';

/** Messages further off the receiver's clock are refused (ADR 0011). */
export const REPLAY_WINDOW_MS = 5 * 60 * 1000;

type State = Record<string, Record<string, { seq: number; ts: number }>>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Only a state of the right shape counts; anything else would accept replays. */
function read(file: string): State {
  if (!existsSync(file)) return {};
  let state: unknown;
  try {
    state = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    state = undefined;
  }
  const ok =
    isRecord(state) &&
    Object.values(state).every(
      (epochs) =>
        isRecord(epochs) &&
        Object.values(epochs).every(
          (e) => isRecord(e) && Number.isSafeInteger(e.seq) && Number.isFinite(e.ts),
        ),
    );
  if (!ok) throw new Error(`Broken replay state: ${file}`);
  return state as State;
}

/**
 * Last accepted number per sender and epoch, written to disk before a message runs, so a
 * restart does not open the door to replays. Read again for every message, so two guards on
 * the same file never work from an old copy. Epochs leave once their last message is outside
 * the window: anything they carried is refused by its time stamp anyway.
 */
export class ReplayGuard {
  constructor(private readonly file: string) {
    read(file);
  }

  /** Records `header`; throws if it is old, from the future or seen before. */
  accept(header: Header, now = Date.now()): void {
    // Both become object keys: nothing like `__proto__` may pass.
    if (
      !/^[0-9a-f]{64}$/.test(header.from) ||
      !/^[A-Za-z0-9_-]{16,64}$/.test(header.epoch) ||
      !Number.isSafeInteger(header.seq) ||
      !Number.isFinite(header.ts)
    ) {
      throw new Error('Invalid sequence');
    }
    if (Math.abs(now - header.ts) > REPLAY_WINDOW_MS) {
      throw new Error('Message outside the time window');
    }
    const state = read(this.file);
    const epochs = (state[header.from] ??= {});
    const last = epochs[header.epoch];
    if (last && header.seq <= last.seq) throw new Error('Replayed message');
    for (const [epoch, seen] of Object.entries(epochs)) {
      if (seen.ts < now - REPLAY_WINDOW_MS) delete epochs[epoch];
    }
    epochs[header.epoch] = { seq: header.seq, ts: Math.max(header.ts, last?.ts ?? 0) };
    writeDurable(this.file, JSON.stringify(state));
  }
}

/**
 * Atomic write that is on disk, not only in the cache, when it returns: flush, rename and the
 * folder's fsync. For state that must survive a crash before anything acts on it. Windows
 * refuses fsync on a folder (EPERM); there the renamed file is flushed instead
 * (FlushFileBuffers), the closest barrier Node offers for the rename.
 */
export function writeDurable(file: string, data: string, mode?: number): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${file}.tmp`, data, { flush: true, ...(mode && { mode }) });
  renameSync(`${file}.tmp`, file);
  const win = process.platform === 'win32';
  const fd = openSync(win ? file : dir, win ? 'r+' : 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
