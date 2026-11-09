import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextRun, parseCron } from './cron';

const at = (iso: string) => new Date(iso).getTime();
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

let tz: string | undefined;
beforeEach(() => {
  tz = process.env.TZ;
  process.env.TZ = 'UTC';
});
afterEach(() => {
  process.env.TZ = tz;
});

describe('parseCron', () => {
  it('accepts lists, ranges and steps', () => {
    const cron = parseCron('*/15 9-17 1,15 * 1-5');
    expect([...cron.minute]).toEqual([0, 15, 30, 45]);
    expect([...cron.hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...cron.day]).toEqual([1, 15]);
    expect(cron.month.size).toBe(12);
    expect([...cron.weekday]).toEqual([1, 2, 3, 4, 5]);
  });

  it('treats weekday 7 as Sunday and supports range steps', () => {
    expect([...parseCron('0 0 * * 7').weekday]).toEqual([0]);
    expect([...parseCron('10-30/10 0 * * *').minute]).toEqual([10, 20, 30]);
  });

  it.each([
    ['', 'expected 5 fields'],
    ['* * * *', 'expected 5 fields'],
    ['60 * * * *', 'minute: 60 is outside 0-59'],
    ['* 24 * * *', 'hour: 24 is outside 0-23'],
    ['* * 0 * *', 'day: 0 is outside 1-31'],
    ['* * * 13 *', 'month: 13 is outside 1-12'],
    ['* * * * 8', 'weekday: 8 is outside 0-7'],
    ['5-1 * * * *', 'minute: invalid range 5-1'],
    ['*/0 * * * *', 'minute: invalid step 0'],
    ['MON * * * *', 'minute: invalid value "MON"'],
    ['1,,2 * * * *', 'minute: invalid value ""'],
    ['1-2-3 * * * *', 'minute: invalid value "1-2-3"'],
    ['*/2/3 * * * *', 'minute: invalid value "*/2/3"'],
  ])('rejects %j', (expr, message) => {
    expect(() => parseCron(expr)).toThrow(`Invalid schedule "${expr}": ${message}`);
  });
});

describe('nextRun', () => {
  it('finds the next matching minute strictly after the given time', () => {
    expect(iso(nextRun(parseCron('* * * * *'), at('2026-10-29T10:00:30Z')))).toBe(
      '2026-10-29T10:01:00.000Z',
    );
    expect(iso(nextRun(parseCron('30 2 * * *'), at('2026-10-29T02:30:00Z')))).toBe(
      '2026-10-30T02:30:00.000Z',
    );
  });

  it('rolls over months and years', () => {
    expect(iso(nextRun(parseCron('0 0 1 1 *'), at('2026-10-29T10:00:00Z')))).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('matches day or weekday when both are restricted', () => {
    // 2026-10-30 is a Friday; the 15th is the next listed day
    expect(iso(nextRun(parseCron('0 8 15 * 5'), at('2026-10-29T10:00:00Z')))).toBe(
      '2026-10-30T08:00:00.000Z',
    );
    expect(iso(nextRun(parseCron('0 8 * * 5'), at('2026-10-29T10:00:00Z')))).toBe(
      '2026-10-30T08:00:00.000Z',
    );
    expect(iso(nextRun(parseCron('0 8 31 * *'), at('2026-11-01T00:00:00Z')))).toBe(
      '2026-12-31T08:00:00.000Z',
    );
  });

  it('returns undefined for a date that never exists', () => {
    expect(nextRun(parseCron('0 0 30 2 *'), at('2026-10-29T10:00:00Z'))).toBeUndefined();
  });

  it('follows the process time zone', () => {
    process.env.TZ = 'Europe/Berlin';
    expect(iso(nextRun(parseCron('0 9 * * *'), at('2026-10-29T00:00:00Z')))).toBe(
      '2026-10-29T08:00:00.000Z',
    );
    process.env.TZ = 'America/New_York';
    expect(iso(nextRun(parseCron('0 9 * * *'), at('2026-10-29T00:00:00Z')))).toBe(
      '2026-10-29T13:00:00.000Z',
    );
  });

  it('skips a local time that does not exist on the day clocks go forward', () => {
    process.env.TZ = 'Europe/Berlin';
    // 2026-03-29 02:00 → 03:00 in Berlin
    expect(iso(nextRun(parseCron('30 2 * * *'), at('2026-03-28T12:00:00Z')))).toBe(
      '2026-03-30T00:30:00.000Z',
    );
  });

  it('runs a repeated local time once on the day clocks go back', () => {
    process.env.TZ = 'Europe/Berlin';
    // 2026-10-25 03:00 → 02:00 in Berlin; 02:30 exists at 00:30Z and 01:30Z
    const first = nextRun(parseCron('30 2 * * *'), at('2026-10-24T12:00:00Z'));
    expect(iso(first)).toBe('2026-10-25T00:30:00.000Z');
    expect(iso(nextRun(parseCron('30 2 * * *'), first!))).toBe('2026-10-26T01:30:00.000Z');
  });

  it('never returns a past time from within the repeated hour', () => {
    process.env.TZ = 'Europe/Berlin';
    // 01:20Z is the second 02:20 local; the first 02:30 (00:30Z) is already past
    expect(iso(nextRun(parseCron('30 2 * * *'), at('2026-10-25T01:20:00Z')))).toBe(
      '2026-10-26T01:30:00.000Z',
    );
  });
});
