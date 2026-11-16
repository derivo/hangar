import type { InboxEntry, InboxStore } from './types';

/** Keeps the inbox in memory (tests, instances without a data folder). */
export class MemoryInboxStore implements InboxStore {
  private entries: InboxEntry[] = [];

  load(): InboxEntry[] {
    return [...this.entries];
  }

  save(entries: InboxEntry[]): void {
    this.entries = [...entries];
  }
}

// Control and bidi characters: a preview must not move the cursor or reorder text.
// eslint-disable-next-line no-control-regex -- finds control characters on purpose
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]+/g;

// Text fields of the inbox functions; never a Git remote, a token or other arguments (Codex).
const TEXT_KEYS = ['title', 'description', 'task', 'context', 'text', 'note'];

/** The text of a call for the person: its text fields, cleaned, at most 200 characters. */
export const previewOf = (args: unknown): string => {
  const record = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
  const texts =
    typeof args === 'string'
      ? [args]
      : TEXT_KEYS.map((k) => record[k]).filter((v): v is string => typeof v === 'string');
  return texts
    .map((t) => t.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim())
    .join(' · ')
    .slice(0, 200);
};
