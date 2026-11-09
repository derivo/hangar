import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readViewState, restorableBounds, writeViewState } from './view-state';

const file = () => join(mkdtempSync(join(tmpdir(), 'hangar-view-')), 'view.json');
const EMPTY = { maximized: false, selected: null, windows: [] };

describe('view state', () => {
  it('starts empty when the file is missing, broken or malformed', () => {
    const f = file();
    expect(readViewState(f)).toEqual(EMPTY);
    writeFileSync(f, '{kaputt');
    expect(readViewState(f)).toEqual(EMPTY);
    writeFileSync(f, JSON.stringify({ bounds: { x: 'a' }, maximized: 'yes', selected: 3 }));
    expect(readViewState(f)).toEqual(EMPTY);
  });

  it('keeps only well-formed bay windows', () => {
    const f = file();
    const window = { bay: 'dev.hangar.agents', key: 's1', title: 'Login' };
    const placed = { ...window, key: 's2', bounds: { x: 1, y: 2, width: 300, height: 200 } };
    writeFileSync(
      f,
      JSON.stringify({
        windows: [
          window,
          placed,
          { bay: 3, key: 's3', title: '' },
          { ...window, bounds: 'x' },
          null,
        ],
      }),
    );
    expect(readViewState(f).windows).toEqual([window, placed, { ...window }]);
    writeFileSync(f, JSON.stringify({ windows: 'none' }));
    expect(readViewState(f).windows).toEqual([]);
  });

  it('persists bounds, maximized and the selection', () => {
    const f = file();
    const state = {
      bounds: { x: 10, y: 20, width: 900, height: 600 },
      maximized: true,
      selected: 'dev.hangar.agents',
      windows: [{ bay: 'dev.hangar.agents', key: 's1', title: 'Login' }],
    };
    writeViewState(f, state);
    expect(readViewState(f)).toEqual(state);
  });
});

describe('restorableBounds', () => {
  const screens = [
    { x: 0, y: 25, width: 1440, height: 875 },
    { x: 1440, y: 0, width: 1920, height: 1080 },
  ];

  it('keeps bounds whose centre lies on a display', () => {
    const second = { x: 1500, y: 100, width: 800, height: 600 };
    expect(restorableBounds(second, screens)).toEqual(second);
  });

  it('drops bounds on a display that is gone, and missing bounds', () => {
    expect(restorableBounds({ x: 4000, y: 100, width: 800, height: 600 }, screens)).toBeUndefined();
    expect(restorableBounds(undefined, screens)).toBeUndefined();
  });
});
