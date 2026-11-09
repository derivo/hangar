import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

/** How far back from the end the first read starts: enough for the last lines of a log. */
const TAIL_BYTES = 64 * 1024;

/**
 * Follows a text file like `tail -f`: `onLines` gets the last `max` complete lines, first
 * those already there, then again after every poll that added lines. A missing file is
 * waited for, a truncated one read again from its start. Returns the function that stops.
 */
export function tailFile(
  path: string,
  max: number,
  onLines: (lines: string[]) => void,
  intervalMs = 250,
): () => void {
  let lines: string[] = [];
  let offset = 0;
  let partial = '';
  /** The start of the line being read was skipped: drop it up to its end. */
  let cut = false;
  let decoder = new StringDecoder('utf8');
  const read = (size: number) => {
    if (size < offset) {
      offset = 0;
      partial = '';
      cut = false;
      decoder = new StringDecoder('utf8');
    }
    if (size === offset) return;
    // Far behind (first read, or a flood): only the end, without the line cut in two there.
    const start = Math.max(offset, size - TAIL_BYTES);
    if (start > offset) {
      partial = '';
      cut = true;
      decoder = new StringDecoder('utf8');
    }
    const buffer = Buffer.alloc(size - start);
    const fd = openSync(path, 'r');
    let bytes: number;
    try {
      bytes = readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      closeSync(fd);
    }
    // Shrunk since the stat: only what was there; the next poll sees the new size.
    offset = start + bytes;
    let text = partial + decoder.write(buffer.subarray(0, bytes));
    if (cut) {
      const end = text.indexOf('\n');
      partial = '';
      if (end < 0) return;
      text = text.slice(end + 1);
      cut = false;
    }
    const parts = text.split('\n');
    partial = parts.pop()!;
    // A line without an end keeps only its end, marked as cut.
    if (partial.length > TAIL_BYTES) partial = `…${partial.slice(-TAIL_BYTES)}`;
    if (parts.length === 0) return;
    lines = [...lines, ...parts].slice(-max);
    onLines(lines);
  };
  // Own polling, not `fs.watchFile`: its first stat comes later and would miss what is
  // written between the first read and it.
  const poll = () => {
    try {
      read(statSync(path).size);
    } catch {
      // Missing (not written yet, or gone between stat and read): like an empty file, which
      // only resets and never opens it.
      read(0);
    }
  };
  poll();
  const timer = setInterval(poll, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
