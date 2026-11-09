import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ensureLocalServer,
  bayInLocalServer,
  localServerLabel,
  localServerWanted,
  migrateFromLocalServer,
  migrateToLocalServer,
  pairWhenReady,
  serverUiRoots,
  type LocalServerOptions,
} from './local-server';

// A git hook (lefthook) sets GIT_INDEX_FILE and the like; git in a temporary repository would use them.
const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

/** A fake `run`: records calls, copies for `ditto`, `launchctl print` fails until bootstrapped. */
function setup(source?: LocalServerOptions['source']) {
  const base = mkdtempSync(join(tmpdir(), 'hangar-local-server-'));
  const calls: string[][] = [];
  const loaded = new Set<string>();
  const options: LocalServerOptions = {
    // Windows forbids < and > in file names; elsewhere they test the plist escaping too.
    userData: join(base, process.platform === 'win32' ? 'Hangar & Co' : 'Hangar & Co <dev>'),
    version: '1.2.0',
    home: '/Users/ada',
    launchAgents: join(base, 'LaunchAgents'),
    uid: 501,
    env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin' },
    source: source ?? {
      // Exists: a plist whose program is gone is written anew.
      execPath: process.execPath,
      server: '/repo/apps/server/dist/hangar-server.mjs',
      bays: '/repo/bays',
      cli: '/repo/packages/cli/dist/hangar.mjs',
    },
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'ditto') cpSync(args[0]!, args[1]!, { recursive: true });
      if (cmd === 'git') execFileSync('git', args, { stdio: 'ignore', env: gitEnv });
      if (cmd === 'launchctl' && args[0] === 'bootstrap') loaded.add(args[1]!);
      if (cmd === 'launchctl' && args[0] === 'bootout') loaded.delete('gui/501');
      if (cmd === 'launchctl' && args[0] === 'print') return loaded.has('gui/501') ? 0 : 113;
      return 0;
    },
  };
  mkdirSync(options.userData);
  const plist = () =>
    readFileSync(join(options.launchAgents, `${localServerLabel(options.userData)}.plist`), 'utf8');
  return { base, options, calls, plist };
}

