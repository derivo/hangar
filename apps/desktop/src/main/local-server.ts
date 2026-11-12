import { createHash } from 'node:crypto';
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
import { basename, join, sep } from 'node:path';

export interface LocalServerOptions {
  userData: string;
  version: string;
  /** The only `--root`: projects may lie anywhere in the home folder. */
  home: string;
  /** Folder of the plist, `~/Library/LaunchAgents`. */
  launchAgents: string;
  uid: number;
  /** Environment of the service besides `ELECTRON_RUN_AS_NODE`, e.g. `PATH`: launchd only has
   * the system folders. */
  env?: Record<string, string>;
  /** Packaged: the running `.app`, copied once per build. Otherwise the repository's build. */
  source:
    | { app: string; executable: string }
    | { execPath: string; server: string; bays: string; cli: string };
  /** Runs a command and returns its exit code. */
  run(cmd: string, args: string[]): Promise<number>;
}

/**
 * Whether the agent bay runs in the local server (ADR 0036, step 4b): only on macOS; there by
 * default in the packaged app, not in a build from the repository (`pnpm dev`, E2E). The setting
 * in Hangar decides over that, `HANGAR_LOCAL_SERVER` (`0`, `1`) over both.
 */
export function localServerWanted(o: {
  platform: NodeJS.Platform;
  packaged: boolean;
  setting?: boolean;
  env?: string;
}): boolean {
  if (o.platform !== 'darwin') return false;
  if (o.env === '0' || o.env === '1') return o.env === '1';
  return o.setting ?? o.packaged;
}

/** One service per data folder: the dev profile and tests never take over the installed app's. */
export const localServerLabel = (userData: string) =>
  `dev.hangar.server.${createHash('sha256').update(userData).digest('hex').slice(0, 8)}`;

/** `<userData>/local-server`: data folder, runtime copies and the `migrated` marker. */
const localDir = (userData: string) => join(userData, 'local-server');

/**
 * Bay folders of the runtime copies: the UI of a server bay comes from its own version. With
 * `build` (the copy the server runs, `ensureLocalServer().version`) only that copy.
 */
export function serverUiRoots(userData: string, build?: string): string[] {
  const runtime = join(localDir(userData), 'runtime');
  if (!existsSync(runtime)) return [];
  const versions = readdirSync(runtime).filter((v) => build === undefined || v === build);
  return versions.flatMap((version) =>
    readdirSync(join(runtime, version))
      .filter((name) => name.endsWith('.app'))
      .map((name) => join(runtime, version, name, 'Contents', 'Resources', 'app.asar', 'bays'))
      .filter((dir) => existsSync(dir)),
  );
}

/**
 * Moves the bays `bayIds` from the app to the local server once (ADR 0036, point 8; the board
 * goes with the agent bay, ADR 0037): their data, jobs, the permissions to call them and their
 * settings. Runs before the app loads permissions and
 * jobs, with the server stopped. Each part is idempotent, so a move that broke off finishes
 * on the next start; only then the `migrated` marker is written.
 */
export async function migrateToLocalServer(
  o: Pick<LocalServerOptions, 'userData' | 'uid' | 'run'> & MovedKeys,
  bayIds: readonly string[],
): Promise<void> {
  const dir = localDir(o.userData);
  const marker = join(dir, 'migrated');
  const data = join(dir, 'data');
  const service = `gui/${o.uid}/${localServerLabel(o.userData)}`;
  // Also after the move: a move of step 2 did not know this part yet (Codex), one of step 4
  // not the workspaces.
  if (existsSync(marker)) {
    for (const bayId of bayIds) followAgentGrants(o.userData, bayId);
    if (!usedWorkspaces(o.userData))
      return rmSync(join(o.userData, 'workspaces'), { recursive: true, force: true });
    await stop(o, service);
    return moveWorkspaces(o.userData, data, o.keys);
  }
  // A server still running would write its old state over what moves in.
  await stop(o, service);
  mkdirSync(data, { recursive: true, mode: 0o700 });
  // The app's entries win: a server of step 1 never saw what the person decided since.
  for (const bayId of bayIds) {
    await moveBay(o, bayId, o.userData, data);
    followAgentGrants(o.userData, bayId);
  }
  moveWorkspaces(o.userData, data, o.keys);
  writeFileSync(`${marker}.tmp`, new Date().toISOString());
  renameSync(`${marker}.tmp`, marker);
  // A way back that broke off: this move took what had already returned.
  rmSync(join(dir, 'returning'), { force: true });
}

