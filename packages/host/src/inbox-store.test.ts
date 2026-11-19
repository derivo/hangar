import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '@hangar/bus';
import { afterEach, describe, expect, it } from 'vitest';
import { FileInboxStore } from './inbox-store';

const ben: Caller = { kind: 'remote', instance: 'SHA256:ben', workspace: 'team', bayId: 'b' };

describe('FileInboxStore', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('persists entries with file mode 600 and starts empty on a broken file', () => {
    dir = mkdtempSync(join(tmpdir(), 'hangar-inbox-'));
    const file = join(dir, 'sub', 'inbox.json');
    const entry = {
      id: 'i1',
      at: 'now',
      caller: ben,
      target: 'b/task.add',
      args: {},
      preview: '',
      state: 'pending' as const,
    };
    new FileInboxStore(file).save([entry]);
    expect(new FileInboxStore(file).load()).toEqual([entry]);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([entry]);
    writeFileSync(file, '{broken');
    expect(new FileInboxStore(file).load()).toEqual([]);
    writeFileSync(file, '{"not":"a list"}');
    expect(new FileInboxStore(file).load()).toEqual([]);
  });
});