/** The `<string>` values of the plist's array after `key`. */
const strings = (plist: string, key: string) =>
  [
    ...new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`)
      .exec(plist)![1]!
      .matchAll(/<string>([^<]*)<\/string>/g),
  ].map((m) => m[1]!.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));

/** A stand-in for Hangar.app with the files the server needs. */
function fakeApp(base: string) {
  const app = join(base, 'Hangar.app');
  for (const dir of ['Contents/MacOS', 'Contents/Resources/server', 'Contents/Resources/cli'])
    mkdirSync(join(app, dir), { recursive: true });
  writeFileSync(join(app, 'Contents/MacOS/Hangar'), '');
  return app;
}

// The local server is a LaunchAgent, macOS only (ADR 0036, localServerWanted).
describe.skipIf(process.platform === 'win32')('ensureLocalServer', () => {
  it('runs the server from the build as a LaunchAgent that keeps it alive, without the app', async () => {
    const { options, calls, plist } = setup();
    const { data, label } = await ensureLocalServer(options);
    const dir = join(options.userData, 'local-server');
    expect(data).toBe(join(dir, 'data'));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(data).mode & 0o777).toBe(0o700);
    expect(label).toMatch(/^dev\.hangar\.server\.[0-9a-f]{8}$/);

    const text = plist();
    expect(strings(text, 'ProgramArguments')).toEqual([
      process.execPath,
      '/repo/apps/server/dist/hangar-server.mjs',
      '--data',
      data,
      '--root',
      '/Users/ada',
      '--bays',
      '/repo/bays',
      '--cli',
      '/repo/packages/cli/dist/hangar.mjs',
    ]);
    expect(text).toContain(`<key>Label</key>\n  <string>${label}</string>`);
    expect(text).toMatch(/<key>ELECTRON_RUN_AS_NODE<\/key>\s*<string>1<\/string>/);
    expect(text).toMatch(
      /<key>PATH<\/key>\s*<string>\/usr\/bin:\/bin:\/opt\/homebrew\/bin<\/string>/,
    );
    expect(text).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(text).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    // Paths are escaped: the user data folder here holds & and <.
    expect(text).toContain(
      `<string>${join(data, 'server.log').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')}</string>`,
    );
    expect(calls).toEqual([
      ['launchctl', 'print', `gui/501/${label}`],
      ['launchctl', 'bootstrap', 'gui/501', join(options.launchAgents, `${label}.plist`)],
    ]);

    // Already running: nothing is started twice.
    calls.length = 0;
    await ensureLocalServer(options);
    expect(calls).toEqual([['launchctl', 'print', `gui/501/${label}`]]);
  });

  it('copies the packaged app once per version and runs the server from that copy', async () => {
    const base = mkdtempSync(join(tmpdir(), 'hangar-local-app-'));
    const { options, calls, plist } = setup({ app: fakeApp(base), executable: 'Hangar' });
    await ensureLocalServer(options);
    const runtime = join(options.userData, 'local-server', 'runtime');
    const copy = join(runtime, '1.2.0', 'Hangar.app');
    expect(existsSync(join(copy, 'Contents/MacOS/Hangar'))).toBe(true);
    expect(existsSync(join(runtime, '1.2.0.tmp'))).toBe(false);
    expect(calls[0]).toEqual([
      'ditto',
      join(base, 'Hangar.app'),
      join(runtime, '1.2.0.tmp', 'Hangar.app'),
    ]);
    const args = strings(plist(), 'ProgramArguments');
    expect(args.slice(0, 2)).toEqual([
      join(copy, 'Contents/MacOS/Hangar'),
      join(copy, 'Contents/Resources/server/hangar-server.mjs'),
    ]);
    expect(args.slice(-4)).toEqual([
      '--bays',
      join(copy, 'Contents/Resources/app.asar/bays'),
      '--cli',
      join(copy, 'Contents/Resources/cli/hangar.mjs'),
    ]);

    calls.length = 0;
    await ensureLocalServer(options);
    expect(calls.filter(([cmd]) => cmd === 'ditto')).toEqual([]);
  });

  it('leaves a running server in its version and removes copies no server uses', async () => {
    const base = mkdtempSync(join(tmpdir(), 'hangar-local-app-'));
    const { options, plist } = setup({ app: fakeApp(base), executable: 'Hangar' });
    const runtime = join(options.userData, 'local-server', 'runtime');
    await ensureLocalServer({ ...options, version: '1.1.0' });
    mkdirSync(join(runtime, '1.0.0', 'Hangar.app'), { recursive: true });

    // A new version of the app: the server keeps running from 1.1.0 until it is restarted.
    await ensureLocalServer(options);
    expect(strings(plist(), 'ProgramArguments')[0]).toContain(join('runtime', '1.1.0'));
    expect(existsSync(join(runtime, '1.1.0'))).toBe(true);
    // Copied only when the server is restarted in the new version.
    expect(existsSync(join(runtime, '1.2.0'))).toBe(false);
    expect(existsSync(join(runtime, '1.0.0'))).toBe(false);
  });

  it('names the version its server runs, and a restart moves it to the version of the app', async () => {
    const base = mkdtempSync(join(tmpdir(), 'hangar-local-app-'));
    const { options, calls, plist } = setup({ app: fakeApp(base), executable: 'Hangar' });
    const runtime = join(options.userData, 'local-server', 'runtime');
    expect((await ensureLocalServer({ ...options, version: '1.1.0' })).version).toBe('1.1.0');
    expect((await ensureLocalServer(options)).version).toBe('1.1.0');
    calls.length = 0;
    expect((await ensureLocalServer(options, true)).version).toBe('1.2.0');
    expect(strings(plist(), 'ProgramArguments')[0]).toContain(join('runtime', '1.2.0'));
    expect(existsSync(join(runtime, '1.1.0'))).toBe(false);
    const service = `gui/501/${localServerLabel(options.userData)}`;
    expect(calls.filter(([cmd]) => cmd === 'launchctl')).toEqual([
      ['launchctl', 'print', service],
      ['launchctl', 'bootout', service],
      ['launchctl', 'bootstrap', 'gui/501', expect.stringContaining('.plist')],
    ]);
  });

  it('copies a new build of the same version anew when the server restarts', async () => {
    const base = mkdtempSync(join(tmpdir(), 'hangar-local-app-'));
    const app = fakeApp(base);
    // Signing writes it anew with every build: it holds the hashes of all resources.
    const resources = join(app, 'Contents/_CodeSignature/CodeResources');
    mkdirSync(join(resources, '..'));
    writeFileSync(resources, 'build 1');
    const { options, calls } = setup({ app, executable: 'Hangar' });
    const runtime = join(options.userData, 'local-server', 'runtime');
    const first = await ensureLocalServer(options);
    expect(first.version).toMatch(/^1\.2\.0\+[0-9a-f]{8}$/);
    expect(first.ready).toBe(first.version);

    // The same version built anew: the server keeps its copy until it restarts.
    writeFileSync(resources, 'build 2');
    const kept = await ensureLocalServer(options);
    expect(kept.version).toBe(first.version);
    expect(kept.ready).toMatch(/^1\.2\.0\+[0-9a-f]{8}$/);
    expect(kept.ready).not.toBe(first.version);

    calls.length = 0;
    const restarted = await ensureLocalServer(options, true);
    expect(restarted.version).toBe(kept.ready);
    expect(calls.filter(([cmd]) => cmd === 'ditto')).toHaveLength(1);
    expect(readdirSync(runtime)).toEqual([kept.ready]);
  });

  it('tells builds apart without a signature too: asar hash, server, CLI, Electron', async () => {
    const base = mkdtempSync(join(tmpdir(), 'hangar-local-app-'));
    const app = fakeApp(base);
    const files = [
      'Contents/Info.plist',
      'Contents/Resources/server/hangar-server.mjs',
      'Contents/Resources/cli/hangar.mjs',
      // Its version is Electron's: an update of Electron alone is a new build too.
      'Contents/Frameworks/Electron Framework.framework/Resources/Info.plist',
    ];
    for (const file of files) {
      mkdirSync(join(app, file, '..'), { recursive: true });
      writeFileSync(join(app, file), 'build 1');
    }
    const { options } = setup({ app, executable: 'Hangar' });
    const ids = [(await ensureLocalServer(options)).ready];
    for (const file of files) {
      writeFileSync(join(app, file), 'build 2');
      ids.push((await ensureLocalServer(options)).ready);
    }
    expect(ids[0]).toMatch(/^1\.2\.0\+[0-9a-f]{8}$/);
    expect(new Set(ids).size).toBe(files.length + 1);
  });

  it('restarts a server from the build too, which has no version of its own', async () => {
    const { options, calls } = setup();
    expect((await ensureLocalServer(options)).version).toBeUndefined();
    calls.length = 0;
    await ensureLocalServer(options, true);
    expect(calls.map(([, sub]) => sub)).toEqual(['print', 'bootout', 'bootstrap']);
  });

  it('writes the LaunchAgent anew when the copy it runs from is gone', async () => {
    const base = mkdtempSync(join(tmpdir(), 'hangar-local-app-'));
    const { options, plist, calls } = setup({ app: fakeApp(base), executable: 'Hangar' });
    const { label } = await ensureLocalServer({ ...options, version: '1.1.0' });
    const runtime = join(options.userData, 'local-server', 'runtime');
    rmSync(join(runtime, '1.1.0'), { recursive: true });

    calls.length = 0;
    await ensureLocalServer(options);
    expect(strings(plist(), 'ProgramArguments')[0]).toContain(join('runtime', '1.2.0'));
    // launchd still holds the old path while the service is loaded: it is loaded anew.
    expect(calls.slice(2)).toEqual([
      ['launchctl', 'bootout', `gui/501/${label}`],
      ['launchctl', 'bootstrap', 'gui/501', join(options.launchAgents, `${label}.plist`)],
    ]);
  });

  it('starts nothing when the copy fails, and leaves no half copy as a version', async () => {
    const base = mkdtempSync(join(tmpdir(), 'hangar-local-app-'));
    const { options, calls } = setup({ app: fakeApp(base), executable: 'Hangar' });
    const failing = {
      ...options,
      run: async (cmd: string, args: string[]) => (
        calls.push([cmd, ...args]),
        cmd === 'ditto' ? 1 : 0
      ),
    };
    await expect(ensureLocalServer(failing)).rejects.toThrow(
      `Copying ${join(base, 'Hangar.app')} failed`,
    );
    expect(existsSync(join(options.userData, 'local-server', 'runtime', '1.2.0'))).toBe(false);
    expect(calls.map(([cmd]) => cmd)).toEqual(['ditto']);
  });

  it('runs the executable of the app, also when the app was renamed', async () => {
    const base = mkdtempSync(join(tmpdir(), 'hangar-local-app-'));
    const app = fakeApp(base);
    const renamed = join(base, 'Hangar Test.app');
    cpSync(app, renamed, { recursive: true });
    const { options, plist } = setup({ app: renamed, executable: 'Hangar' });
    await ensureLocalServer(options);
    expect(strings(plist(), 'ProgramArguments')[0]).toBe(
      join(options.userData, 'local-server/runtime/1.2.0/Hangar Test.app/Contents/MacOS/Hangar'),
    );
  });

  it('gives every data folder its own service', () => {
    expect(localServerLabel('/a')).not.toBe(localServerLabel('/b'));
    expect(localServerLabel('/a')).toBe(localServerLabel('/a'));
  });
});