/**
 * Where the bay runs after a move that broke off: in the server while it is moved there (the
 * marker stays until a way back stopped the server, also for a bay that never wrote data),
 * else where its folder lies.
 */
export const bayInLocalServer = (userData: string, bayId: string) =>
  existsSync(join(localDir(userData), 'migrated')) ||
  existsSync(join(localDir(userData), 'data', 'bays', bayId));

/**
 * The way back (ADR 0036, step 4b): the local server switched off. Stops and removes its
 * service and copies, moves the bay with what changed there back into the app, and removes the
 * server from `servers.json`. Its data folder with the key stays for the next time. Runs before
 * the app loads permissions and jobs. Underway the marker is `returning`, not `migrated`: a
 * break finishes next start, or a move switched on again takes everything once more.
 */
export async function migrateFromLocalServer(
  o: Pick<LocalServerOptions, 'userData' | 'uid' | 'run' | 'launchAgents'> & MovedKeys,
  bayIds: readonly string[],
): Promise<void> {
  const dir = localDir(o.userData);
  const marker = join(dir, 'migrated');
  const returning = join(dir, 'returning');
  const label = localServerLabel(o.userData);
  const plistFile = join(o.launchAgents, `${label}.plist`);
  const moved = existsSync(marker) || existsSync(returning);
  if (!moved && !existsSync(plistFile)) return;
  await stop(o, `gui/${o.uid}/${label}`);
  // Else launchd starts it again at the next login.
  rmSync(plistFile, { force: true });
  if (moved) {
    if (existsSync(marker)) renameSync(marker, returning);
    const data = join(dir, 'data');
    for (const bayId of bayIds) {
      // The server's entries win: they are what the person did since the move.
      await moveBay(o, bayId, data, o.userData);
      rekeyGrants(o.userData, `local-server:${bayId}`, bayId);
      // Its agents' rules on bays of the app, set at the server's own check (ADR 0036, point 7).
      moveEntries<{ subject: string; target: string }>(
        data,
        o.userData,
        'permissions.json',
        (g) => g.subject === bayId,
        (g) => `${g.subject}\n${g.target}`,
      );
    }
    moveWorkspaces(data, o.userData, o.keys);
  }
  const servers = join(o.userData, 'servers.json');
  const saved = readArray<{ local?: string }>(servers);
  if (saved.some((s) => s.local))
    writeJson(
      servers,
      saved.filter((s) => !s.local),
    );
  rmSync(join(dir, 'runtime'), { recursive: true, force: true });
  rmSync(returning, { force: true });
}

interface MovedKeys {
  /** Writes the private keys of the relay identity for the side they move to (`safe:`/`plain:`). */
  keys?: (keys: string) => string;
}

async function stop(o: Pick<LocalServerOptions, 'run'>, service: string): Promise<void> {
  if ((await o.run('launchctl', ['print', service])) !== 0) return;
  if ((await o.run('launchctl', ['bootout', service])) !== 0)
    throw new Error('Stopping the local server failed');
  // The old server would otherwise still write into the data being moved.
  if (!(await unloaded(o, service))) throw new Error('Stopping the local server failed');
}

/** A relay or workspace was set up: `workspaces.json` exists only after that. */
const usedWorkspaces = (dir: string) => existsSync(join(dir, 'workspaces', 'workspaces.json'));

/**
 * Moves the workspaces with the instance's relay identity (ADR 0036, point 11): one instance,
 * the same fingerprint on either side. The moving folder wins. The keys are written for the
 * other side in a copy; the source stays readable where it is until the copy took its place,
 * so a move that broke off does it again (Codex).
 */
