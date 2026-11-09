import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { BayState } from './types';

const empty = (): BayState => ({ projects: [], sessions: [] });

/**
 * Reads `state.json`; a missing file yields an empty state. A corrupt file is copied to
 * `state.json.corrupt-<time>` first (reported through `onCorrupt`), since the next save
 * overwrites it.
 */
export function loadState(file: string, onCorrupt?: (backup: string) => void): BayState {
  if (!existsSync(file)) return empty();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<BayState>;
    return { projects: parsed.projects ?? [], sessions: parsed.sessions ?? [] };
  } catch {
    const backup = `${file}.corrupt-${Date.now()}`;
    copyFileSync(file, backup);
    onCorrupt?.(backup);
    return empty();
  }
}

/** Writes atomically (temp file + rename) so a crash never leaves half a file. */
export function writeFileAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

export function saveState(file: string, state: BayState): void {
  writeFileAtomic(file, JSON.stringify(state, null, 2));
}
