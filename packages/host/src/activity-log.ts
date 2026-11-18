import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ActivityEvent } from '@hangar/bus';
import { writeDurable } from '@hangar/relay';

const MAX_ENTRIES = 2000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The activity log of workspace calls (ADR 0046): JSON lines, mode 600, at most 2,000 entries
 * and 30 days. It stays on this instance.
 */
export class ActivityLog {
  private entries: ActivityEvent[] = [];

  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    let broken = false;
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        try {
          if (line) this.entries.push(JSON.parse(line) as ActivityEvent);
        } catch {
          broken = true; // a line cut off by a crash
        }
      }
    }
    // Rewritten without the broken line, so the next append does not join it (Codex).
    this.prune(broken);
  }

  add(event: ActivityEvent): void {
    this.entries.push(event);
    if (this.prune()) return;
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }

  /** Newest first. */
  list(): ActivityEvent[] {
    return [...this.entries].reverse();
  }

  /** Drops old and surplus entries; rewrites the file (atomically) if any went, or `force`. */
  private prune(force = false): boolean {
    const since = this.now().getTime() - MAX_AGE_MS;
    const kept = this.entries.filter((e) => Date.parse(e.at) >= since).slice(-MAX_ENTRIES);
    if (!force && kept.length === this.entries.length) return false;
    this.entries = kept;
    writeDurable(this.file, kept.map((e) => `${JSON.stringify(e)}\n`).join(''), 0o600);
    return true;
  }
}