function moveWorkspaces(from: string, to: string, keys = (k: string) => k): void {
  const source = join(from, 'workspaces');
  // Every start makes an identity; one never used for a relay stays where it is wanted.
  if (!usedWorkspaces(from)) return rmSync(source, { recursive: true, force: true });
  const target = join(to, 'workspaces');
  const copy = `${target}.moving`;
  rmSync(copy, { recursive: true, force: true });
  mkdirSync(to, { recursive: true, mode: 0o700 });
  cpSync(source, copy, { recursive: true });
  const file = join(copy, 'relay-identity.json');
  const identity = readJson(file) as { keys?: string } | undefined;
  if (typeof identity?.keys === 'string')
    writeJson(file, { ...identity, keys: keys(identity.keys) }, 0o600);
  rmSync(target, { recursive: true, force: true });
  renameSync(copy, target);
  rmSync(source, { recursive: true, force: true });
}

/**
 * Moves the bay's data, jobs, the permissions to call it and its settings from the folder
 * `from` (the app's or the server's data folder) to `to`. The moving entries win; what `to`
 * had of the bay's data stays next to it. Each part is idempotent.
 */
async function moveBay(
  o: Pick<LocalServerOptions, 'run'>,
  bayId: string,
  from: string,
  to: string,
): Promise<void> {
  const source = join(from, 'bays', bayId);
  const target = join(to, 'bays', bayId);
  if (existsSync(source)) {
    mkdirSync(join(to, 'bays'), { recursive: true });
    if (existsSync(target)) {
      rmSync(`${target}.before-migration`, { recursive: true, force: true });
      renameSync(target, `${target}.before-migration`);
    }
    renameSync(source, target);
  }
  await followWorktrees(o, source, target);
  const move = <T>(file: string, mine: (entry: T) => boolean, key: (entry: T) => string) =>
    moveEntries(from, to, file, mine, key);
  move<{ id: string; bayId: string }>(
    'jobs.json',
    (j) => j.bayId === bayId,
    (j) => j.id,
  );
  move<{ subject: string; target: string }>(
    'permissions.json',
    (g) => g.target.startsWith(`${bayId}/`),
    (g) => `${g.subject}\n${g.target}`,
  );
  const fromSettings = readObject(join(from, 'settings.json'));
  const baySettings = (fromSettings.baySettings ?? {}) as Record<string, unknown>;
  if (bayId in baySettings) {
    const toSettings = readObject(join(to, 'settings.json'));
    const theirs = (toSettings.baySettings ?? {}) as Record<string, unknown>;
    writeJson(join(to, 'settings.json'), {
      ...toSettings,
      baySettings: { ...theirs, [bayId]: baySettings[bayId] },
    });
    const { [bayId]: _moved, ...rest } = baySettings;
    writeJson(join(from, 'settings.json'), { ...fromSettings, baySettings: rest });
  }
}

/**
 * Moves the entries `mine` of the JSON list `file` from folder `from` to `to`; they win over
 * entries of `to` with the same `key`. Written to `to` first, removed from `from` after: a break
 * leaves a copy, never nothing.
 */
function moveEntries<T>(
  from: string,
  to: string,
  file: string,
  mine: (entry: T) => boolean,
  key: (entry: T) => string,
): void {
  const here = readArray<T>(join(from, file));
  const moving = here.filter(mine);
  if (moving.length === 0) return;
  const keys = new Set(moving.map(key));
  const there = readArray<T>(join(to, file)).filter((e) => !keys.has(key(e)));
  writeJson(join(to, file), [...there, ...moving]);
  writeJson(
    join(from, file),
    here.filter((e) => !mine(e)),
  );
}

/**
 * The agents of `bayId` call the bays that stay in the app from the local server now (ADR 0036,
 * point 7): their rules here, a denial above all, follow them to the subject `local-server:…`.
 */
function followAgentGrants(userData: string, bayId: string): void {
  rekeyGrants(userData, bayId, `local-server:${bayId}`);
}

/** Gives the app's rules of subject `from` the subject `to`. */
function rekeyGrants(userData: string, from: string, to: string): void {
  const file = join(userData, 'permissions.json');
  const grants = readArray<{ subject: string }>(file);
  if (!grants.some((g) => g.subject === from)) return;
  writeJson(
    file,
    grants.map((g) => (g.subject === from ? { ...g, subject: to } : g)),
  );
}

