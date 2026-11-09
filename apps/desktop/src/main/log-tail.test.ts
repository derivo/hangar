import { appendFileSync, mkdtempSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tailFile } from './log-tail';

// The real `readSync`, replaceable per test for a short read.
vi.mock('node:fs', async (actual) => {
  const fs = await actual<typeof import('node:fs')>();
  return { ...fs, readSync: vi.fn(fs.readSync) };
});

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function follow(path: string, max = 3) {
  const seen: string[][] = [];
  stops.push(tailFile(path, max, (lines) => seen.push(lines), 20));
  return { seen, last: () => seen.at(-1) };
}

const file = (content?: string) => {
  const path = join(mkdtempSync(join(tmpdir(), 'hangar-tail-')), 'server.log');
  if (content !== undefined) writeFileSync(path, content);
  return path;
};

describe('tailFile', () => {
  it('starts with the last lines and appends complete lines as they are written', async () => {
    const path = file('eins\nzwei\ndrei\nvier\n');
    const { last } = follow(path);
    expect(last()).toEqual(['zwei', 'drei', 'vier']);
    // A line without its end waits for it.
    appendFileSync(path, 'fün');
    await new Promise((r) => setTimeout(r, 100));
    expect(last()).toEqual(['zwei', 'drei', 'vier']);
    appendFileSync(path, 'f\nsechs\n');
    await vi.waitFor(() => expect(last()).toEqual(['vier', 'fünf', 'sechs']));
  });

  it('waits for a missing file and reads a truncated one from its start', async () => {
    const path = file();
    const { seen, last } = follow(path);
    expect(seen).toEqual([]);
    writeFileSync(path, 'da\n');
    await vi.waitFor(() => expect(last()).toEqual(['da']));
    // Shorter than before: cut, read from its start (a rewrite just as long looks appended).
    writeFileSync(path, 'n\n');
    await vi.waitFor(() => expect(last()).toEqual(['da', 'n']));
    rmSync(path);
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(path, 'wieder\n');
    await vi.waitFor(() => expect(last()).toEqual(['da', 'n', 'wieder']));
  });

  it('reads only the end of a large file, without a cut first line', () => {
    const path = file(`${'x'.repeat(100_000)}\nvorletzte\nletzte\n`);
    const { last } = follow(path, 5);
    expect(last()).toEqual(['vorletzte', 'letzte']);
  });

  it('takes only the bytes read when the file shrinks between stat and read (Codex review)', async () => {
    const path = file('eins\nzwei\n');
    type Read = (fd: number, b: Buffer, at: number, length: number, position: number) => number;
    const real = vi.mocked(readSync).getMockImplementation() as Read;
    // Five of ten bytes: the rest of the buffer stays unread.
    vi.mocked(readSync as Read).mockImplementationOnce((fd, b, at, _length, position) =>
      real(fd, b, at, 5, position),
    );
    const { last } = follow(path);
    expect(last()).toEqual(['eins']);
    appendFileSync(path, 'drei\n');
    await vi.waitFor(() => expect(last()).toEqual(['eins', 'zwei', 'drei']));
  });

  it('never shows the cut start of a line longer than what it reads (Codex review)', async () => {
    const path = file(`a\n${'x'.repeat(100_000)}`);
    const { seen, last } = follow(path);
    expect(seen).toEqual([]);
    appendFileSync(path, 'y\nnext\n');
    await vi.waitFor(() => expect(last()).toEqual(['next']));
  });

  it('keeps at most the end of a line without an end, marked as cut (Codex review)', async () => {
    const path = file('');
    const { last } = follow(path);
    for (let i = 0; i < 4; i++) {
      appendFileSync(path, String(i).repeat(50_000));
      await new Promise((r) => setTimeout(r, 60));
    }
    appendFileSync(path, '\nok\n');
    await vi.waitFor(() => expect(last()?.at(-1)).toBe('ok'));
    const long = last()!.at(-2)!;
    expect(long.length).toBeLessThanOrEqual(64 * 1024 + 1);
    expect(long.startsWith('…')).toBe(true);
    expect(long.endsWith('3')).toBe(true);
  });

  it('stops following when stopped', async () => {
    const path = file('a\n');
    const seen: string[][] = [];
    const stop = tailFile(path, 3, (lines) => seen.push(lines), 20);
    stop();
    appendFileSync(path, 'b\n');
    await new Promise((r) => setTimeout(r, 150));
    expect(seen).toEqual([['a']]);
  });
});
