import { realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import type { UiLocale } from '@hangar/sdk/i18n';
import { messages } from './messages';

export interface ServerOptions {
  /** Data folder: `permissions.json`, `jobs.json`, `settings.json`, bay data. */
  data: string;
  host: string;
  /** 0 picks a free port. */
  port: number;
  /** Folders below which projects may be added (`--root`, several). */
  roots: string[];
  /** Folders scanned for bays (`--bays`, several). */
  bays: string[];
  /** The `hangar` CLI that session shells call (`--cli`); default: the repository's build. */
  cli?: string;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** `hangar-server --data <folder> [--listen 127.0.0.1:<port>] [--root <folder>]… [--bays <folder>]… [--cli <file>]` */
export function parseOptions(argv: string[]): ServerOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      data: { type: 'string' },
      listen: { type: 'string', default: '127.0.0.1:0' },
      root: { type: 'string', multiple: true, default: [] },
      bays: { type: 'string', multiple: true },
      cli: { type: 'string' },
    },
  });
  if (!values.data) throw new Error('--data <folder> is required');
  // No open ports: the desktop reaches the server through an SSH tunnel (ADR 0018).
  const match = /^\[?([^\]]+?)\]?:(\d+)$/.exec(values.listen);
  if (!match || !LOOPBACK.has(match[1]!)) {
    throw new Error(
      '--listen must be 127.0.0.1, ::1 or localhost with a port, e.g. 127.0.0.1:7420',
    );
  }
  return {
    // Git and the bays run in other working directories.
    data: resolve(values.data),
    host: match[1]!,
    port: Number(match[2]),
    roots: values.root,
    // Bundled at apps/server/dist; the repository's bays are next to apps/.
    bays: values.bays ?? [join(import.meta.dirname, '../../../bays')],
    ...(values.cli && { cli: values.cli }),
  };
}

/**
 * Stands in for the folder dialog: the real path of `path` if it lies below one of
 * `roots`. Symlinks are resolved first, so a link cannot lead outside.
 */
export async function checkedFolder(
  path: string | undefined,
  roots: string[],
  locale: UiLocale = 'en',
): Promise<string> {
  const t = messages(locale);
  if (!path) throw new Error(t.noFolderDialog);
  const real = await realpath(path).catch(() => {
    throw new Error(t.folderNotFound(path));
  });
  const allowed = await Promise.all(roots.map((r) => realpath(r).catch(() => undefined)));
  const inside = (p: string) => allowed.some((r) => r && (p === r || p.startsWith(r + sep)));
  if (!inside(real)) throw new Error(t.folderOutside(path));
  // The agent bay works in the repository root, which may lie above the folder.
  // Without GIT_* variables of the server's environment: they could point git elsewhere.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
  );
  const top = await promisify(execFile)('git', ['-C', real, 'rev-parse', '--show-toplevel'], {
    env,
  }).then(
    ({ stdout }) => realpath(stdout.trim()),
    () => undefined,
  );
  if (top && !inside(top)) {
    throw new Error(t.repositoryOutside(top));
  }
  return real;
}
