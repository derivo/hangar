import { existsSync, readFileSync } from 'node:fs';
import type { InboxEntry, InboxStore } from '@hangar/bus';
import { writeDurable } from '@hangar/relay';

/**
 * The inbox as JSON, mode 600 (ADR 0046). Written durably: a caller told `{ queued }` must
 * find its entry after a power loss, since the relay will not deliver the call again.
 * A missing or broken file means "empty".
 */
export class FileInboxStore implements InboxStore {
  constructor(private readonly file: string) {}

  load(): InboxEntry[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      return Array.isArray(parsed) ? (parsed as InboxEntry[]) : [];
    } catch {
      return [];
    }
  }

  save(entries: InboxEntry[]): void {
    writeDurable(this.file, JSON.stringify(entries), 0o600);
  }
}
