/** Width and height in CSS pixels. */
export interface Size {
  width: number;
  height: number;
}

/** Fields of the workspace, each showing one session or none; one field has the focus. */
export interface Grid {
  fields: (string | null)[];
  focus: number;
}

/**
 * Columns and rows for `count` fields: the arrangement whose fields stay furthest above the
 * minimum size. If none keeps every field at the minimum, as many columns as fit side by side
 * and the rows overflow (the workspace scrolls instead of squeezing terminals).
 */
export function layout(count: number, area: Size, min: Size): { columns: number; rows: number } {
  let best = { columns: 1, rows: count, scale: 0 };
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const scale = Math.min(area.width / columns / min.width, area.height / rows / min.height);
    if (scale > best.scale) best = { columns, rows, scale };
  }
  if (best.scale >= 1) return { columns: best.columns, rows: best.rows };
  const columns = Math.min(count, Math.max(1, Math.floor(area.width / min.width)));
  return { columns, rows: Math.ceil(count / columns) };
}

/** How many fields fit at the minimum size; one always does. */
export function capacity(area: Size, min: Size): number {
  return Math.max(1, Math.floor(area.width / min.width) * Math.floor(area.height / min.height));
}

/** Shows a session: focuses the field that already has it, else puts it into the focused field. */
export function place(grid: Grid, id: string): Grid {
  const index = grid.fields.indexOf(id);
  if (index !== -1) return { ...grid, focus: index };
  const fields = [...grid.fields];
  fields[grid.focus] = id;
  return { ...grid, fields };
}

export function addField(grid: Grid): Grid {
  return { fields: [...grid.fields, null], focus: grid.fields.length };
}

/** Removes a field (its session keeps running); the last field is emptied instead. */
export function closeField(grid: Grid, index: number): Grid {
  if (grid.fields.length === 1) return { fields: [null], focus: 0 };
  const fields = grid.fields.filter((_, i) => i !== index);
  const focus = grid.focus > index ? grid.focus - 1 : Math.min(grid.focus, fields.length - 1);
  return { fields, focus };
}

/** Empties fields whose session no longer exists; unchanged grids keep their identity. */
export function prune(grid: Grid, ids: Set<string>): Grid {
  if (grid.fields.every((id) => id === null || ids.has(id))) return grid;
  return { ...grid, fields: grid.fields.map((id) => (id && ids.has(id) ? id : null)) };
}