function readArray<T>(file: string): T[] {
  const value = readJson(file);
  return Array.isArray(value) ? (value as T[]) : [];
}

function readObject(file: string): Record<string, unknown> {
  const value = readJson(file);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Worktrees of older sessions lie in the bay's data folder (ADR 0022): their paths in
 * `state.json` and git's link back from the repository point to the old place.
 */
async function followWorktrees(
  o: Pick<LocalServerOptions, 'run'>,
  from: string,
  to: string,
): Promise<void> {
  const file = join(to, 'state.json');
  const state = readObject(file);
  const sessions = (state.sessions ?? []) as { worktreePath?: string }[];
  let changed = false;
  for (const s of sessions) {
    if (!s.worktreePath?.startsWith(from + sep)) continue;
    s.worktreePath = to + s.worktreePath.slice(from.length);
    // A failed repair leaves only git in that worktree broken, the session restores.
    await o.run('git', ['-C', s.worktreePath, 'worktree', 'repair']);
    changed = true;
  }
  if (changed) writeJson(file, state);
}

/** Missing or damaged JSON is no data, as for its readers; any other read error stops the move. */
function readJson(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown, mode?: number): void {
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode });
  renameSync(`${file}.tmp`, file);
}

/**
 * Makes sure the local server runs as a LaunchAgent (ADR 0036): from a copy of the app per
 * build, so an update replaces nothing it or its shells still use. `restart` starts it anew
 * in the build of this app; its shells end. Returns its data folder, the build it runs and the
 * build of this app, as `<version>+<build id>` (none when it runs from the repository's build).
 */
export async function ensureLocalServer(
  o: LocalServerOptions,
  restart = false,
): Promise<{ data: string; label: string; version?: string; ready?: string }> {
  const name = copyName(o);
  const dir = localDir(o.userData);
  const data = join(dir, 'data');
  const runtime = join(dir, 'runtime');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const label = localServerLabel(o.userData);
  const plistFile = join(o.launchAgents, `${label}.plist`);
  const current = existsSync(plistFile) ? readFileSync(plistFile, 'utf8') : undefined;
  const program =
    current && /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)</.exec(current);
  // A running server keeps its version until it is restarted (ADR 0036, point 10).
  const kept = !restart && !!program && existsSync(unescape(program[1]!));
  if (!kept) {
    const args = await serverArgs(o, runtime, data, name);
    mkdirSync(o.launchAgents, { recursive: true });
    writeFileSync(plistFile, plist(label, args, join(data, 'server.log'), o.env));
  }
  const used = readFileSync(plistFile, 'utf8');
  const domain = `gui/${o.uid}`;
  const loaded = (await o.run('launchctl', ['print', `${domain}/${label}`])) === 0;
  // A loaded service keeps the program it was loaded with: a new plist needs a new load.
  if (loaded && !kept) {
    await o.run('launchctl', ['bootout', `${domain}/${label}`]);
    await unloaded(o, `${domain}/${label}`);
  }
  if (!loaded || !kept) {
    const code = await o.run('launchctl', ['bootstrap', domain, plistFile]);
    if (code !== 0) {
      // The old server may still run: the plist keeps naming its program, so its copy stays.
      if (!kept && program && existsSync(unescape(program[1]!))) writeFileSync(plistFile, current!);
      throw new Error(`launchctl bootstrap ${label} failed (exit code ${code})`);
    }
  }
  // Only now the old server is gone: a copy it still runs from must stay (ADR 0036, point 1).
  if (existsSync(runtime)) {
    for (const version of readdirSync(runtime)) {
      if (version !== name && !used.includes(escape(join(runtime, version) + sep)))
        rmSync(join(runtime, version), { recursive: true, force: true });
    }
  }
  const version = new RegExp(`<string>${escapeRegExp(escape(runtime + sep))}([^/<]+)/`).exec(used);
  return {
    data,
    label,
    ...(version && { version: unescape(version[1]!) }),
    ...('app' in o.source && { ready: name }),
  };
}