describe('pairWhenReady', () => {
  it('tries again until the server answers, and gives up with the last error', async () => {
    let calls = 0;
    const flaky = async () => {
      if (++calls < 3) throw new Error(`not yet ${calls}`);
      return 'id';
    };
    await expect(pairWhenReady(flaky, 1000, 1)).resolves.toBe('id');
    expect(calls).toBe(3);
    await expect(
      pairWhenReady(async () => Promise.reject(new Error('Cannot reach')), 20, 5),
    ).rejects.toThrow('Cannot reach');
  });
});

// The local server is a LaunchAgent, macOS only (ADR 0036, localServerWanted).
describe.skipIf(process.platform === 'win32')('migrateToLocalServer', () => {
  const ID = 'dev.hangar.agents';
  const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
  const write = (file: string, value: unknown) => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  };
  /** The app's data with the agent bay and one other bay. */
  function appData() {
    const { options, calls } = setup();
    const { userData } = options;
    write(join(userData, 'bays', ID, 'state.json'), { projects: ['shop'] });
    write(join(userData, 'bays', 'dev.hangar.browser', 'x.json'), {});
    write(join(userData, 'jobs.json'), [
      { id: 'a', bayId: ID, label: 'Nightly' },
      { id: 'b', bayId: 'dev.hangar.other', label: 'Other' },
    ]);
    write(join(userData, 'permissions.json'), [
      { subject: 'dev.hangar.vault', target: `${ID}/session.list`, mode: 'allow' },
      // Its agents calling a bay that stays in the app: they now call from the local server.
      { subject: ID, target: 'dev.hangar.browser/open', mode: 'deny' },
    ]);
    write(join(userData, 'settings.json'), {
      theme: 'dark',
      bays: [ID],
      baySettings: { [ID]: { copyOnSelect: false }, 'dev.hangar.other': { x: true } },
    });
    const data = join(userData, 'local-server', 'data');
    return { options, calls, userData, data };
  }

  it('moves data, jobs, permissions and settings of the bay to the server, then marks it', async () => {
    const { options, calls, userData, data } = appData();
    await migrateToLocalServer(options, [ID]);
    expect(json(join(data, 'bays', ID, 'state.json'))).toEqual({ projects: ['shop'] });
    expect(existsSync(join(userData, 'bays', ID))).toBe(false);
    expect(existsSync(join(userData, 'bays', 'dev.hangar.browser'))).toBe(true);
    expect(json(join(data, 'jobs.json'))).toEqual([{ id: 'a', bayId: ID, label: 'Nightly' }]);
    expect(json(join(userData, 'jobs.json'))).toEqual([
      { id: 'b', bayId: 'dev.hangar.other', label: 'Other' },
    ]);
    expect(json(join(data, 'permissions.json'))).toEqual([
      { subject: 'dev.hangar.vault', target: `${ID}/session.list`, mode: 'allow' },
    ]);
    expect(json(join(userData, 'permissions.json'))).toEqual([
      { subject: `local-server:${ID}`, target: 'dev.hangar.browser/open', mode: 'deny' },
    ]);
    expect(json(join(data, 'settings.json')).baySettings).toEqual({
      [ID]: { copyOnSelect: false },
    });
    expect(json(join(userData, 'settings.json')).baySettings).toEqual({
      'dev.hangar.other': { x: true },
    });
    expect(json(join(userData, 'settings.json')).theme).toBe('dark');
    expect(existsSync(join(userData, 'local-server', 'migrated'))).toBe(true);
    // Not loaded here: nothing to stop.
    expect(calls).toEqual([['launchctl', 'print', `gui/501/${localServerLabel(userData)}`]]);

    // Once only.
    calls.length = 0;
    write(join(userData, 'jobs.json'), [{ id: 'c', bayId: ID, label: 'Later' }]);
    await migrateToLocalServer(options, [ID]);
    expect(calls).toEqual([]);
    expect(json(join(userData, 'jobs.json'))).toEqual([{ id: 'c', bayId: ID, label: 'Later' }]);
  });

  it('stops a server started before (step 1) and replaces its empty bay data', async () => {
    const { options, calls, userData, data } = appData();
    write(join(data, 'bays', ID, 'state.json'), { projects: [] });
    const label = localServerLabel(userData);
    const running = {
      ...options,
      run: async (cmd: string, args: string[]) => (calls.push([cmd, ...args]), 0),
    };
    await migrateToLocalServer(running, [ID]);
    expect(calls).toEqual([
      ['launchctl', 'print', `gui/501/${label}`],
      ['launchctl', 'bootout', `gui/501/${label}`],
    ]);
    expect(json(join(data, 'bays', ID, 'state.json'))).toEqual({ projects: ['shop'] });
  });

  it('finishes a move that broke off, without doubling anything', async () => {
    const { options, userData, data } = appData();
    // The last attempt moved the folder and the job, then stopped.
    mkdirSync(join(data, 'bays'), { recursive: true });
    renameSync(join(userData, 'bays', ID), join(data, 'bays', ID));
    write(join(data, 'jobs.json'), [{ id: 'a', bayId: ID, label: 'Nightly' }]);
    await migrateToLocalServer(options, [ID]);
    expect(json(join(data, 'bays', ID, 'state.json'))).toEqual({ projects: ['shop'] });
    expect(json(join(data, 'jobs.json'))).toEqual([{ id: 'a', bayId: ID, label: 'Nightly' }]);
    expect(existsSync(join(userData, 'local-server', 'migrated'))).toBe(true);
  });

  it('keeps worktree sessions working: paths in state.json and git follow the move', async () => {
    const { options, userData, data } = appData();
    const repo = mkdtempSync(join(tmpdir(), 'hangar-migrate-repo-'));
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim();
    git(repo, 'init', '-q');
    git(
      repo,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@x',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'i',
    );
    const old = join(userData, 'bays', ID, 'worktrees', 'shop-abc');
    git(repo, 'worktree', 'add', '-q', '-b', 'hangar/abc', old);
    write(join(userData, 'bays', ID, 'state.json'), {
      projects: [],
      sessions: [
        { id: 'abc', worktreePath: old },
        { id: 'def', worktreePath: repo },
      ],
    });
    await migrateToLocalServer(options, [ID]);
    const moved = join(data, 'bays', ID, 'worktrees', 'shop-abc');
    expect(json(join(data, 'bays', ID, 'state.json')).sessions).toEqual([
      { id: 'abc', worktreePath: moved },
      { id: 'def', worktreePath: repo },
    ]);
    expect(git(moved, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('hangar/abc');
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(
      `worktree ${realpathSync(moved)}`,
    );
  });

  it('leaves the rules of its agents while the bay stays in the app (stop failed)', async () => {
    const { options, userData } = appData();
    // `launchctl print` finds the service, `bootout` fails.
    let n = 0;
    options.run = async () => (n++ === 0 ? 0 : 1);
    await expect(migrateToLocalServer(options, [ID])).rejects.toThrow(
      'Stopping the local server failed',
    );
    expect(json(join(userData, 'permissions.json'))).toContainEqual({
      subject: ID,
      target: 'dev.hangar.browser/open',
      mode: 'deny',
    });
  });

  /** The app's workspaces with an identity whose keys only its keychain reads. */
  const appWorkspaces = (userData: string) => {
    write(join(userData, 'workspaces', 'relay-identity.json'), {
      document: { name: 'mac' },
      keys: 'safe:K',
    });
    write(join(userData, 'workspaces', 'workspaces.json'), {
      relay: 'wss://relay.example',
      workspaces: [],
    });
  };
  const toServer = (keys: string) => keys.replace('safe:', 'plain:');

  it('moves the workspaces with the identity to the server, the keys readable there (ADR 0036, point 11)', async () => {
    const { options, userData, data } = appData();
    appWorkspaces(userData);
    // A server started before made an identity of its own; the app's wins.
    write(join(data, 'workspaces', 'relay-identity.json'), {
      document: { name: 'other' },
      keys: 'plain:X',
    });
    await migrateToLocalServer({ ...options, keys: toServer }, [ID]);
    const identity = join(data, 'workspaces', 'relay-identity.json');
    expect(json(identity)).toEqual({ document: { name: 'mac' }, keys: 'plain:K' });
    expect(statSync(identity).mode & 0o777).toBe(0o600);
    expect(json(join(data, 'workspaces', 'workspaces.json')).relay).toBe('wss://relay.example');
    expect(existsSync(join(userData, 'workspaces'))).toBe(false);
  });

  it('moves the workspaces also after step 4 had moved the bay, stopping the server first', async () => {
    const { options, calls, userData, data } = appData();
    write(join(userData, 'local-server', 'migrated'), '2026-11-03');
    const label = localServerLabel(userData);
    const running = {
      ...options,
      keys: toServer,
      run: async (cmd: string, args: string[]) => (calls.push([cmd, ...args]), 0),
    };
    await migrateToLocalServer(running, [ID]);
    // Nothing to move: the server keeps running.
    expect(calls).toEqual([]);
    // Made by every start of the app, but never used (no workspaces.json): it goes, and the
    // server's shells keep running.
    write(join(userData, 'workspaces', 'relay-identity.json'), { document: {}, keys: 'safe:U' });
    await migrateToLocalServer(running, [ID]);
    expect(calls).toEqual([]);
    expect(existsSync(join(userData, 'workspaces'))).toBe(false);
    appWorkspaces(userData);
    await migrateToLocalServer(running, [ID]);
    expect(calls).toEqual([
      ['launchctl', 'print', `gui/501/${label}`],
      ['launchctl', 'bootout', `gui/501/${label}`],
    ]);
    expect(json(join(data, 'workspaces', 'relay-identity.json')).keys).toBe('plain:K');
  });

  it('moves workspaces as they are without a way to write the keys, or without keys', async () => {
    const { options, userData, data } = appData();
    const identity = join(data, 'workspaces', 'relay-identity.json');
    write(join(userData, 'workspaces', 'relay-identity.json'), { document: {}, keys: 'safe:K' });
    write(join(userData, 'workspaces', 'workspaces.json'), { workspaces: [] });
    await migrateToLocalServer(options, [ID]);
    expect(json(identity)).toEqual({ document: {}, keys: 'safe:K' });
    // Once more after the move, an identity without keys.
    write(join(userData, 'workspaces', 'relay-identity.json'), { document: {} });
    write(join(userData, 'workspaces', 'workspaces.json'), { workspaces: [] });
    await migrateToLocalServer(options, [ID]);
    expect(json(identity)).toEqual({ document: {} });
  });

  it('moves the rules of its agents on bays of the app also after step 2 had migrated (Codex)', async () => {
    const { options, userData } = appData();
    write(join(userData, 'local-server', 'migrated'), '2026-11-03');
    await migrateToLocalServer(options, [ID]);
    expect(json(join(userData, 'permissions.json'))).toEqual([
      { subject: 'dev.hangar.vault', target: `${ID}/session.list`, mode: 'allow' },
      { subject: `local-server:${ID}`, target: 'dev.hangar.browser/open', mode: 'deny' },
    ]);
  });

  it('keeps what a server of step 1 already had, next to the moved data', async () => {
    const { options, data } = appData();
    write(join(data, 'bays', ID, 'state.json'), { projects: ['from-server'] });
    await migrateToLocalServer(options, [ID]);
    expect(json(join(data, 'bays', ID, 'state.json'))).toEqual({ projects: ['shop'] });
    expect(json(join(data, 'bays', `${ID}.before-migration`, 'state.json'))).toEqual({
      projects: ['from-server'],
    });
  });

  it('moves nothing while the server cannot be stopped, and tries again next time', async () => {
    const { options, userData } = appData();
    const stuck = {
      ...options,
      run: async (_cmd: string, args: string[]) => (args[0] === 'bootout' ? 5 : 0),
    };
    await expect(migrateToLocalServer(stuck, [ID])).rejects.toThrow(
      'Stopping the local server failed',
    );
    expect(existsSync(join(userData, 'bays', ID))).toBe(true);
    expect(existsSync(join(userData, 'local-server', 'migrated'))).toBe(false);
  });

  it('lets the app decide where app and server name the same permission or job', async () => {
    const { options, userData, data } = appData();
    write(join(userData, 'permissions.json'), [
      { subject: 'dev.hangar.vault', target: `${ID}/job.add`, mode: 'deny' },
    ]);
    write(join(data, 'permissions.json'), [
      { subject: 'dev.hangar.vault', target: `${ID}/job.add`, mode: 'allow' },
    ]);
    write(join(data, 'jobs.json'), [{ id: 'a', bayId: ID, label: 'Server' }]);
    await migrateToLocalServer(options, [ID]);
    expect(json(join(data, 'permissions.json'))).toEqual([
      { subject: 'dev.hangar.vault', target: `${ID}/job.add`, mode: 'deny' },
    ]);
    expect(json(join(data, 'jobs.json'))).toEqual([{ id: 'a', bayId: ID, label: 'Nightly' }]);
  });

  it('stops when a file cannot be read, rather than marking the move done', async () => {
    const { options, userData } = appData();
    rmSync(join(userData, 'jobs.json'));
    mkdirSync(join(userData, 'jobs.json'));
    await expect(migrateToLocalServer(options, [ID])).rejects.toThrow();
    expect(existsSync(join(userData, 'local-server', 'migrated'))).toBe(false);
  });

  it('moves nothing that is not there', async () => {
    const { options } = setup();
    await migrateToLocalServer(options, [ID]);
    const dir = join(options.userData, 'local-server');
    expect(existsSync(join(dir, 'migrated'))).toBe(true);
    expect(existsSync(join(dir, 'data', 'jobs.json'))).toBe(false);
  });
});

// The local server is a LaunchAgent, macOS only (ADR 0036, localServerWanted).
describe.skipIf(process.platform === 'win32')('migrateFromLocalServer', () => {
  const ID = 'dev.hangar.agents';
  const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
  const write = (file: string, value: unknown) => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  };
  /** Moved to the server and running there, as after step 2, with a runtime copy and a plist. */
  async function onServer() {
    const { options, calls } = setup();
    const { userData } = options;
    write(join(userData, 'bays', ID, 'state.json'), { projects: ['shop'] });
    write(join(userData, 'jobs.json'), [{ id: 'a', bayId: ID, label: 'Nightly' }]);
    write(join(userData, 'permissions.json'), [
      { subject: 'dev.hangar.vault', target: `${ID}/session.list`, mode: 'allow' },
      { subject: ID, target: 'dev.hangar.browser/open', mode: 'deny' },
    ]);
    write(join(userData, 'settings.json'), { theme: 'dark', baySettings: { [ID]: { a: true } } });
    await migrateToLocalServer(options, [ID]);
    await ensureLocalServer(options);
    const dir = join(userData, 'local-server');
    const data = join(dir, 'data');
    write(join(dir, 'runtime', '1.2.0', 'Hangar.app', 'x'), {});
    write(join(data, 'listen.json'), { port: 1 });
    write(join(userData, 'servers.json'), [
      { id: 'loc', name: 'Lokaler Server', local: data },
      { id: 'srv', name: 'Heimserver', url: 'ws://127.0.0.1:2/connect' },
    ]);
    calls.length = 0;
    const plistFile = join(options.launchAgents, `${localServerLabel(userData)}.plist`);
    return { options, calls, userData, dir, data, plistFile };
  }

  it('moves every bay it runs there and back, the board with the agent bay (ADR 0037)', async () => {
    const BOARD = 'dev.hangar.board';
    const { options, userData, data } = await onServer();
    write(join(userData, 'bays', BOARD, 'board.json'), [{ id: 't1' }]);
    write(join(userData, 'permissions.json'), [
      { subject: BOARD, target: `${ID}/session.info`, mode: 'allow' },
    ]);
    // Switched on again from scratch: the board went with it.
    rmSync(join(userData, 'local-server', 'migrated'));
    await migrateToLocalServer(options, [ID, BOARD]);
    expect(json(join(data, 'bays', BOARD, 'board.json'))).toEqual([{ id: 't1' }]);
    expect(json(join(data, 'permissions.json'))).toContainEqual({
      subject: BOARD,
      target: `${ID}/session.info`,
      mode: 'allow',
    });
    await migrateFromLocalServer(options, [ID, BOARD]);
    expect(json(join(userData, 'bays', BOARD, 'board.json'))).toEqual([{ id: 't1' }]);
    expect(existsSync(join(data, 'bays', BOARD))).toBe(false);
    expect(existsSync(join(userData, 'bays', ID, 'state.json'))).toBe(true);
  });

  it('stops the server, moves the bay back with what changed there and leaves no service', async () => {
    const { options, calls, userData, dir, data, plistFile } = await onServer();
    // Changed while it ran in the server: the server's state wins on the way back.
    write(join(data, 'bays', ID, 'state.json'), { projects: ['shop', 'blog'] });
    write(join(data, 'jobs.json'), [
      { id: 'a', bayId: ID, label: 'Nightly 2' },
      { id: 'z', bayId: 'dev.hangar.server-only', label: 'Stays' },
    ]);
    write(join(userData, 'jobs.json'), [{ id: 'a', bayId: ID, label: 'Old' }]);
    await migrateFromLocalServer(options, [ID]);
    const service = `gui/501/${localServerLabel(userData)}`;
    expect(calls).toEqual([
      ['launchctl', 'print', service],
      ['launchctl', 'bootout', service],
    ]);
    // Else launchd would start it again at the next login.
    expect(existsSync(plistFile)).toBe(false);
    expect(json(join(userData, 'bays', ID, 'state.json'))).toEqual({ projects: ['shop', 'blog'] });
    expect(existsSync(join(data, 'bays', ID))).toBe(false);
    expect(json(join(userData, 'jobs.json'))).toEqual([{ id: 'a', bayId: ID, label: 'Nightly 2' }]);
    expect(json(join(data, 'jobs.json'))).toEqual([
      { id: 'z', bayId: 'dev.hangar.server-only', label: 'Stays' },
    ]);
    expect(json(join(userData, 'permissions.json'))).toEqual([
      // Its agents call from the app again.
      { subject: ID, target: 'dev.hangar.browser/open', mode: 'deny' },
      { subject: 'dev.hangar.vault', target: `${ID}/session.list`, mode: 'allow' },
    ]);
    expect(json(join(data, 'permissions.json'))).toEqual([]);
    expect(json(join(userData, 'settings.json'))).toEqual({
      theme: 'dark',
      baySettings: { [ID]: { a: true } },
    });
    // The copies (one app each) go; key and rest of the server stay for the next time.
    expect(existsSync(join(dir, 'runtime'))).toBe(false);
    expect(existsSync(join(data, 'listen.json'))).toBe(true);
    expect(json(join(userData, 'servers.json'))).toEqual([
      { id: 'srv', name: 'Heimserver', url: 'ws://127.0.0.1:2/connect' },
    ]);
    expect(existsSync(join(dir, 'migrated'))).toBe(false);

    // Done: nothing to do on the next start; on again, it moves once more.
    calls.length = 0;
    await migrateFromLocalServer(options, [ID]);
    expect(calls).toEqual([]);
    await migrateToLocalServer(options, [ID]);
    expect(json(join(data, 'bays', ID, 'state.json'))).toEqual({ projects: ['shop', 'blog'] });
    expect(json(join(userData, 'permissions.json'))).toEqual([
      { subject: `local-server:${ID}`, target: 'dev.hangar.browser/open', mode: 'deny' },
    ]);
  });

  it('leaves the identity readable where it was when the move breaks off (Codex 5)', async () => {
    const { options, userData, data } = await onServer();
    write(join(data, 'workspaces', 'relay-identity.json'), { document: {}, keys: 'plain:K' });
    write(join(data, 'workspaces', 'workspaces.json'), { workspaces: [] });
    // The keys are written for the app, then clearing the target fails.
    const stuck = join(userData, 'workspaces');
    write(join(stuck, 'old.json'), {});
    chmodSync(stuck, 0o500);
    try {
      await expect(
        migrateFromLocalServer({ ...options, keys: (k) => k.replace('plain:', 'safe:') }, [ID]),
      ).rejects.toThrow();
    } finally {
      chmodSync(stuck, 0o700);
    }
    expect(json(join(data, 'workspaces', 'relay-identity.json')).keys).toBe('plain:K');
  });

  it('brings worktree sessions back: paths in state.json and git follow the way back', async () => {
    const { options, userData, data } = await onServer();
    const repo = mkdtempSync(join(tmpdir(), 'hangar-return-repo-'));
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim();
    git(repo, 'init', '-q');
    git(
      repo,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@x',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'i',
    );
    const there = join(data, 'bays', ID, 'worktrees', 'shop-abc');
    git(repo, 'worktree', 'add', '-q', '-b', 'hangar/abc', there);
    write(join(data, 'bays', ID, 'state.json'), {
      projects: [],
      sessions: [{ id: 'abc', worktreePath: there }],
    });
    await migrateFromLocalServer(options, [ID]);
    const back = join(userData, 'bays', ID, 'worktrees', 'shop-abc');
    expect(json(join(userData, 'bays', ID, 'state.json')).sessions).toEqual([
      { id: 'abc', worktreePath: back },
    ]);
    expect(git(back, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('hangar/abc');
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(
      `worktree ${realpathSync(back)}`,
    );
  });

  it('moves the workspaces back with the identity, the keys protected again', async () => {
    const { options, userData, data } = await onServer();
    write(join(data, 'workspaces', 'relay-identity.json'), {
      document: { name: 'mac' },
      keys: 'plain:K',
    });
    write(join(data, 'workspaces', 'workspaces.json'), { workspaces: [] });
    await migrateFromLocalServer({ ...options, keys: (k) => k.replace('plain:', 'safe:') }, [ID]);
    const identity = join(userData, 'workspaces', 'relay-identity.json');
    expect(json(identity)).toEqual({ document: { name: 'mac' }, keys: 'safe:K' });
    expect(statSync(identity).mode & 0o777).toBe(0o600);
    expect(existsSync(join(data, 'workspaces'))).toBe(false);
  });

  it('keeps the rules the person set in the server for its agents on bays of the app (Codex 4b)', async () => {
    const { options, userData, data } = await onServer();
    // Allowed in the app before the move, denied at the server's own check since.
    write(join(userData, 'permissions.json'), [
      { subject: `local-server:${ID}`, target: 'dev.hangar.browser/open', mode: 'allow' },
    ]);
    write(join(data, 'permissions.json'), [
      { subject: ID, target: 'dev.hangar.browser/open', mode: 'deny' },
    ]);
    await migrateFromLocalServer(options, [ID]);
    expect(json(join(userData, 'permissions.json'))).toEqual([
      { subject: ID, target: 'dev.hangar.browser/open', mode: 'deny' },
    ]);
    expect(json(join(data, 'permissions.json'))).toEqual([]);
  });

  it('runs the bay where its data lies after a broken way back, and finishes either way (Codex 4b)', async () => {
    const { options, userData, data } = await onServer();
    // Cannot be read: the way back stops after the bay's folder moved.
    rmSync(join(userData, 'jobs.json'), { force: true });
    mkdirSync(join(userData, 'jobs.json'));
    await expect(migrateFromLocalServer(options, [ID])).rejects.toThrow();
    expect(bayInLocalServer(userData, ID)).toBe(false);
    expect(existsSync(join(userData, 'bays', ID, 'state.json'))).toBe(true);
    // Switched on again before the way back finished: everything moves to the server once more.
    rmSync(join(userData, 'jobs.json'), { recursive: true });
    await migrateToLocalServer(options, [ID]);
    expect(bayInLocalServer(userData, ID)).toBe(true);
    expect(existsSync(join(userData, 'bays', ID))).toBe(false);
    expect(existsSync(join(userData, 'local-server', 'migrated'))).toBe(true);
    expect(existsSync(join(userData, 'local-server', 'returning'))).toBe(false);
    expect(json(join(data, 'jobs.json'))).toEqual([{ id: 'a', bayId: ID, label: 'Nightly' }]);
  });

  it('moves nothing while the server cannot be stopped, and tries again next time', async () => {
    const { options, userData, dir, plistFile } = await onServer();
    let n = 0;
    options.run = async () => (n++ === 0 ? 0 : 1);
    await expect(migrateFromLocalServer(options, [ID])).rejects.toThrow(
      'Stopping the local server failed',
    );
    expect(existsSync(plistFile)).toBe(true);
    expect(existsSync(join(dir, 'migrated'))).toBe(true);
    expect(existsSync(join(userData, 'bays', ID))).toBe(false);
    expect(bayInLocalServer(userData, ID)).toBe(true);
  });

  it('keeps the bay in the server it cannot stop, also when the bay never wrote data', async () => {
    const { options, userData, data } = await onServer();
    rmSync(join(data, 'bays', ID), { recursive: true });
    let n = 0;
    options.run = async () => (n++ === 0 ? 0 : 1);
    await expect(migrateFromLocalServer(options, [ID])).rejects.toThrow(
      'Stopping the local server failed',
    );
    // The server still runs the bay: the app must not start a second one.
    expect(bayInLocalServer(userData, ID)).toBe(true);
  });

  it('only removes the service of a server that never got the bay (step 1)', async () => {
    const { options, calls } = setup();
    await ensureLocalServer(options);
    calls.length = 0;
    await migrateFromLocalServer(options, [ID]);
    expect(calls.map((c) => c.slice(0, 2))).toEqual([
      ['launchctl', 'print'],
      ['launchctl', 'bootout'],
    ]);
    expect(
      existsSync(join(options.launchAgents, `${localServerLabel(options.userData)}.plist`)),
    ).toBe(false);
    expect(existsSync(join(options.userData, 'bays', ID))).toBe(false);
  });

  it('does nothing where it never ran', async () => {
    const { options, calls } = setup();
    await migrateFromLocalServer(options, [ID]);
    expect(calls).toEqual([]);
  });
});

describe('localServerWanted', () => {
  it('runs on macOS when packaged or chosen, the variable decides over both', () => {
    const on = (o: Partial<Parameters<typeof localServerWanted>[0]>) =>
      localServerWanted({ platform: 'darwin', packaged: true, ...o });
    expect(on({})).toBe(true);
    expect(on({ packaged: false })).toBe(false);
    expect(on({ setting: false })).toBe(false);
    expect(on({ packaged: false, setting: true })).toBe(true);
    expect(on({ env: '0' })).toBe(false);
    expect(on({ packaged: false, setting: false, env: '1' })).toBe(true);
    // Windows and Linux keep the agent bay in the app (ADR 0036, point 12).
    expect(on({ platform: 'win32', env: '1', setting: true })).toBe(false);
    expect(on({ platform: 'linux' })).toBe(false);
  });
});

describe('serverUiRoots', () => {
  it('names the bay folder inside every runtime copy', () => {
    const { options } = setup();
    const runtime = join(options.userData, 'local-server', 'runtime');
    mkdirSync(join(runtime, '1.1.0', 'Hangar.app', 'Contents/Resources/app.asar/bays'), {
      recursive: true,
    });
    mkdirSync(join(runtime, '1.2.0.tmp', 'Hangar.app'), { recursive: true });
    expect(serverUiRoots(options.userData)).toEqual([
      join(runtime, '1.1.0', 'Hangar.app', 'Contents/Resources/app.asar/bays'),
    ]);
    expect(serverUiRoots(join(options.userData, 'none'))).toEqual([]);
  });
});
