import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadState, saveState } from './store';

const file = () => join(mkdtempSync(join(tmpdir(), 'hangar-store-')), 'sub', 'state.json');

describe('store', () => {
  it('round-trips the state', () => {
    const f = file();
    const state = { projects: [{ id: 'p', name: 'n', path: '/x' }], sessions: [] };
    saveState(f, state);
    expect(loadState(f)).toEqual(state);
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual(state);
  });

  it('returns an empty state for missing, partial or corrupt files', () => {
    const f = file();
    expect(loadState(f)).toEqual({ projects: [], sessions: [] });
    saveState(f, { projects: [], sessions: [] });
    writeFileSync(f, '{}');
    expect(loadState(f)).toEqual({ projects: [], sessions: [] });
  });

  it('keeps a copy of a corrupt file and reports it', () => {
    const f = file();
    saveState(f, { projects: [], sessions: [] });
    writeFileSync(f, '{broken');
    const onCorrupt = vi.fn();
    expect(loadState(f, onCorrupt)).toEqual({ projects: [], sessions: [] });
    const copy = readdirSync(dirname(f)).find((n) => n.startsWith('state.json.corrupt-'));
    expect(copy).toBeDefined();
    expect(readFileSync(join(dirname(f), copy!), 'utf8')).toBe('{broken');
    expect(onCorrupt).toHaveBeenCalledWith(join(dirname(f), copy!));
  });
});
