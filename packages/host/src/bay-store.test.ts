import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BayManifest } from '@hangar/sdk';
import { signIndex, type BayIndexEntry } from './bay-index';
import { packBay } from './bay-package';
import { BayStore, rightsDiff } from './bay-store';

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

const manifest = (over: Partial<BayManifest> = {}): BayManifest => ({
  id: 'dev.hangar.notes',
  name: 'Notizen',
  version: '1.0.0',
  icon: 'icon.svg',
  ui: 'dist/index.html',
  functions: [{ name: 'note.add', sensitive: false }],
  ...over,
});

/** A local index folder signed with `key`: `index.json` and `v1/bays/<id>/<version>.bay`. */
function publish(
  dir: string,
  key: KeyObject,
  bays: { manifest: BayManifest; channel?: 'stable' | 'beta'; minHangarVersion?: string }[],
  version = 1,
  expires = '2099-01-01T00:00:00Z',
) {
  const entries: BayIndexEntry[] = bays.map(({ manifest: m, channel = 'stable', ...rest }) => {
    const src = temp('hangar-store-src-');
    writeFileSync(join(src, 'manifest.json'), JSON.stringify(m));
    writeFileSync(join(src, 'icon.svg'), '<svg/>');
    mkdirSync(join(src, 'dist'));
    writeFileSync(join(src, 'dist', 'index.html'), `<p>${m.version}</p>`);
    const pkg = packBay(src, key);
    const url = `v1/bays/${m.id}/${m.version}.bay`;
    mkdirSync(join(dir, 'v1', 'bays', m.id), { recursive: true });
    writeFileSync(join(dir, url), pkg.bytes);
    const { sha256, size, signature } = pkg;
    return { id: m.id, version: m.version, channel, sha256, size, signature, url, ...rest };
  });
  writeFileSync(
    join(dir, 'index.json'),
    JSON.stringify(signIndex({ version, expires, bays: entries }, key)),
  );
}

function setup(current: (id: string) => BayManifest | undefined = () => undefined) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const indexDir = temp('hangar-index-');
  const userData = temp('hangar-userdata-');
  const options = {
    dir: join(userData, 'packages'),
    dataRoot: join(userData, 'bays'),
    index: { url: join(indexDir, 'index.json'), publicKey },
    hangarVersion: '0.5.0',
    current,
  };
  return { store: new BayStore(options), options, indexDir, privateKey, userData };
}

const activeVersion = (store: BayStore) =>
  store
    .bayDirs()
    .map((d) => JSON.parse(readFileSync(join(d.bay, 'manifest.json'), 'utf8')).version);

