import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { QuotaTracker, readCodexQuota } from './quota';

const tokenCount = (primary: unknown) =>
  JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: { primary, secondary: { used_percent: 15, window_minutes: 10080 } },
    },
  });

/** Writes a Codex session log under `<home>/sessions/<day>/<name>`. */
function log(home: string, day: string, name: string, lines: string[], mtime: number) {
  const dir = join(home, 'sessions', ...day.split('/'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, lines.join('\n') + '\n');
  utimesSync(file, mtime, mtime);
}

describe('readCodexQuota (ADR 0024)', () => {
  it('takes the last 5-hour limit from the newest log of the two newest days', () => {
    const home = mkdtempSync(join(tmpdir(), 'hangar-codex-'));
    const five = (used: number) => ({ used_percent: used, window_minutes: 300, resets_at: 1000 });
    // Older than the two newest days: ignored, however recently written.
    log(home, '2026/10/28', 'a.jsonl', [tokenCount(five(80))], 3000);
    log(home, '2026/10/29', 'b.jsonl', [tokenCount(five(70))], 500);
    log(home, '2026/10/30', 'old.jsonl', [tokenCount(five(50))], 1000);
    log(
      home,
      '2026/10/30',
      'new.jsonl',
      [
        tokenCount(five(7)),
        tokenCount(five(9)),
        tokenCount({ used_percent: 99, window_minutes: 60 }),
        '{"type":"response_item"}',
        'kaputt',
      ],
      2000,
    );
    expect(readCodexQuota(home)).toEqual({
      usedPercent: 9,
      resetsAt: 1000,
      week: { usedPercent: 15 },
    });
  });

  it('also finds a session that started yesterday and is still logging', () => {
    const home = mkdtempSync(join(tmpdir(), 'hangar-codex-'));
    const five = (used: number) => ({ used_percent: used, window_minutes: 300, resets_at: 1000 });
    log(home, '2026/09/30', 'night.jsonl', [tokenCount(five(80))], 3000);
    log(home, '2026/10/01', 'morning.jsonl', [tokenCount(five(10))], 2000);
    // Finder leaves files next to the date folders.
    writeFileSync(join(home, 'sessions', '.DS_Store'), '');
    writeFileSync(join(home, 'sessions', '2026', '.DS_Store'), '');
    expect(readCodexQuota(home)).toEqual({
      usedPercent: 80,
      resetsAt: 1000,
      week: { usedPercent: 15 },
    });
  });

  it('skips newer logs without a limit, e.g. of `codex exec`', () => {
    const home = mkdtempSync(join(tmpdir(), 'hangar-codex-'));
    const five = (used: number) => ({ used_percent: used, window_minutes: 300, resets_at: 1000 });
    log(home, '2026/11/04', 'yesterday.jsonl', [tokenCount(five(21))], 1000);
    log(home, '2026/11/05', 'session.jsonl', [tokenCount(five(23))], 2000);
    log(home, '2026/11/05', 'exec.jsonl', ['{"type":"session_meta"}'], 3000);
    expect(readCodexQuota(home)).toEqual({
      usedPercent: 23,
      resetsAt: 1000,
      week: { usedPercent: 15 },
    });
  });

  it('takes the weekly limit from the same line, if Codex logs one', () => {
    const home = mkdtempSync(join(tmpdir(), 'hangar-codex-'));
    const line = (secondary: unknown) =>
      JSON.stringify({
        payload: {
          rate_limits: {
            primary: { used_percent: 5, window_minutes: 300, resets_at: 1000 },
            secondary,
          },
        },
      });
    log(
      home,
      '2026/11/09',
      'a.jsonl',
      [line({ used_percent: 40, window_minutes: 10080, resets_at: 9000 })],
      1000,
    );
    expect(readCodexQuota(home)).toEqual({
      usedPercent: 5,
      resetsAt: 1000,
      week: { usedPercent: 40, resetsAt: 9000 },
    });
    log(home, '2026/11/09', 'b.jsonl', [line({ used_percent: 40, window_minutes: 60 })], 2000);
    expect(readCodexQuota(home)).toEqual({ usedPercent: 5, resetsAt: 1000 });
  });

  it('has nothing without logs or without a 5-hour limit', () => {
    const home = mkdtempSync(join(tmpdir(), 'hangar-codex-'));
    expect(readCodexQuota(home)).toBeUndefined();
    log(home, '2026/10/30', 'a.jsonl', ['{"type":"response_item"}'], 1000);
    expect(readCodexQuota(home)).toBeUndefined();
  });
});

describe('QuotaTracker', () => {
  it('keeps the last value per provider and tells the UI about changes', () => {
    const emit = vi.fn();
    const codex = vi.fn(() => ({ usedPercent: 9, resetsAt: 1000 }));
    const quotas = new QuotaTracker({ emit, readCodex: codex });
    expect(quotas.view()).toEqual({});

    quotas.report('claude', { usedPercent: 6, resetsAt: 2000 });
    expect(emit).toHaveBeenLastCalledWith('quota', { claude: { usedPercent: 6, resetsAt: 2000 } });
    quotas.report('claude', { usedPercent: 6, resetsAt: 2000 });
    expect(emit).toHaveBeenCalledTimes(1);

    quotas.refreshCodex();
    quotas.refreshCodex();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(quotas.view()).toEqual({
      claude: { usedPercent: 6, resetsAt: 2000 },
      codex: { usedPercent: 9, resetsAt: 1000 },
    });
  });
});
