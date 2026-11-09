import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scheduler, type JobHandler } from './scheduler';

const at = (iso: string) => new Date(iso).getTime();

let tz: string | undefined;
let file: string;
let clock: number;
let changes: number;

function create(): Scheduler {
  return new Scheduler({ file, now: () => clock, onChange: () => changes++ });
}

beforeEach(() => {
  tz = process.env.TZ;
  process.env.TZ = 'UTC';
  file = join(mkdtempSync(join(tmpdir(), 'hangar-jobs-')), 'jobs.json');
  clock = at('2026-10-29T10:00:30Z');
  changes = 0;
});
afterEach(() => {
  process.env.TZ = tz;
  vi.useRealTimers();
});

describe('Scheduler', () => {
  it('stores jobs and lists them with their next run', () => {
    const s = create();
    const job = s.add('bay.a', { label: 'Tests', schedule: '0 2 * * *', payload: { x: 1 } });
    expect(changes).toBe(1);
    expect(s.list()).toEqual([
      {
        ...job,
        nextRun: at('2026-10-30T02:00:00Z'),
        running: false,
        available: false,
      },
    ]);
    expect(create().list()[0]).toMatchObject({ id: job.id, label: 'Tests', payload: { x: 1 } });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1);
  });

  it('rejects an invalid schedule', () => {
    expect(() => create().add('bay.a', { label: 'x', schedule: '61 * * * *' })).toThrow(
      'Invalid schedule "61 * * * *": minute: 61 is outside 0-59',
    );
  });

  it('starts empty from a broken file', () => {
    writeFileSync(file, '{');
    expect(create().list()).toEqual([]);
  });

  it('filters by bay', () => {
    const s = create();
    s.add('bay.a', { label: 'a', schedule: '* * * * *' });
    s.add('bay.b', { label: 'b', schedule: '* * * * *' });
    expect(s.list('bay.b').map((j) => j.label)).toEqual(['b']);
  });

  it('runs a due job once and records the result', async () => {
    const s = create();
    const handler = vi.fn<JobHandler>(() => 'fine');
    s.handle('bay.a', handler);
    const job = s.add('bay.a', { label: 'x', schedule: '* * * * *' });

    await s.tick();
    expect(handler).not.toHaveBeenCalled();

    clock = at('2026-10-29T10:01:05Z');
    await s.tick();
    await s.tick();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0]).toMatchObject({ id: job.id });
    expect(s.list()[0]).toMatchObject({
      lastRun: { at: clock, durationMs: 0, ok: true, output: 'fine' },
      nextRun: at('2026-10-29T10:02:00Z'),
      available: true,
    });
  });

  it('catches up a missed run once after sleep', async () => {
    const s = create();
    const handler = vi.fn<JobHandler>();
    s.handle('bay.a', handler);
    s.add('bay.a', { label: 'x', schedule: '0 * * * *' });

    clock = at('2026-10-30T13:20:00Z'); // 27 hourly runs missed
    await s.tick();
    await s.tick();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(s.list()[0]!.lastRun).toMatchObject({ ok: true, output: '' });
  });

  it('follows a change of time zone', async () => {
    process.env.TZ = 'Europe/Berlin';
    clock = at('2026-10-29T00:00:00Z');
    const s = create();
    const handler = vi.fn<JobHandler>();
    s.handle('bay.a', handler);
    s.add('bay.a', { label: 'x', schedule: '0 9 * * *' });
    expect(s.list()[0]!.nextRun).toBe(at('2026-10-29T08:00:00Z'));

    process.env.TZ = 'America/New_York';
    clock = at('2026-10-29T08:00:00Z');
    await s.tick();
    expect(handler).not.toHaveBeenCalled();
    clock = at('2026-10-29T13:00:00Z');
    await s.tick();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('skips paused jobs and does not catch up after resuming', async () => {
    const s = create();
    const handler = vi.fn<JobHandler>();
    s.handle('bay.a', handler);
    const job = s.add('bay.a', { label: 'x', schedule: '* * * * *' });
    s.setPaused(job.id, true);
    expect(s.list()[0]).toMatchObject({ paused: true, nextRun: undefined });

    clock = at('2026-10-29T12:00:00Z');
    await s.tick();
    expect(handler).not.toHaveBeenCalled();

    s.setPaused(job.id, false);
    await s.tick();
    expect(handler).not.toHaveBeenCalled();
    expect(s.list()[0]!.nextRun).toBe(at('2026-10-29T12:01:00Z'));
  });

  it('does not run jobs of a bay without handler', async () => {
    const s = create();
    s.handle('bay.a', () => undefined);
    s.unhandle('bay.a');
    s.add('bay.a', { label: 'x', schedule: '* * * * *' });
    clock = at('2026-10-29T11:00:00Z');
    await s.tick();
    expect(s.list()[0]!.available).toBe(false);
    expect(s.list()[0]!.lastRun).toBeUndefined();
    await expect(s.runNow(s.list()[0]!.id)).rejects.toThrow('Bay "bay.a" is not loaded');
  });

  it('records failures with a truncated message', async () => {
    const s = create();
    s.handle('bay.a', () => {
      throw new Error('x'.repeat(600));
    });
    const job = s.add('bay.a', { label: 'x', schedule: '* * * * *' });
    const run = await s.runNow(job.id);
    expect(run.ok).toBe(false);
    expect(run.output).toHaveLength(500);
    expect(run.output.endsWith('…')).toBe(true);
  });

  it('never runs a job twice at the same time', async () => {
    const s = create();
    let finish!: (v: string) => void;
    const handler = vi.fn<JobHandler>(() => new Promise<string>((r) => (finish = r)));
    s.handle('bay.a', handler);
    const job = s.add('bay.a', { label: 'x', schedule: '* * * * *' });

    const run = s.runNow(job.id);
    expect(s.list()[0]!.running).toBe(true);
    clock = at('2026-10-29T11:00:00Z');
    await s.tick();
    await expect(s.runNow(job.id)).rejects.toThrow('Job is already running');
    expect(handler).toHaveBeenCalledTimes(1);

    clock += 2500;
    finish('done');
    expect(await run).toEqual({
      at: at('2026-10-29T10:00:30Z'),
      durationMs: 2500 + at('2026-10-29T11:00:00Z') - at('2026-10-29T10:00:30Z'),
      ok: true,
      output: 'done',
    });
    expect(s.list()[0]!.running).toBe(false);
  });

  it('removes jobs and rejects unknown ids', () => {
    const s = create();
    const job = s.add('bay.a', { label: 'x', schedule: '* * * * *' });
    s.remove(job.id);
    expect(s.list()).toEqual([]);
    expect(() => s.remove(job.id)).toThrow(`Unknown job "${job.id}"`);
    expect(() => s.setPaused(job.id, true)).toThrow(`Unknown job "${job.id}"`);
  });

  it('checks periodically between start and stop', async () => {
    vi.useFakeTimers();
    const s = create();
    const tick = vi.spyOn(s, 'tick');
    s.start(1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(tick).toHaveBeenCalledTimes(3);
    s.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('stays runnable when storing a run fails', async () => {
    let broken = false;
    const s = new Scheduler({
      file,
      now: () => clock,
      onChange: () => {
        if (broken) throw new Error('ENOSPC');
      },
    });
    s.handle('bay.a', () => 'ok');
    const job = s.add('bay.a', { label: 'x', schedule: '* * * * *' });
    broken = true;
    await expect(s.runNow(job.id)).rejects.toThrow('ENOSPC');
    broken = false;
    expect(s.list()[0]!.running).toBe(false);
    expect(await s.runNow(job.id)).toMatchObject({ ok: true, output: 'ok' });
  });

  it('keeps checking when a periodic check fails', async () => {
    vi.useFakeTimers();
    const s = create();
    const tick = vi.spyOn(s, 'tick').mockRejectedValue(new Error('ENOSPC'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    s.start(1000);
    await vi.advanceTimersByTimeAsync(2000);
    s.stop();
    expect(tick).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(new Error('ENOSPC'));
    error.mockRestore();
  });
});
