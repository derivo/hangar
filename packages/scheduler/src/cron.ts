/** A parsed five-field cron expression (ADR 0013). */
export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  /** 0 = Sunday. */
  weekday: Set<number>;
  /** Day field is `*`: only the weekday decides (and vice versa). */
  anyDay: boolean;
  anyWeekday: boolean;
}

const FIELDS = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['day', 1, 31],
  ['month', 1, 12],
  ['weekday', 0, 7],
] as const;

/** Parses `minute hour day month weekday`; throws with the offending field. */
export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  try {
    if (parts.length !== 5) throw new Error('expected 5 fields');
    const [minute, hour, day, month, weekday] = FIELDS.map(([name, min, max], i) =>
      field(name, min, max, parts[i]!),
    ) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
    return {
      minute,
      hour,
      day,
      month,
      weekday: new Set([...weekday].map((d) => d % 7)),
      anyDay: parts[2]!.startsWith('*'),
      anyWeekday: parts[4]!.startsWith('*'),
    };
  } catch (err) {
    throw new Error(`Invalid schedule "${expr}": ${(err as Error).message}`, { cause: err });
  }
}

function field(name: string, min: number, max: number, text: string): Set<number> {
  const num = (s: string | undefined) => {
    if (!s || !/^\d+$/.test(s)) throw new Error(`${name}: invalid value "${s ?? ''}"`);
    const n = Number(s);
    if (n < min || n > max) throw new Error(`${name}: ${n} is outside ${min}-${max}`);
    return n;
  };
  const values: number[] = [];
  for (const part of text.split(',')) {
    if (!/^(\*|\d+(-\d+)?)(\/\d+)?$/.test(part) && part !== '') {
      throw new Error(`${name}: invalid value "${part}"`);
    }
    const [range = '', stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`${name}: invalid step ${stepText}`);
    let lo = min;
    let hi = max;
    if (range !== '*') {
      const [a, b] = range.split('-');
      lo = num(a);
      hi = b !== undefined ? num(b) : stepText !== undefined ? max : lo;
      if (lo > hi) throw new Error(`${name}: invalid range ${range}`);
    }
    for (let v = lo; v <= hi; v += step) values.push(v);
  }
  return new Set(values.sort((a, b) => a - b));
}

/** Local wall-clock minute as one number, increasing with the calendar. */
const wallKey = (d: Date) =>
  (((d.getFullYear() * 12 + d.getMonth()) * 31 + d.getDate()) * 24 + d.getHours()) * 60 +
  d.getMinutes();

function dayMatches(cron: Cron, d: Date): boolean {
  const dom = cron.day.has(d.getDate());
  const dow = cron.weekday.has(d.getDay());
  if (cron.anyDay) return dow;
  if (cron.anyWeekday) return dom;
  return dom || dow;
}

/**
 * First matching minute after `after` (ms), in the process' local time zone.
 * Missing local times (clocks forward) are skipped; repeated ones (clocks back)
 * match once. `undefined` if nothing matches within eight years (e.g. 30 Feb).
 */
export function nextRun(cron: Cron, after: number): number | undefined {
  const since = wallKey(new Date(after));
  const d = new Date(after);
  d.setSeconds(60, 0);
  const lastYear = d.getFullYear() + 8;
  while (d.getFullYear() <= lastYear) {
    if (!cron.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
    } else if (!dayMatches(cron, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
    } else if (!cron.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
    } else if (
      !cron.minute.has(d.getMinutes()) ||
      wallKey(d) <= since ||
      // local setters fall back from a repeated hour into its first occurrence
      d.getTime() <= after
    ) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
    } else {
      return d.getTime();
    }
  }
  return undefined;
}