describe('BayStore (phase 20, ADR 0034)', () => {
  it('lists the newest version per bay for the channel and this Hangar', async () => {
    const { store, indexDir, privateKey } = setup();
    publish(indexDir, privateKey, [
      { manifest: manifest() },
      { manifest: manifest({ version: '1.1.0' }) },
      { manifest: manifest({ version: '2.0.0-beta.1' }), channel: 'beta' },
      { manifest: manifest({ version: '3.0.0' }), minHangarVersion: '9.0.0' },
    ]);
    expect((await store.catalog('stable')).bays).toEqual([
      expect.objectContaining({ id: 'dev.hangar.notes', available: '1.1.0', canInstall: true }),
    ]);
    expect((await store.catalog('beta')).bays[0]).toMatchObject({ available: '2.0.0-beta.1' });
  });

  it('installs only after confirmation, active from the next start', async () => {
    const { store, indexDir, privateKey, options } = setup();
    publish(indexDir, privateKey, [{ manifest: manifest({ agentSessions: true }) }]);
    const prepared = await store.prepare('dev.hangar.notes', '1.0.0');
    expect(prepared.diff).toEqual({
      functions: ['note.add'],
      uses: [],
      agentSessions: true,
      hostModules: [],
      sensitive: [],
    });
    expect(store.bayDirs()).toEqual([]);
    expect(store.confirm(prepared.token)).toBe('dev.hangar.notes');
    expect(store.bayDirs()).toEqual([]);
    expect((await store.catalog('stable')).bays[0]).toMatchObject({
      next: '1.0.0',
      canInstall: false,
    });

    // Next start: a new store on the same folder applies the switch.
    const restarted = new BayStore(options);
    restarted.applyPending(vi.fn());
    expect(activeVersion(restarted)).toEqual(['1.0.0']);
    expect((await restarted.catalog('stable')).bays[0]).toMatchObject({ active: '1.0.0' });
  });

  it('shows what an update adds and resets grants of newly sensitive functions', async () => {
    const old = manifest({ uses: ['dev.hangar.agents/handover.get'] });
    const { store, indexDir, privateKey, options } = setup(() => old);
    publish(indexDir, privateKey, [
      {
        manifest: manifest({
          version: '1.1.0',
          functions: [
            { name: 'note.add', sensitive: true },
            { name: 'note.list', sensitive: false },
          ],
          uses: ['dev.hangar.agents/handover.get', 'dev.hangar.browser/page.open'],
          hostModules: ['browser'],
        }),
      },
    ]);
    const prepared = await store.prepare('dev.hangar.notes', '1.1.0');
    expect(prepared.diff).toEqual({
      functions: ['note.list'],
      uses: ['dev.hangar.browser/page.open'],
      agentSessions: false,
      hostModules: ['browser'],
      sensitive: ['note.add'],
    });
    store.confirm(prepared.token);
    const reset = vi.fn();
    new BayStore(options).applyPending(reset);
    expect(reset).toHaveBeenCalledWith('dev.hangar.notes/note.add');
  });

  it('backs data up when dataVersion changes and restores it on rollback', async () => {
    const { store, indexDir, privateKey, options } = setup();
    publish(indexDir, privateKey, [
      { manifest: manifest({ dataVersion: 1 }) },
      { manifest: manifest({ version: '2.0.0', dataVersion: 2 }) },
    ]);
    store.confirm((await store.prepare('dev.hangar.notes', '1.0.0')).token);
    let running = new BayStore(options);
    running.applyPending(vi.fn());
    const data = join(options.dataRoot, 'dev.hangar.notes');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'notes.json'), 'v1 data');

    const update = await running.prepare('dev.hangar.notes', '2.0.0');
    expect(update.dataVersionChanged).toBe(true);
    running.confirm(update.token);
    running = new BayStore(options);
    running.applyPending(vi.fn());
    expect(activeVersion(running)).toEqual(['2.0.0']);
    // The new version migrates the data in place; the backup keeps the old state.
    writeFileSync(join(data, 'notes.json'), 'v2 data');

    expect((await running.catalog('stable')).bays[0]).toMatchObject({
      active: '2.0.0',
      previous: '1.0.0',
      rollbackLosesData: true,
      canRollback: true,
    });
    running.rollback('dev.hangar.notes');
    expect((await running.catalog('stable')).bays[0]).toMatchObject({ canRollback: false });
    running = new BayStore(options);
    running.applyPending(vi.fn());
    expect(activeVersion(running)).toEqual(['1.0.0']);
    expect(readFileSync(join(data, 'notes.json'), 'utf8')).toBe('v1 data');
  });

  it('keeps only the active and the previous version', async () => {
    const { store, indexDir, privateKey, options } = setup();
    publish(
      indexDir,
      privateKey,
      ['1.0.0', '1.1.0', '1.2.0'].map((version) => ({ manifest: manifest({ version }) })),
    );
    let running = store;
    for (const version of ['1.0.0', '1.1.0', '1.2.0']) {
      running.confirm((await running.prepare('dev.hangar.notes', version)).token);
      running = new BayStore(options);
      running.applyPending(vi.fn());
    }
    expect(readdirSync(join(options.dir, 'dev.hangar.notes')).sort()).toEqual(['1.1.0', '1.2.0']);
  });

  it('rejects a tampered package and one that is not what the index names', async () => {
    const { store, indexDir, privateKey } = setup();
    publish(indexDir, privateKey, [{ manifest: manifest() }]);
    const file = join(indexDir, 'v1/bays/dev.hangar.notes/1.0.0.bay');
    const bytes = readFileSync(file);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(file, bytes);
    await expect(store.prepare('dev.hangar.notes', '1.0.0')).rejects.toThrow(
      'Package checksum mismatch',
    );

    const other = setup();
    publish(other.indexDir, other.privateKey, [{ manifest: manifest() }]);
    // Same index entry, but the package inside says it is another bay.
    const index = JSON.parse(readFileSync(join(other.indexDir, 'index.json'), 'utf8'));
    publish(other.indexDir, other.privateKey, [{ manifest: manifest({ id: 'dev.hangar.other' }) }]);
    const forged = JSON.parse(readFileSync(join(other.indexDir, 'index.json'), 'utf8'));
    index.signed.bays[0] = { ...forged.signed.bays[0], id: 'dev.hangar.notes', version: '1.0.0' };
    writeFileSync(
      join(other.indexDir, 'index.json'),
      JSON.stringify(signIndex(index.signed, other.privateKey)),
    );
    await expect(other.store.prepare('dev.hangar.notes', '1.0.0')).rejects.toThrow(
      'Package does not match the index: dev.hangar.other 1.0.0',
    );
    await expect(other.store.prepare('dev.hangar.notes', '9.9.9')).rejects.toThrow(
      'Not in the index: dev.hangar.notes 9.9.9',
    );
  });

  it('refuses an index older than the one seen before, also after a restart', async () => {
    const { store, indexDir, privateKey, options } = setup();
    publish(indexDir, privateKey, [{ manifest: manifest() }], 5);
    await store.catalog('stable');
    publish(indexDir, privateKey, [{ manifest: manifest() }], 4);
    expect(await new BayStore(options).catalog('stable')).toEqual({
      bays: [],
      error: 'Index version 4 is older than the last one seen (5)',
    });
  });

  it('has no catalog without an index and no rollback without a previous version', async () => {
    const { options } = setup();
    const store = new BayStore({ ...options, index: undefined });
    expect(await store.catalog('stable')).toEqual({ bays: [], error: 'No bay index configured' });
    expect(() => store.rollback('dev.hangar.notes')).toThrow(
      'No previous version of dev.hangar.notes',
    );
  });

  it('drops an unconfirmed download on cancel', async () => {
    const { store, indexDir, privateKey, options } = setup();
    publish(indexDir, privateKey, [{ manifest: manifest() }]);
    const prepared = await store.prepare('dev.hangar.notes', '1.0.0');
    store.cancel(prepared.token);
    expect(readdirSync(join(options.dir, 'dev.hangar.notes'))).toEqual([]);
    expect(() => store.confirm(prepared.token)).toThrow('Unknown or expired installation');
    expect(existsSync(join(options.dir, 'dev.hangar.notes', '1.0.0'))).toBe(false);
  });
});

