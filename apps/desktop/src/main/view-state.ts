import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Selection } from '../shared';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A bay window opened with `window.hangar.windows.open` (ADR 0010). */
export interface BayWindowState {
  bay: string;
  key: string;
  title: string;
  bounds?: Bounds;
}

/** What Hangar shows, saved on quit (`<userData>/view.json`) and restored on start. */
export interface ViewState {
  /** Window position and size when not maximized. */
  bounds?: Bounds;
  maximized: boolean;
  selected: Selection;
  /** Bay windows open when Hangar quit; reopened on start. */
  windows: BayWindowState[];
}

const isBounds = (b: unknown): b is Bounds =>
  typeof b === 'object' &&
  b !== null &&
  ['x', 'y', 'width', 'height'].every((k) => Number.isFinite((b as Record<string, unknown>)[k]));

function bayWindow(raw: unknown): BayWindowState | undefined {
  const w = raw as Partial<BayWindowState> | null;
  if (typeof w?.bay !== 'string' || typeof w.key !== 'string' || typeof w.title !== 'string') {
    return undefined;
  }
  return {
    bay: w.bay,
    key: w.key,
    title: w.title,
    ...(isBounds(w.bounds) && { bounds: w.bounds }),
  };
}

/** Reads `view.json`; missing, broken or malformed values are left out. */
export function readViewState(file: string): ViewState {
  let raw: Partial<ViewState> = {};
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ViewState>;
  } catch {
    // First start or broken file: default view.
  }
  return {
    ...(isBounds(raw.bounds) && { bounds: raw.bounds }),
    maximized: raw.maximized === true,
    selected: typeof raw.selected === 'string' ? raw.selected : null,
    windows: Array.isArray(raw.windows)
      ? raw.windows.map(bayWindow).filter((w) => w !== undefined)
      : [],
  };
}

export function writeViewState(file: string, state: ViewState): void {
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${file}.tmp`, file);
}

/** The saved bounds if their centre lies on a current display (`workArea`s), else `undefined`. */
export function restorableBounds(
  bounds: Bounds | undefined,
  displays: readonly Bounds[],
): Bounds | undefined {
  if (!bounds) return undefined;
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const visible = displays.some(
    (d) => cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height,
  );
  return visible ? bounds : undefined;
}
