import { describe, expect, it } from 'vitest';
import { addField, capacity, closeField, layout, place, prune, type Grid } from './grid';

// A minimum field in pixels (terminal characters plus session header and statusbar).
const MIN = { width: 660, height: 520 };
// Space for the grid inside the bay: window minus dock (64) and project tree (288 + gaps).
const LAPTOP = { width: 1100, height: 820 };
const DESKTOP_27 = { width: 2200, height: 1350 };
const WIDE_49 = { width: 4760, height: 1350 };

const fits = (area: typeof MIN, count: number) => {
  const { columns, rows } = layout(count, area, MIN);
  return area.width / columns >= MIN.width && area.height / rows >= MIN.height;
};

describe('grid layout', () => {
  it('never shrinks a field below the minimum size while it fits', () => {
    for (const area of [LAPTOP, DESKTOP_27, WIDE_49]) {
      for (let n = 1; n <= capacity(area, MIN); n++) expect(fits(area, n)).toBe(true);
    }
  });

  it('puts four and more terminals side by side on a 49-inch widescreen', () => {
    expect(layout(4, WIDE_49, MIN)).toEqual({ columns: 4, rows: 1 });
    expect(layout(5, WIDE_49, MIN)).toEqual({ columns: 5, rows: 1 });
    expect(capacity(WIDE_49, MIN)).toBe(14);
  });

  it('splits side by side first on a 27-inch screen and stacks once the width is used up', () => {
    expect(layout(2, DESKTOP_27, MIN)).toEqual({ columns: 2, rows: 1 });
    expect(layout(4, DESKTOP_27, MIN)).toEqual({ columns: 2, rows: 2 });
    expect(capacity(DESKTOP_27, MIN)).toBe(6);
  });

  it('keeps one field on a laptop and always allows one', () => {
    expect(capacity(LAPTOP, MIN)).toBe(1);
    expect(capacity({ width: 300, height: 200 }, MIN)).toBe(1);
  });

  it('keeps the minimum and scrolls when fields no longer fit', () => {
    // Window made smaller after adding fields: as many columns as fit, rows overflow.
    expect(layout(4, LAPTOP, MIN)).toEqual({ columns: 1, rows: 4 });
    expect(layout(3, { width: 100, height: 100 }, MIN)).toEqual({ columns: 1, rows: 3 });
  });
});

describe('grid fields', () => {
  const grid: Grid = { fields: ['a', null, 'c'], focus: 1 };

  it('puts a session into the focused field, or focuses the field already showing it', () => {
    expect(place(grid, 'b')).toEqual({ fields: ['a', 'b', 'c'], focus: 1 });
    expect(place(grid, 'c')).toEqual({ fields: ['a', null, 'c'], focus: 2 });
    expect(place({ fields: ['a'], focus: 0 }, 'b')).toEqual({ fields: ['b'], focus: 0 });
  });

  it('adds an empty field and focuses it', () => {
    expect(addField(grid)).toEqual({ fields: ['a', null, 'c', null], focus: 3 });
  });

  it('closes a field and keeps at least one', () => {
    expect(closeField(grid, 0)).toEqual({ fields: [null, 'c'], focus: 0 });
    expect(closeField(grid, 2)).toEqual({ fields: ['a', null], focus: 1 });
    expect(closeField({ fields: ['a', 'b'], focus: 1 }, 1)).toEqual({ fields: ['a'], focus: 0 });
    expect(closeField({ fields: ['a'], focus: 0 }, 0)).toEqual({ fields: [null], focus: 0 });
  });

  it('empties fields of sessions that are gone', () => {
    expect(prune(grid, new Set(['c']))).toEqual({ fields: [null, null, 'c'], focus: 1 });
    expect(prune(grid, new Set(['a', 'c']))).toBe(grid);
  });
});