describe('BayStore edge cases', () => {
  it('fetches index and packages over https', async () => {
    const { options, indexDir, privateKey } = setup((id) => manifest({ id, version: '0.9.0' }));
    publish(indexDir, privateKey, [{ manifest: manifest() }]);
    const fetch = vi.fn(async (url: string) => {
      const path = join(indexDir, new URL(url).pathname.replace('/hangar/', ''));
      return existsSync(path)
        ? new Response(readFileSync(path))
        : new Response('missing', { status: 404 });
    });
    vi.stubGlobal('fetch', fetch);
    try {
      const store = new BayStore({
        ...options,
        index: { ...options.index, url: 'https://bays.example/hangar/index.json' },
      });
      expect((await store.catalog('stable')).bays[0]).toMatchObject({
        available: '1.0.0',
        current: '0.9.0',
        canInstall: true,
      });
      await store.prepare('dev.hangar.notes', '1.0.0');
      expect(fetch).toHaveBeenLastCalledWith(
        'https://bays.example/hangar/v1/bays/dev.hangar.notes/1.0.0.bay',
      );
      rmSync(join(indexDir, 'v1'), { recursive: true });
      await expect(store.prepare('dev.hangar.notes', '1.0.0')).rejects.toThrow(
        'Download failed: 404 https://bays.example/hangar/v1/bays/dev.hangar.notes/1.0.0.bay',
      );
    } finally {
      vi.unstubAllGlobals();
    }
    const plain = new BayStore({
      ...options,
      index: { ...options.index, url: 'http://bays.example/i.json' },
    });
    expect((await plain.catalog('stable')).error).toBe(
      'Index must be https or a local path: http://bays.example/i.json',
    );
  });

  it('rejects a package whose manifest is invalid', async () => {
    const { store, indexDir, privateKey, options } = setup();
    publish(indexDir, privateKey, [{ manifest: manifest({ name: '' }) }]);
    await expect(store.prepare('dev.hangar.notes', '1.0.0')).rejects.toThrow(
      'Invalid manifest in package: name',
    );
    expect(readdirSync(join(options.dir, 'dev.hangar.notes'))).toEqual([]);
  });

  it('keeps data of the same format without a backup', async () => {
    const { store, indexDir, privateKey, options } = setup();
    publish(indexDir, privateKey, [
      { manifest: manifest() },
      { manifest: manifest({ version: '1.1.0' }) },
    ]);
    store.confirm((await store.prepare('dev.hangar.notes', '1.0.0')).token);
    let running = new BayStore(options);
    running.applyPending(vi.fn());
    mkdirSync(join(options.dataRoot, 'dev.hangar.notes'), { recursive: true });
    running.confirm((await running.prepare('dev.hangar.notes', '1.1.0')).token);
    running.cancel('unknown');
    running = new BayStore(options);
    running.applyPending(vi.fn());
    expect(activeVersion(running)).toEqual(['1.1.0']);
    expect(readdirSync(join(options.dir, 'dev.hangar.notes')).sort()).toEqual(['1.0.0', '1.1.0']);
  });

  it('resets grants when the version rolled back to has a newly sensitive function', async () => {
    const { store, indexDir, privateKey, options } = setup();
    publish(indexDir, privateKey, [
      { manifest: manifest({ functions: [{ name: 'note.add', sensitive: true }] }) },
      { manifest: manifest({ version: '1.1.0' }) },
    ]);
    let running = store;
    for (const version of ['1.0.0', '1.1.0']) {
      running.confirm((await running.prepare('dev.hangar.notes', version)).token);
      running = new BayStore(options);
      running.applyPending(vi.fn());
    }
    running.rollback('dev.hangar.notes');
    const reset = vi.fn();
    new BayStore(options).applyPending(reset);
    expect(reset).toHaveBeenCalledWith('dev.hangar.notes/note.add');
  });

  it('skips a switch whose version folder is gone', async () => {
    const { store, indexDir, privateKey, options } = setup();
    publish(indexDir, privateKey, [{ manifest: manifest() }]);
    store.confirm((await store.prepare('dev.hangar.notes', '1.0.0')).token);
    rmSync(join(options.dir, 'dev.hangar.notes'), { recursive: true });
    const running = new BayStore(options);
    running.applyPending(vi.fn());
    expect(running.bayDirs()).toEqual([]);
  });
});

