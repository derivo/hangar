import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import semver from 'semver';
import { parseManifest, type BayManifest } from '@hangar/sdk';

/** A bay whose manifest is valid and whose files exist. */
export interface LoadedBay {
  dir: string;
  manifest: BayManifest;
}

/** A bay folder that could not be loaded; shown in the sidebar with its error. */
export interface BayLoadError {
  dir: string;
  id?: string;
  name?: string;
  error: string;
}

/** A folder of bays, or `{ bay }`: one installed bay (ADR 0034). */
export type BaySource = string | { bay: string };

/**
 * Scans every root for sub-folders containing a `manifest.json`, validates them and
 * returns loadable bays plus readable errors. Duplicate ids keep the first bay found; a
 * bay from `{ bay }` replaces later ones of its id without an error.
 */
export function discoverBays(
  roots: BaySource[],
  hangarVersion: string,
): { bays: LoadedBay[]; errors: BayLoadError[] } {
  const bays: LoadedBay[] = [];
  const errors: BayLoadError[] = [];
  const installed = new Set<string>();

  for (const root of roots) {
    const dirs =
      typeof root !== 'string'
        ? [root.bay]
        : existsSync(root)
          ? readdirSync(root)
              .sort()
              .map((entry) => join(root, entry))
          : [];
    for (const dir of dirs) {
      const manifestPath = join(dir, 'manifest.json');
      // a broken link is skipped like any other folder without manifest
      if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory() || !existsSync(manifestPath))
        continue;

      let json: unknown;
      try {
        json = JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch (e) {
        errors.push({
          dir,
          error: `manifest.json is not valid JSON: ${(e as Error).message}`,
        });
        continue;
      }
      const parsed = parseManifest(json);
      if (!parsed.ok) {
        // Keep the declared name (if any) so the sidebar can label the broken bay.
        const name = (json as { name?: unknown } | null)?.name;
        errors.push({ dir, ...(typeof name === 'string' && { name }), error: parsed.error });
        continue;
      }
      const m = parsed.manifest;
      const fail = (error: string) => errors.push({ dir, id: m.id, name: m.name, error });

      if (bays.some((b) => b.manifest.id === m.id)) {
        if (!installed.has(m.id)) fail(`Duplicate bay id "${m.id}"`);
        continue;
      }
      if (m.minHangarVersion && semver.lt(hangarVersion, m.minHangarVersion)) {
        fail(`Requires Hangar ${m.minHangarVersion} or newer (installed: ${hangarVersion})`);
        continue;
      }
      const missing = [m.icon, m.ui, m.main]
        .filter((f): f is string => f !== undefined)
        .filter((f) => !existsSync(join(dir, f)));
      if (missing.length > 0) {
        fail(`Missing file: ${missing.join(', ')}`);
        continue;
      }
      bays.push({ dir, manifest: m });
      if (typeof root !== 'string') installed.add(m.id);
    }
  }

  bays.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  return { bays, errors };
}
