import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { checkedFolder, parseOptions, withoutGitVars } from './options';

describe('parseOptions', () => {
  it('reads data folder, address, roots and bay folders', () => {
    expect(
      parseOptions([
        '--data',
        '/srv/hangar',
        '--listen',
        '127.0.0.1:7420',
        '--root',
        '/srv/repos',
        '--root',
        '/home/agent/work',
        '--bays',
        '/opt/bays',
        '--cli',
        '/opt/hangar/cli/hangar.mjs',
      ]),
    ).toEqual({
      data: resolve('/srv/hangar'),
      host: '127.0.0.1',
      port: 7420,
      roots: ['/srv/repos', '/home/agent/work'],
      bays: ['/opt/bays'],
      cli: '/opt/hangar/cli/hangar.mjs',
    });
  });

  it('makes a relative data folder absolute', () => {
    // Git runs in other working directories; a relative path would point elsewhere there.
    expect(parseOptions(['--data', 'data']).data).toBe(join(process.cwd(), 'data'));
  });

  it('defaults to a free port on 127.0.0.1, no roots and the bundled bays', () => {
    const options = parseOptions(['--data', '/srv/hangar']);
    expect(options).toMatchObject({ host: '127.0.0.1', port: 0, roots: [] });
    expect(options.bays).toHaveLength(1);
    expect(options.cli).toBeUndefined();
  });

  it('rejects a missing data folder and addresses other than loopback', () => {
    expect(() => parseOptions([])).toThrow('--data <folder> is required');
    expect(() => parseOptions(['--data', 'd', '--listen', '0.0.0.0:7420'])).toThrow(
      '--listen must be 127.0.0.1, ::1 or localhost with a port, e.g. 127.0.0.1:7420',
    );
    expect(() => parseOptions(['--data', 'd', '--listen', '127.0.0.1'])).toThrow('--listen');
    expect(() => parseOptions(['--data', 'd', '--port', '1'])).toThrow();
  });
});

describe('checkedFolder', () => {
  const setup = () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'hangar-roots-')));
    const root = join(base, 'repos');
    const outside = join(base, 'secret');
    mkdirSync(join(root, 'app'), { recursive: true });
    mkdirSync(outside);
    mkdirSync(`${root}-evil`);
    return { root, outside };
  };

  it('accepts a folder below a root and returns its real path', async () => {
    const { root } = setup();
    await expect(checkedFolder(join(root, 'app', '..', 'app'), [root])).resolves.toBe(
      join(root, 'app'),
    );
    await expect(checkedFolder(root, [root])).resolves.toBe(root);
  });

  it('rejects a folder outside the roots, also through a symlink', async () => {
    const { root, outside } = setup();
    symlinkSync(outside, join(root, 'link'));
    await expect(checkedFolder(outside, [root])).rejects.toThrow(
      `Folder outside the allowed roots (--root): ${outside}`,
    );
    await expect(checkedFolder(join(root, 'link'), [root])).rejects.toThrow(
      'Folder outside the allowed roots (--root)',
    );
    // A sibling whose name starts like the root is not below it.
    await expect(checkedFolder(`${root}-evil`, [root])).rejects.toThrow(
      'Folder outside the allowed roots (--root)',
    );
  });

  it('rejects a folder below a root whose repository reaches outside it', async () => {
    const { root } = setup();
    // The agent bay keeps the repository root (`git rev-parse --show-toplevel`), not the folder.
    const repo = join(root, '..', 'repo');
    mkdirSync(join(repo, 'allowed'), { recursive: true });
    // Without GIT_* of a calling git hook (lefthook sets GIT_DIR): init must create `repo`.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
    );
    execFileSync('git', ['init', '-q', repo], { env });
    await expect(checkedFolder(join(repo, 'allowed'), [join(repo, 'allowed')])).rejects.toThrow(
      `Repository root outside the allowed roots (--root): ${repo}`,
    );
    await expect(checkedFolder(join(repo, 'allowed'), [repo])).resolves.toBe(join(repo, 'allowed'));
    // Git variables of the server's environment must not move the repository root.
    vi.stubEnv('GIT_WORK_TREE', join(repo, 'allowed'));
    vi.stubEnv('GIT_DIR', join(repo, '.git'));
    try {
      await expect(checkedFolder(join(repo, 'allowed'), [join(repo, 'allowed')])).rejects.toThrow(
        'Repository root outside the allowed roots (--root)',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('speaks the language of the desktop (ADR 0019)', async () => {
    const { root, outside } = setup();
    await expect(checkedFolder(undefined, [root], 'de')).rejects.toThrow(
      'Auf dem Server gibt es keinen Ordnerdialog: Pfad angeben',
    );
    await expect(checkedFolder(join(root, 'nope'), [root], 'de')).rejects.toThrow(
      `Ordner nicht gefunden: ${join(root, 'nope')}`,
    );
    await expect(checkedFolder(outside, [root], 'de')).rejects.toThrow(
      `Ordner außerhalb der erlaubten Wurzeln (--root): ${outside}`,
    );
  });

  it('needs a path and an existing folder', async () => {
    const { root } = setup();
    await expect(checkedFolder(undefined, [root])).rejects.toThrow(
      'There is no folder dialog on the server: pass a path',
    );
    await expect(checkedFolder(join(root, 'missing'), [root])).rejects.toThrow(
      `Folder not found: ${join(root, 'missing')}`,
    );
  });
});

describe('withoutGitVars', () => {
  it('drops GIT_ variables in any case (Windows reads names case-insensitively)', () => {
    expect(
      withoutGitVars({ GIT_DIR: 'a', git_dir: 'b', Git_Config_Count: '1', PATH: '/bin' }),
    ).toEqual({ PATH: '/bin' });
  });
});
