import { randomUUID, type KeyObject } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import semver from 'semver';
import { parseManifest, type BayManifest } from '@hangar/sdk';
import { verifyIndex, type BayIndex } from './bay-index';
import { unpackBay, verifyPackage } from './bay-package';

/** What a version may do that the one before could not (ADR 0034). */
export interface RightsDiff {
  /** Functions it offers in addition. */
  functions: string[];
  /** Functions of other bays it calls in addition. */
  uses: string[];
  /** Newly issues agent session tokens. */
  agentSessions: boolean;
  hostModules: string[];
  /** Functions that were not sensitive before; their `allow` grants are reset. */
  sensitive: string[];
}

export function rightsDiff(old: BayManifest | undefined, next: BayManifest): RightsDiff {
  const before = new Map(old?.functions.map((f) => [f.name, f]));
  const added = (now: string[] = [], was: string[] = []) => now.filter((x) => !was.includes(x));
  return {
    functions: next.functions.filter((f) => !before.has(f.name)).map((f) => f.name),
    uses: added(next.uses, old?.uses),
    agentSessions: next.agentSessions === true && old?.agentSessions !== true,
    hostModules: added(next.hostModules, old?.hostModules),
    // Also a function that comes back sensitive: an old grant of it may still be stored.
    sensitive: next.functions
      .filter((f) => f.sensitive && before.get(f.name)?.sensitive !== true)
      .map((f) => f.name),
  };
}

/** One bay in the settings: what the index offers and what is installed. */
export interface CatalogEntry {
  id: string;
  /** Newest version in the index for the channel and this Hangar. */
  available?: string;
  /** Version running now, installed or bundled. */
  current?: string;
  active?: string;
  /** Version that runs from the next start. */
  next?: string;
  previous?: string;
  /** Rolling back restores a data backup; changes since the update are lost. */
  rollbackLosesData: boolean;
  /** `available` is newer than what runs and not already waiting for the next start. */
  canInstall: boolean;
  canRollback: boolean;
}

/** The bays of {@link BayStore.catalog}; `error` when the index could not be loaded. */
export interface Catalog {
  bays: CatalogEntry[];
  error?: string;
}

/** A downloaded, checked version waiting for confirmation. */
export interface PreparedInstall {
  token: string;
  id: string;
  version: string;
  manifest: BayManifest;
  diff: RightsDiff;
  dataVersionChanged: boolean;
}

interface Pending {
  version: string;
  rollback: boolean;
  resetGrants: string[];
  /** The bundled bay it replaces; its data is backed up if the format changes. */
  bundled?: { version: string; dataVersion: number };
}

interface State {
  /** Highest index version seen; an older index is refused. */
  lastIndexVersion: number;
  bays: Record<string, { active?: string; previous?: string; next?: Pending }>;
}

export interface BayStoreOptions {
  /** `<userData>/packages`: `<id>/<version>/`, `<id>/data-<version>/`, `state.json`. */
  dir: string;
  /** `<userData>/bays`: data folders of the bays. */
  dataRoot: string;
  /** Without an index there is nothing to install (built-in key: phase 21). */
  index?: { url: string; publicKey: KeyObject };
  hangarVersion: string;
  /** Manifest of the bay running now, also a bundled one. */
  current: (id: string) => BayManifest | undefined;
}

/**
 * Installed bays (ADR 0034): checked packages under `<dir>/<id>/<version>`, switched at the
 * next start, the previous version kept for a rollback together with its data.
 */
export class BayStore {
  private readonly pending = new Map<string, Pending & { id: string; tmp: string }>();

  constructor(private readonly options: BayStoreOptions) {}

  private get stateFile() {
    // `_` is no character of a bay id, so no bay folder can take this name.
    return join(this.options.dir, '_state.json');
  }

  private read(): State {
    try {
      return JSON.parse(readFileSync(this.stateFile, 'utf8')) as State;
    } catch {
      return { lastIndexVersion: 0, bays: {} };
    }
  }

