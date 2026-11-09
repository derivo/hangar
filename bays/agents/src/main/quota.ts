import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Quota, QuotaProvider, Quotas } from './types';

/** Codex logs a limit with every turn; the end of the newest log is enough. */
const TAIL_BYTES = 1024 * 1024;

/** Date folders only; Finder leaves `.DS_Store` beside them. */
const sorted = (dir: string) =>
  readdirSync(dir)
    .filter((name) => /^\d+$/.test(name))
    .sort();

function tail(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Last 5-hour limit in Codex's newest session log under `<codexHome>/sessions/Y/M/D/` that has
 * one: a newer log without it (`codex exec`, a sub-thread, a session that just started) is skipped.
 */
export function readCodexQuota(codexHome: string): Quota | undefined {
  const root = join(codexHome, 'sessions');
  try {
    // A log lies in the folder of the day its session started; one from yesterday may still run.
    const days = sorted(root)
      .flatMap((y) => sorted(join(root, y)).map((m) => join(root, y, m)))
      .flatMap((m) => sorted(m).map((d) => join(m, d)))
      .slice(-2);
    const files = days
      .flatMap((dir) =>
        readdirSync(dir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => join(dir, f)),
      )
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    // At most 5 logs (up to 5 MB) per minute; more only if exec logs pile up between turns.
    for (const file of files.slice(0, 5)) {
      const quota = lastFiveHourLimit(file);
      if (quota) return quota;
    }
  } catch {
    // No Codex, or no logs yet.
  }
  return undefined;
}

/** One limit of a Codex log line, if it covers `minutes`. */
function window(limit: Record<string, unknown> | undefined, minutes: number) {
  if (limit?.window_minutes !== minutes || typeof limit.used_percent !== 'number') return undefined;
  return {
    usedPercent: limit.used_percent,
    ...(typeof limit.resets_at === 'number' && { resetsAt: limit.resets_at }),
  };
}

function lastFiveHourLimit(file: string): Quota | undefined {
  for (const line of tail(file).split('\n').reverse()) {
    if (!line.includes('"rate_limits"')) continue;
    try {
      const limits = (
        JSON.parse(line) as {
          payload?: { rate_limits?: Record<string, Record<string, unknown> | undefined> };
        }
      ).payload?.rate_limits;
      const five = window(limits?.primary, 300);
      if (!five) continue;
      const week = window(limits?.secondary, 7 * 24 * 60);
      return { ...five, ...(week && { week }) };
    } catch {
      // The first line of the tail may be cut off.
    }
  }
  return undefined;
}

/** Latest limit per provider, in memory; tells the UI on every change. */
export class QuotaTracker {
  private quotas: Quotas = {};

  constructor(
    private readonly deps: {
      emit: (channel: 'quota', quotas: Quotas) => void;
      readCodex: () => Quota | undefined;
    },
  ) {}

  view(): Quotas {
    return this.quotas;
  }

  report(provider: QuotaProvider, quota: Quota | undefined): void {
    if (JSON.stringify(this.quotas[provider]) === JSON.stringify(quota)) return;
    this.quotas = { ...this.quotas, [provider]: quota };
    this.deps.emit('quota', this.quotas);
  }

  refreshCodex(): void {
    this.report('codex', this.deps.readCodex());
  }
}
