import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActivityEvent } from '@hangar/bus';
import { afterEach, describe, expect, it } from 'vitest';
import { ActivityLog } from './activity-log';

const DAY = 24 * 60 * 60 * 1000;
const event = (at: string, outcome: ActivityEvent['outcome'] = 'ran'): ActivityEvent => ({
  at,
  direction: 'in',
  workspace: 'team',
  instance: 'SHA256:ben',
  target: 'dev.hangar.board/task.add',
  outcome,
});

describe('ActivityLog (ADR 0046)', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('appends JSON lines with mode 600 and lists newest first, also after a restart', () => {
    dir = mkdtempSync(join(tmpdir(), 'hangar-log-'));
    const file = join(dir, 'workspace-log.jsonl');
    const now = () => new Date('2026-11-16T12:00:00Z');
    const log = new ActivityLog(file, now);
    log.add(event('2026-11-16T10:00:00.000Z'));
    log.add(event('2026-11-16T11:00:00.000Z', 'queued'));
    expect(log.list().map((e) => e.outcome)).toEqual(['queued', 'ran']);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    // A line cut off by a crash (no newline) is skipped and does not swallow the next one.
    appendFileSync(file, '{"at":');
    const again = new ActivityLog(file, now);
    expect(again.list()).toHaveLength(2);
    again.add(event('2026-11-16T11:30:00.000Z', 'denied'));
    expect(new ActivityLog(file, now).list().map((e) => e.outcome)).toEqual([
      'denied',
      'queued',
      'ran',
    ]);
  });

  it('keeps at most 2,000 entries and none older than 30 days', () => {
    dir = mkdtempSync(join(tmpdir(), 'hangar-log-'));
    const file = join(dir, 'workspace-log.jsonl');
    let clock = new Date('2026-11-16T12:00:00Z').getTime();
    const log = new ActivityLog(file, () => new Date(clock));
    log.add(event(new Date(clock - 31 * DAY).toISOString(), 'failed'));
    for (let i = 0; i < 2000; i++) log.add(event(new Date(clock + i).toISOString()));
    expect(log.list()).toHaveLength(2000);
    expect(log.list().some((e) => e.outcome === 'failed')).toBe(false);
    log.add(event(new Date(clock + 5000).toISOString(), 'denied'));
    expect(log.list()).toHaveLength(2000);
    expect(log.list()[0]!.outcome).toBe('denied');
    expect(new ActivityLog(file, () => new Date(clock)).list()).toHaveLength(2000);
    clock += 31 * DAY;
    expect(new ActivityLog(file, () => new Date(clock)).list()).toEqual([]);
  });
});