  private write(state: State): void {
    mkdirSync(this.options.dir, { recursive: true });
    writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(state, null, 2));
    renameSync(`${this.stateFile}.tmp`, this.stateFile);
  }

  private versionDir(id: string, version: string) {
    return join(this.options.dir, id, version);
  }

  private manifestAt(dir: string): BayManifest {
    const parsed = parseManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')));
    if (!parsed.ok) throw new Error(`Invalid manifest in package: ${parsed.error}`);
    return parsed.manifest;
  }

  private async fetch(url: string): Promise<Buffer> {
    if (url.startsWith('https://')) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
      return Buffer.from(await response.arrayBuffer());
    }
    if (isAbsolute(url)) return readFileSync(url);
    throw new Error(`Index must be https or a local path: ${url}`);
  }

  private async loadIndex(): Promise<{ index: BayIndex; url: string; publicKey: KeyObject }> {
    if (!this.options.index) throw new Error('No bay index configured');
    const { url, publicKey } = this.options.index;
    const raw = JSON.parse((await this.fetch(url)).toString('utf8'));
    // Read after the download: another call may have changed the state meanwhile.
    const state = this.read();
    const index = verifyIndex(raw, publicKey, {
      now: new Date(),
      lastVersion: state.lastIndexVersion,
    });
    if (index.version > state.lastIndexVersion) {
      this.write({ ...state, lastIndexVersion: index.version });
    }
    return { index, url, publicKey };
  }

  /**
   * Bays of the index plus installed ones, with the newest version for `channel`. Without
   * the index the installed ones remain, so a rollback stays possible.
   */
  async catalog(channel: 'stable' | 'beta'): Promise<Catalog> {
    let offered: BayIndex['bays'] = [];
    let error: string | undefined;
    try {
      offered = this.offered((await this.loadIndex()).index, channel);
    } catch (e) {
      error = (e as Error).message;
    }
    const state = this.read();
    const ids = [...new Set([...offered.map((b) => b.id), ...Object.keys(state.bays)])].sort();
    const bays = ids.map((id) => {
      const s = state.bays[id] ?? {};
      const available = offered
        .filter((b) => b.id === id)
        .map((b) => b.version)
        .sort(semver.rcompare)[0];
      const current = this.options.current(id)?.version;
      return {
        id,
        ...(available && { available }),
        ...(current && { current }),
        ...(s.active && { active: s.active }),
        ...(s.next && { next: s.next.version }),
        ...(s.previous && { previous: s.previous }),
        canInstall:
          available !== undefined &&
          available !== s.next?.version &&
          (!current || semver.gt(available, current)),
        canRollback: s.previous !== undefined && s.next?.version !== s.previous,
        rollbackLosesData:
          s.previous !== undefined && existsSync(join(this.options.dir, id, `data-${s.previous}`)),
      };
    });
    return { bays, ...(error && { error }) };
  }

  private offered(index: BayIndex, channel: 'stable' | 'beta') {
    return index.bays.filter(
      (b) =>
        (channel === 'beta' || b.channel === 'stable') &&
        (!b.minHangarVersion || semver.gte(this.options.hangarVersion, b.minHangarVersion)),
    );
  }

  /**
   * Downloads and checks a version newer than the installed one; nothing changes until
   * {@link confirm}. Going back is {@link rollback}, which restores the data too.
   */
  async prepare(
    id: string,
    version: string,
    channel: 'stable' | 'beta' = 'stable',
  ): Promise<PreparedInstall> {
    const { index, url, publicKey } = await this.loadIndex();
    const entry = this.offered(index, channel).find((b) => b.id === id && b.version === version);
    if (!entry) throw new Error(`Not in the index: ${id} ${version}`);
    const active = this.read().bays[id]?.active;
    const old =
      this.options.current(id) ??
      (active ? this.manifestAt(this.versionDir(id, active)) : undefined);
    if (old && !semver.gt(version, old.version)) {
      throw new Error(`Not newer than the installed version: ${id} ${version}`);
    }
    const packageUrl = url.startsWith('https://')
      ? new URL(entry.url, url).href
      : join(dirname(url), entry.url);
    const bytes = await this.fetch(packageUrl);
    verifyPackage(bytes, entry, publicKey);

    const tmp = join(this.options.dir, id, `.tmp-${randomUUID()}`);
    unpackBay(bytes, tmp);
    let manifest: BayManifest;
    try {
      manifest = this.manifestAt(tmp);
      if (manifest.id !== id || manifest.version !== version) {
        throw new Error(`Package does not match the index: ${manifest.id} ${manifest.version}`);
      }
    } catch (error) {
      rmSync(tmp, { recursive: true, force: true });
      throw error;
    }
    const diff = rightsDiff(old, manifest);
    const token = randomUUID();
    this.pending.set(token, {
      id,
      version,
      tmp,
      rollback: false,
      resetGrants: diff.sensitive.map((name) => `${id}/${name}`),
      ...(old &&
        !active && { bundled: { version: old.version, dataVersion: old.dataVersion ?? 0 } }),
    });
    return {
      token,
      id,
      version,
      manifest,
      diff,
      dataVersionChanged:
        old !== undefined && (old.dataVersion ?? 0) !== (manifest.dataVersion ?? 0),
    };
  }

  /** Keeps a prepared version; it runs from the next start. Returns the bay id. */
  confirm(token: string): string {
    const p = this.pending.get(token);
    if (!p) throw new Error('Unknown or expired installation');
    this.pending.delete(token);
    const target = this.versionDir(p.id, p.version);
    // Confirmed before and published again: what was checked last is what runs. It is
    // never the running version, which `prepare` refuses.
    rmSync(target, { recursive: true, force: true });
    renameSync(p.tmp, target);
    const state = this.read();
    const { tmp: _tmp, id: _id, ...next } = p;
    state.bays[p.id] = { ...state.bays[p.id], next };
    this.write(state);
    return p.id;
  }

  /** Drops a prepared version. */
  cancel(token: string): void {
    const p = this.pending.get(token);
    this.pending.delete(token);
    if (p) rmSync(p.tmp, { recursive: true, force: true });
  }

  /** The previous version runs from the next start, with its data if `dataVersion` differs. */
  rollback(id: string): void {
    const state = this.read();
    const s = state.bays[id];
    if (!s?.previous) throw new Error(`No previous version of ${id}`);
    const diff = rightsDiff(
      this.manifestAt(this.versionDir(id, s.active!)),
      this.manifestAt(this.versionDir(id, s.previous)),
    );
    s.next = {
      version: s.previous,
      rollback: true,
      resetGrants: diff.sensitive.map((name) => `${id}/${name}`),
    };
    this.write(state);
  }

  /**
   * At start, before the bays load: switches to confirmed versions, backs up or restores
   * data when `dataVersion` changes, resets grants of newly sensitive functions and removes
   * all but the active and the previous version.
   */
  applyPending(resetGrant: (target: string) => void): void {
    const state = this.read();
    for (const [id, s] of Object.entries(state.bays)) {
      const next = s.next;
      delete s.next;
      if (next && next.version !== s.active && existsSync(this.versionDir(id, next.version))) {
        this.switchData(id, s.active, next);
        for (const target of next.resetGrants) resetGrant(target);
        s.previous = s.active;
        s.active = next.version;
      }
      const keep = new Set([s.active, s.previous, `data-${s.previous}`]);
      const folder = join(this.options.dir, id);
      for (const name of existsSync(folder) ? readdirSync(folder) : []) {
        if (!keep.has(name) && !name.startsWith('data-bundled-')) {
          rmSync(join(folder, name), { recursive: true, force: true });
        }
      }
    }
    this.write(state);
  }

  private switchData(id: string, from: string | undefined, next: Pending): void {
    const data = join(this.options.dataRoot, id);
    const dataVersion = (v: string) => this.manifestAt(this.versionDir(id, v)).dataVersion ?? 0;
    const to = dataVersion(next.version);
    if (!from) {
      // A bundled bay: kept as a copy only, there is no version folder to roll back to.
      const { bundled } = next;
      if (bundled && bundled.dataVersion !== to && existsSync(data)) {
        const backup = join(this.options.dir, id, `data-bundled-${bundled.version}`);
        rmSync(backup, { recursive: true, force: true });
        cpSync(data, backup, { recursive: true });
      }
      return;
    }
    if (dataVersion(from) === to) return;
    const backupFrom = join(this.options.dir, id, `data-${from}`);
    const backupTo = join(this.options.dir, id, `data-${next.version}`);
    rmSync(backupFrom, { recursive: true, force: true });
    if (next.rollback && existsSync(backupTo)) {
      if (existsSync(data)) renameSync(data, backupFrom);
      mkdirSync(this.options.dataRoot, { recursive: true });
      renameSync(backupTo, data);
    } else if (existsSync(data)) {
      cpSync(data, backupFrom, { recursive: true });
    }
  }

  /** Folders of the active installed versions, for `discoverBays`. */
  bayDirs(): { bay: string }[] {
    return Object.entries(this.read().bays)
      .filter(([id, s]) => s.active && existsSync(this.versionDir(id, s.active)))
      .map(([id, s]) => ({ bay: this.versionDir(id, s.active!) }));
  }
}