describe('BayStore after the Codex review of phase 20', () => {
  /** `fetch` for an https index in `indexDir`; `hold()` keeps the next index answer back. */
  function httpsIndex(indexDir: string) {
    const held: (() => void)[] = [];
    let holding = false;
    vi.stubGlobal('fetch', async (url: string) => {
      const body = readFileSync(join(indexDir, new URL(url).pathname.replace('/hangar/', '')));
      if (holding && url.endsWith('index.json')) {
        holding = false;
        await new Promise<void>((r) => held.push(r));
      }
      return new Response(body);
    });
    return {
      url: 'https://bays.example/hangar/index.json',
      hold: () => (holding = true),
      release: () => held.splice(0).forEach((r) => r()),
    };
  }

  it('keeps a confirmation made while an index loads, and never lowers the index version', async () => {
    const { options, indexDir, privateKey } = setup();
    publish(indexDir, privateKey, [{ manifest: manifest() }], 5);
    const https = httpsIndex(indexDir);
    try {
      const store = new BayStore({ ...options, index: { ...options.index, url: https.url } });
      const prepared = await store.prepare('dev.hangar.notes', '1.0.0');
      https.hold();
      const slow = store.catalog('stable');
      await vi.waitFor(() => expect(https.release).toBeDefined());
      store.confirm(prepared.token);
      publish(indexDir, privateKey, [{ manifest: manifest() }], 6);
      await store.catalog('stable');
      https.release();
      // The slow answer was index 5, read before index 6 was seen.
      expect((await slow).error).toBe('Index version 5 is older than the last one seen (6)');
      expect((await store.catalog('stable')).bays[0]).toMatchObject({ next: '1.0.0' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses a version that is not newer than the installed one', async () => {
    const { store, indexDir, privateKey, options } = setup();
    publish(indexDir, privateKey, [
      { manifest: manifest() },
      { manifest: manifest({ version: '2.0.0' }) },
    ]);
    store.confirm((await store.prepare('dev.hangar.notes', '2.0.0')).token);
    const running = new BayStore(options);
    running.applyPending(vi.fn());
    for (const version of ['2.0.0', '1.0.0']) {
      await expect(running.prepare('dev.hangar.notes', version)).rejects.toThrow(
        `Not newer than the installed version: dev.hangar.notes ${version}`,
      );
    }
  });

  it('activates what was confirmed last, also for the same version published again', async () => {
    const { store, indexDir, privateKey, options } = setup();
    publish(indexDir, privateKey, [{ manifest: manifest({ hostModules: ['browser'] }) }], 1);
    store.confirm((await store.prepare('dev.hangar.notes', '1.0.0')).token);
    publish(indexDir, privateKey, [{ manifest: manifest() }], 2);
    const again = await store.prepare('dev.hangar.notes', '1.0.0');
    expect(again.diff.hostModules).toEqual([]);
    store.confirm(again.token);
    const running = new BayStore(options);
    running.applyPending(vi.fn());
    const [dir] = running.bayDirs();
    expect(JSON.parse(readFileSync(join(dir!.bay, 'manifest.json'), 'utf8')).hostModules).toBe(
      undefined,
    );
  });

  it('backs up the data of a bundled bay it replaces with a new data format', async () => {
    const bundled = manifest({ version: '0.9.0', dataVersion: 1 });
    const { store, indexDir, privateKey, options } = setup(() => bundled);
    publish(indexDir, privateKey, [{ manifest: manifest({ dataVersion: 2 }) }]);
    const data = join(options.dataRoot, 'dev.hangar.notes');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'notes.json'), 'bundled data');
    const prepared = await store.prepare('dev.hangar.notes', '1.0.0');
    expect(prepared.dataVersionChanged).toBe(true);
    store.confirm(prepared.token);
    new BayStore(options).applyPending(vi.fn());
    new BayStore(options).applyPending(vi.fn());
    expect(
      readFileSync(
        join(options.dir, 'dev.hangar.notes', 'data-bundled-0.9.0', 'notes.json'),
        'utf8',
      ),
    ).toBe('bundled data');
  });

  it('restores the backup on rollback even when the data folder is gone', async () => {
    const { store, indexDir, privateKey, options } = setup();
    publish(indexDir, privateKey, [
      { manifest: manifest({ dataVersion: 1 }) },
      { manifest: manifest({ version: '2.0.0', dataVersion: 2 }) },
    ]);
    const data = join(options.dataRoot, 'dev.hangar.notes');
    let running = store;
    for (const version of ['1.0.0', '2.0.0']) {
      running.confirm((await running.prepare('dev.hangar.notes', version)).token);
      running = new BayStore(options);
      running.applyPending(vi.fn());
      if (version === '1.0.0') {
        mkdirSync(data, { recursive: true });
        writeFileSync(join(data, 'notes.json'), 'data 1.0.0');
      }
    }
    rmSync(data, { recursive: true });
    running.rollback('dev.hangar.notes');
    new BayStore(options).applyPending(vi.fn());
    expect(readFileSync(join(data, 'notes.json'), 'utf8')).toBe('data 1.0.0');
  });

  it('switches the data format without a backup when the bay has no data yet', async () => {
    const { store, indexDir, privateKey, options } = setup();
    publish(indexDir, privateKey, [
      { manifest: manifest({ dataVersion: 1 }) },
      { manifest: manifest({ version: '2.0.0', dataVersion: 2 }) },
    ]);
    let running = store;
    for (const version of ['1.0.0', '2.0.0']) {
      running.confirm((await running.prepare('dev.hangar.notes', version)).token);
      running = new BayStore(options);
      running.applyPending(vi.fn());
    }
    expect(activeVersion(running)).toEqual(['2.0.0']);
    expect((await running.catalog('stable')).bays[0]).toMatchObject({ rollbackLosesData: false });
  });

  it('keeps its state apart from bay folders, whatever the bay id', async () => {
    const { store, indexDir, privateKey, options } = setup();
    publish(indexDir, privateKey, [{ manifest: manifest({ id: 'state.json.tmp' }) }]);
    store.cancel((await store.prepare('state.json.tmp', '1.0.0')).token);
    expect(() => new BayStore(options).applyPending(vi.fn())).not.toThrow();
  });

  it('still offers the rollback when the index cannot be loaded', async () => {
    const { store, indexDir, privateKey, options } = setup();
    publish(indexDir, privateKey, [
      { manifest: manifest() },
      { manifest: manifest({ version: '1.1.0' }) },
    ]);
    let running = store;
    for (const version of ['1.0.0', '1.1.0']) {
      running.confirm((await running.prepare('dev.hangar.notes', version)).token);
      running = new BayStore(options);
      running.applyPending(vi.fn());
    }
    rmSync(join(indexDir, 'index.json'));
    const { bays, error } = await running.catalog('stable');
    expect(error).toMatch(/ENOENT/);
    expect(bays).toEqual([
      expect.objectContaining({ id: 'dev.hangar.notes', previous: '1.0.0', canRollback: true }),
    ]);
  });

  it('installs a beta version only on the beta channel', async () => {
    const { store, indexDir, privateKey } = setup();
    publish(indexDir, privateKey, [
      { manifest: manifest({ version: '2.0.0-beta.1' }), channel: 'beta' },
    ]);
    await expect(store.prepare('dev.hangar.notes', '2.0.0-beta.1', 'stable')).rejects.toThrow(
      'Not in the index: dev.hangar.notes 2.0.0-beta.1',
    );
    await expect(store.prepare('dev.hangar.notes', '2.0.0-beta.1', 'beta')).resolves.toMatchObject({
      version: '2.0.0-beta.1',
    });
  });
});

describe('rightsDiff', () => {
  it('resets grants of a sensitive function that was not there before (Codex review)', () => {
    const old = manifest({ functions: [] });
    const next = manifest({ functions: [{ name: 'note.add', sensitive: true }] });
    expect(rightsDiff(old, next).sensitive).toEqual(['note.add']);
  });

  it('counts everything as new for a first installation', () => {
    expect(
      rightsDiff(undefined, manifest({ uses: ['dev.a.b/c'], hostModules: ['workspaces'] })),
    ).toEqual({
      functions: ['note.add'],
      uses: ['dev.a.b/c'],
      agentSessions: false,
      hostModules: ['workspaces'],
      sensitive: [],
    });
  });
});
