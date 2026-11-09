import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { discoverBays } from './bay-loader';

let root: string;

function writeBay(folder: string, manifest: Record<string, unknown> | string, files = true) {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
  );
  if (files) {
    writeFileSync(join(dir, 'icon.svg'), '<svg/>');
    writeFileSync(join(dir, 'index.html'), '<html/>');
  }
  return dir;
}

const manifest = (over: Record<string, unknown> = {}) => ({
  id: 'dev.hangar.one',
  name: 'One',
  version: '1.0.0',
  icon: 'icon.svg',
  ui: 'index.html',
  ...over,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hangar-bays-'));
});

describe('discoverBays', () => {
  it('loads valid bays sorted by name and ignores plain files', () => {
    writeBay('b', manifest({ id: 'dev.hangar.b', name: 'Zulu' }));
    const a = writeBay('a', manifest({ id: 'dev.hangar.a', name: 'Alpha' }));
    writeFileSync(join(root, 'README.md'), '');
    const { bays, errors } = discoverBays([root], '0.1.0');
    expect(errors).toEqual([]);
    expect(bays.map((b) => b.manifest.name)).toEqual(['Alpha', 'Zulu']);
    expect(bays[0]!.dir).toBe(a);
  });

  it('skips folders without manifest and missing roots', () => {
    mkdirSync(join(root, 'empty'));
    expect(discoverBays([root, join(root, 'missing')], '0.1.0')).toEqual({ bays: [], errors: [] });
  });

  it('skips a broken link next to a valid bay', () => {
    writeBay('a', manifest());
    symlinkSync(join(root, 'gone'), join(root, 'link'));
    const { bays, errors } = discoverBays([root], '0.1.0');
    expect(errors).toEqual([]);
    expect(bays.map((b) => b.manifest.id)).toEqual(['dev.hangar.one']);
  });

  it('reports invalid JSON and invalid manifests', () => {
    const broken = writeBay('broken', '{nope');
    writeBay('null', 'null');
    const invalid = writeBay('invalid', manifest({ id: 'nope' }));
    const { bays, errors } = discoverBays([root], '0.1.0');
    expect(bays).toEqual([]);
    expect(errors).toEqual([
      { dir: broken, error: expect.stringContaining('manifest.json is not valid JSON') },
      { dir: invalid, name: 'One', error: 'id: must be in reverse-domain style' },
      { dir: join(root, 'null'), error: expect.stringContaining('manifest: ') },
    ]);
  });

  it('rejects a duplicate bay id', () => {
    writeBay('first', manifest());
    const second = writeBay('second', manifest({ name: 'Two' }));
    const { bays, errors } = discoverBays([root], '0.1.0');
    expect(bays).toHaveLength(1);
    expect(errors).toEqual([
      {
        dir: second,
        id: 'dev.hangar.one',
        name: 'Two',
        error: 'Duplicate bay id "dev.hangar.one"',
      },
    ]);
  });

  it('refuses bays that need a newer Hangar', () => {
    const dir = writeBay('new', manifest({ minHangarVersion: '2.0.0' }));
    const { bays, errors } = discoverBays([root], '1.4.0');
    expect(bays).toEqual([]);
    expect(errors).toEqual([
      {
        dir,
        id: 'dev.hangar.one',
        name: 'One',
        error: 'Requires Hangar 2.0.0 or newer (installed: 1.4.0)',
      },
    ]);
    expect(discoverBays([root], '2.0.0').bays).toHaveLength(1);
  });

  it('reports referenced files that do not exist', () => {
    const dir = writeBay('nofiles', manifest({ main: 'main.js' }), false);
    const { errors } = discoverBays([root], '0.1.0');
    expect(errors).toEqual([
      {
        dir,
        id: 'dev.hangar.one',
        name: 'One',
        error: 'Missing file: icon.svg, index.html, main.js',
      },
    ]);
  });
});

describe('discoverBays with single bay folders (phase 20)', () => {
  it('loads a folder given as { bay } directly; it replaces a later bay of its id silently', () => {
    const installed = writeBay('packages/dev.hangar.one/2.0.0', manifest({ version: '2.0.0' }));
    writeBay('bundled/one', manifest());
    const { bays, errors } = discoverBays([{ bay: installed }, join(root, 'bundled')], '0.1.0');
    expect(bays.map((b) => [b.dir, b.manifest.version])).toEqual([[installed, '2.0.0']]);
    expect(errors).toEqual([]);
  });

  it('skips a missing single folder', () => {
    expect(discoverBays([{ bay: join(root, 'gone') }], '0.1.0')).toEqual({ bays: [], errors: [] });
  });
});
