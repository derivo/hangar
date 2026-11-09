import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilePermissionStore } from './permissions';

const file = () => join(mkdtempSync(join(tmpdir(), 'hangar-perm-')), 'dir', 'permissions.json');

describe('FilePermissionStore', () => {
  it('persists, replaces and removes grants', () => {
    const f = file();
    const store = new FilePermissionStore(f);
    store.set({ subject: 'a', target: 'b/c', mode: 'allow' });
    store.set({ subject: 'a', target: 'b/c', mode: 'deny' });
    store.set({ subject: 'x', target: 'b/c', mode: 'ask' });
    expect(new FilePermissionStore(f).list()).toEqual([
      { subject: 'a', target: 'b/c', mode: 'deny' },
      { subject: 'x', target: 'b/c', mode: 'ask' },
    ]);
    store.remove('a', 'b/c');
    expect(new FilePermissionStore(f).get('a', 'b/c')).toBeUndefined();
  });

  it('starts empty on corrupt or unexpected files', () => {
    const f = file();
    new FilePermissionStore(f).set({ subject: 'a', target: 'b/c', mode: 'allow' });
    writeFileSync(f, '{oops');
    expect(new FilePermissionStore(f).list()).toEqual([]);
    writeFileSync(f, '{"a":1}');
    expect(new FilePermissionStore(f).list()).toEqual([]);
  });
});