/**
 * Waits until launchd no longer has the service: `bootout` returns while the old server still
 * ends (closing shells, at most launchd's ExitTimeOut of 20 s), and a `bootstrap` before that
 * fails with exit code 5. False when it is still there after 30 s.
 */
async function unloaded(o: Pick<LocalServerOptions, 'run'>, service: string): Promise<boolean> {
  const until = Date.now() + 30_000;
  while ((await o.run('launchctl', ['print', service])) === 0) {
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

/**
 * Folder of this app's runtime copy: its version and an id of its build, so a new build of the
 * same version is copied anew. The id hashes what a build changes: `Info.plist` (its
 * `ElectronAsarIntegrity` is the hash of `app.asar`, whose own stat lies inside Electron), server
 * and CLI next to the archive, the Electron version in the framework's `Info.plist`, and the
 * signature's `CodeResources` with the hashes of all resources if signed. A bundle without any of them (tests) has only its version.
 */
function copyName(o: LocalServerOptions): string {
  if (!('app' in o.source)) return o.version;
  const contents = join(o.source.app, 'Contents');
  const files = [
    'Info.plist',
    'Resources/server/hangar-server.mjs',
    'Resources/cli/hangar.mjs',
    'Frameworks/Electron Framework.framework/Resources/Info.plist',
    '_CodeSignature/CodeResources',
  ].filter((file) => existsSync(join(contents, file)));
  if (files.length === 0) return o.version;
  const hash = createHash('sha256');
  // The names count too, not where the app lies: a moved app is the same build.
  for (const file of files) hash.update(file).update(readFileSync(join(contents, file)));
  return `${o.version}+${hash.digest('hex').slice(0, 8)}`;
}

/** Program and arguments of the server; copies the packaged app first if needed. */
async function serverArgs(
  o: LocalServerOptions,
  runtime: string,
  data: string,
  name: string,
): Promise<string[]> {
  const options = (bays: string, cli: string) => [
    '--data',
    data,
    '--root',
    o.home,
    '--bays',
    bays,
    '--cli',
    cli,
  ];
  if (!('app' in o.source)) {
    const { execPath, server, bays, cli } = o.source;
    return [execPath, server, ...options(bays, cli)];
  }
  const bundle = basename(o.source.app);
  const target = join(runtime, name);
  if (!existsSync(join(target, bundle))) {
    // Copied next to it first: a half copy never looks like a finished one.
    rmSync(`${target}.tmp`, { recursive: true, force: true });
    mkdirSync(`${target}.tmp`, { recursive: true });
    // ditto keeps the bundle's signature, links and extended attributes.
    if ((await o.run('ditto', [o.source.app, join(`${target}.tmp`, bundle)])) !== 0)
      throw new Error(`Copying ${o.source.app} failed`);
    rmSync(target, { recursive: true, force: true });
    renameSync(`${target}.tmp`, target);
  }
  const contents = join(target, bundle, 'Contents');
  const resources = join(contents, 'Resources');
  return [
    join(contents, 'MacOS', o.source.executable),
    join(resources, 'server', 'hangar-server.mjs'),
    ...options(join(resources, 'app.asar', 'bays'), join(resources, 'cli', 'hangar.mjs')),
  ];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escape = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const unescape = (text: string) =>
  text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

function plist(
  label: string,
  args: string[],
  log: string,
  extra: Record<string, string> = {},
): string {
  const string = (s: string) => `<string>${escape(s)}</string>`;
  const env: Record<string, string> = { ...extra, ELECTRON_RUN_AS_NODE: '1' };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${string(label)}
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    ${string(a)}`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${k}</key>\n    ${string(v)}`)
  .join('\n')}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  ${string(log)}
  <key>StandardErrorPath</key>
  ${string(log)}
</dict>
</plist>
`;
}

/** Calls `pair` until it succeeds: the server may still be starting or rewriting its code. */
export async function pairWhenReady<T>(
  pair: () => Promise<T>,
  timeoutMs = 30_000,
  stepMs = 250,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await pair();
    } catch (e) {
      if (Date.now() + stepMs > until) throw e;
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }
}
