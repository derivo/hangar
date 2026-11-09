import { posix, win32 } from 'node:path';

/** A program, folder, file or website in the sidebar (ADR 0027). */
export interface Shortcut {
  id: string;
  /** Absolute path, or an http/https address. */
  target: string;
}

export const isUrl = (target: string) => /^https?:\/\//i.test(target);

/** The normalized address if it is http or https with a host; else throws `Invalid URL`. */
export function shortcutUrl(text: string): string {
  const trimmed = text.trim();
  let url: URL | undefined;
  try {
    url = isUrl(trimmed) ? new URL(trimmed) : undefined;
  } catch {
    // Falls through to the error below.
  }
  if (!url?.hostname) throw new Error('Invalid URL');
  return url.href;
}

/** A website by its host, a path by its last part without `.app`. */
export function shortcutName(target: string): string {
  if (isUrl(target)) return new URL(target).hostname;
  const last = target.split(/[\\/]/).filter(Boolean).pop() ?? target;
  return last.replace(/\.app$/, '');
}

/** The list with `target` at the end, unchanged if it is already there. */
export function addShortcut(list: Shortcut[], target: string, id: string): Shortcut[] {
  return list.some((s) => s.target === target) ? list : [...list, { id, target }];
}

// Both styles: settings.json may come from another system; win32 covers UNC paths too.
const isAbsolute = (path: string) => posix.isAbsolute(path) || win32.isAbsolute(path);

const validTarget = (target: string) => {
  if (!isUrl(target)) return isAbsolute(target);
  try {
    return shortcutUrl(target) !== undefined;
  } catch {
    return false;
  }
};

/** Stored shortcuts with an id and a valid target; a repeated id is kept once. */
export function validShortcuts(raw: unknown): Shortcut[] {
  if (!Array.isArray(raw)) return [];
  const result: Shortcut[] = [];
  for (const s of raw as Partial<Shortcut>[]) {
    if (typeof s?.id !== 'string' || typeof s.target !== 'string') continue;
    if (!validTarget(s.target) || result.some((r) => r.id === s.id)) continue;
    result.push({ id: s.id, target: s.target });
  }
  return result;
}
