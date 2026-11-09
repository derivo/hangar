import { createPublicKey } from 'node:crypto';
import { execFile } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { app, BrowserWindow, ipcMain, nativeTheme, safeStorage } from 'electron';
import type { SettingValue } from '@hangar/sdk';
import { catalogFor } from '@hangar/sdk/i18n';
import {
  BayStore,
  baySetting,
  readSettings,
  startCore,
  themeSetting,
  uiLocale,
  writeSettings,
  workspaceAction,
  Workspaces,
  type Core,
} from '@hangar/host';
import { bayRoots, Host, pickFolder, userDataDir } from './host';
import {
  bayInLocalServer,
  ensureLocalServer,
  localServerWanted,
  migrateFromLocalServer,
  migrateToLocalServer,
  pairWhenReady,
  serverUiRoots,
} from './local-server';
import { dialogPrompter } from './prompter';
import { setLocale, t } from '../messages';
import { startUpdates } from './updates';

// Tests and parallel dev instances isolate all state through this variable.
const dataDir = userDataDir();
if (dataDir) app.setPath('userData', dataDir);
// E2E: safeStorage without the keychain, whose dialog would stop the tests (ADR 0030).
if (process.env.HANGAR_E2E) app.commandLine.appendSwitch('use-mock-keychain');
// E2E on macOS: no Dock icon and no activation, so tests never take the focus (see `offscreen` in host.ts).
if (process.env.HANGAR_E2E && !process.env.HANGAR_E2E_SHOW && process.platform === 'darwin') {
  app.setActivationPolicy('accessory');
}

let host: Host | undefined;
let core: Core | undefined;
let workspaces: Workspaces | undefined;

/** Private keys at rest: safeStorage, or plain (file mode 600) where the system has no keyring. */
const protect = {
  encrypt: (text: string) =>
    safeStorage.isEncryptionAvailable()
      ? `safe:${safeStorage.encryptString(text).toString('base64')}`
      : `plain:${text}`,
  decrypt: (text: string) =>
    text.startsWith('safe:')
      ? safeStorage.decryptString(Buffer.from(text.slice(5), 'base64'))
      : text.slice(6),
};

/** Host module `secrets` (ADR 0021): only with the keychain, never plain like `protect`. */
const secrets = {
  encrypt: (text: string) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error(t.noKeychain);
    return safeStorage.encryptString(text).toString('base64');
  },
  decrypt: (data: string) => safeStorage.decryptString(Buffer.from(data, 'base64')),
};

const AGENTS = 'dev.hangar.agents';
/** Bays the local server runs instead of the app (ADR 0036); the board with the agents (ADR 0037). */
const IN_SERVER = [AGENTS, 'dev.hangar.board'];

/** Runs a command and returns its exit code. */
const run = (cmd: string, args: string[]) =>
  new Promise<number>((done) =>
    execFile(cmd, args, (e) => done(e ? (typeof e.code === 'number' ? e.code : 1) : 0)),
  );

const launchAgentsDir = () =>
  process.env.HANGAR_LAUNCH_AGENTS ?? join(homedir(), 'Library', 'LaunchAgents');

/** The build the local server runs and the build of this app, for the hint of a new version
 * (ADR 0036). */
let localServerVersion: string | undefined;
let localServerReady: string | undefined;

/** Starts the local server as a LaunchAgent if needed and pairs with it (ADR 0036);
 * `restart` replaces a running one, also with this app's version. */
async function startLocalServer(userData: string, cliPath: string, restart = false): Promise<void> {
  const dev = {
    execPath: process.execPath,
    server: join(app.getAppPath(), '../server/dist/hangar-server.mjs'),
    bays: String(bayRoots()[0]),
    cli: cliPath,
  };
  const { data, version, ready } = await ensureLocalServer(
    {
      userData,
      version: app.getVersion(),
      // E2E: the temporary repositories lie outside the home folder.
      home: process.env.HANGAR_LOCAL_SERVER_ROOT ?? homedir(),
      launchAgents: launchAgentsDir(),
      uid: process.getuid!(),
      env: Object.fromEntries(
        // E2E: the predictable shell and home of the test, its temporary folder too.
        (process.env.HANGAR_E2E ? ['PATH', 'SHELL', 'HOME', 'TMPDIR'] : ['PATH'])
          .filter((k) => process.env[k])
          .map((k) => [k, process.env[k]!]),
      ),
      // The executable is <Hangar.app>/Contents/MacOS/Hangar.
      source: app.isPackaged
        ? { app: resolve(process.execPath, '../../..'), executable: basename(process.execPath) }
        : dev,
      run,
    },
    restart,
  );
  localServerVersion = version;
  localServerReady = ready;
  await pairWhenReady(() => host!.pairLocalServer(data));
}

async function start(): Promise<void> {
  const userData = app.getPath('userData');
  const settingsFile = join(userData, 'settings.json');
  // ADR 0036: the agent bay runs only in the local server; its data moves there, or back,
  // before permissions and jobs are loaded below.
  let localServer = localServerWanted({
    platform: process.platform,
    packaged: app.isPackaged,
    setting: readSettings(settingsFile).localServer,
    env: process.env.HANGAR_LOCAL_SERVER,
  });
  if (localServer) {
    // Not moved: this run keeps the agent bay where its data lies; the next start tries again.
    localServer = await migrateToLocalServer(
      // The server has no keychain: its relay keys lie in a file with mode 600 (point 11).
      { userData, uid: process.getuid!(), run, keys: (k) => `plain:${protect.decrypt(k)}` },
      IN_SERVER,
    ).then(
      () => true,
      // A move that broke off after the bay's data went over: it runs there (Codex, step 5).
      (e: Error) => (
        console.error(`Local server: ${e.message}`),
        bayInLocalServer(userData, AGENTS)
      ),
    );
  } else if (process.platform === 'darwin') {
    // Broken off: the bay runs where its data lies this run; the next start finishes the way.
    localServer = await migrateFromLocalServer(
      {
        userData,
        uid: process.getuid!(),
        run,
        launchAgents: launchAgentsDir(),
        keys: (k) => protect.encrypt(protect.decrypt(k)),
      },
      IN_SERVER,
    ).then(
      () => false,
      (e: Error) => (
        console.error(`Local server: ${e.message}`),
        bayInLocalServer(userData, AGENTS)
      ),
    );
  }
  // Fixed for the whole run: bays, dialogs and the tray read it once.
  const locale = uiLocale(
    readSettings(settingsFile),
    process.env.HANGAR_LOCALE,
    app.getPreferredSystemLanguages(),
  );
  setLocale(locale);
  // Drives prefers-color-scheme in the shell and every bay view.
  nativeTheme.themeSource = readSettings(settingsFile).theme;
  ipcMain.on('hangar:locale', (event) => (event.returnValue = locale));
  const cliPath = app.isPackaged
    ? join(process.resourcesPath, 'cli', 'hangar.mjs')
    : join(app.getAppPath(), '../../packages/cli/dist/hangar.mjs');
  core = await startCore({
    dataDir: userData,
    version: app.getVersion(),
    prompter: dialogPrompter,
    cli: { execPath: process.execPath, cliPath },
    onJobsChanged: () => host?.jobsChanged(),
    remote: {
      isMember: (w, i) => workspaces?.isMember(w, i) ?? false,
      isShared: (w, t) => workspaces?.isShared(w, t) ?? false,
    },
  });
  // With the local server, its agent bay holds the workspaces (ADR 0036, point 11).
  const ws = localServer
    ? undefined
    : new Workspaces({
        dir: join(userData, 'workspaces'),
        name: hostname(),
        bus: core.bus,
        protect,
        onChange: () => host?.workspacesChanged(),
      });
  workspaces = ws;
  // Installed bays (ADR 0034). ponytail: index and key from the environment until Hangar
  // has a built-in key and a published index (phase 21).
  const indexUrl = process.env.HANGAR_BAY_INDEX;
  const indexKey = process.env.HANGAR_BAY_INDEX_KEY;
  const store = new BayStore({
    dir: join(userData, 'packages'),
    dataRoot: core.services.dataRoot,
    ...(indexUrl &&
      indexKey && {
        index: {
          url: indexUrl,
          publicKey: createPublicKey({
            key: { kty: 'OKP', crv: 'Ed25519', x: indexKey },
            format: 'jwk',
          }),
        },
      }),
    hangarVersion: app.getVersion(),
    current: (id) => host?.runtimes.get(id)?.bay.manifest,
  });
  // Before the bays load: a function that became sensitive asks again.
  store.applyPending((target) => {
    for (const g of core!.bus.grants()) {
      if (g.target === target && g.mode === 'allow' && !g.sessionId)
        core!.bus.revoke(g.subject, target);
    }
  });
  host = new Host(
    {
      ...core.services,
      locale,
      // The focused window, else the main one: never a free dialog behind Hangar.
      pickFolder: (options) =>
        pickFolder(options, BrowserWindow.getFocusedWindow() ?? host?.window),
      baySettings: (bayId) => readSettings(settingsFile).baySettings[bayId] ?? {},
      ...(ws && { workspaces: (bayId: string) => ws.forBay(bayId) }),
      secrets,
    },
    core.bus,
    join(userData, 'view.json'),
    {
      get: () => readSettings(settingsFile).bays,
      set: (bays) => writeSettings(settingsFile, { ...readSettings(settingsFile), bays }),
    },
    {
      get: () => readSettings(settingsFile).shortcuts,
      set: (shortcuts) => writeSettings(settingsFile, { ...readSettings(settingsFile), shortcuts }),
    },
    join(userData, 'servers.json'),
    process.env.HANGAR_SSH ?? 'ssh',
    () => store.bayDirs(),
    localServer
      ? {
          owns: IN_SERVER,
          uiRoots: () => serverUiRoots(userData),
          version: () => localServerVersion,
          ready: () => localServerReady,
          restart: () => startLocalServer(userData, cliPath, true),
          log: join(userData, 'local-server', 'data', 'server.log'),
        }
      : undefined,
  );
  await host.start();
  if (localServer) {
    void startLocalServer(userData, cliPath).catch((e: Error) =>
      console.error(`Local server: ${e.message}`),
    );
  }
  core.scheduler.start();
  void ws?.start();

  // Workspaces (ADR 0030): thin wrappers, the checks are in `Workspaces` and on the relay; with
  // the local server they run there (ADR 0036, point 11).
  const workspace = (action: string, args: unknown[]) =>
    ws
      ? workspaceAction(ws, core!.bus, action, args)
      : host!.localWorkspaces(
          action,
          args.map((a) => (typeof a === 'boolean' ? a : String(a))),
        );
  const str = (v: unknown) => String(v);
  ipcMain.handle('shell:workspaces', () => workspace('view', []));
  ipcMain.handle('shell:workspace.connect', (_e, ...args: unknown[]) => workspace('connect', args));
  ipcMain.handle('shell:workspace.create', (_e, ...args: unknown[]) => workspace('create', args));
  ipcMain.handle('shell:workspace.invite', (_e, ...args: unknown[]) => workspace('invite', args));
  ipcMain.handle('shell:workspace.join', (_e, ...args: unknown[]) => workspace('join', args));
  ipcMain.handle('shell:workspace.accept', (_e, ...args: unknown[]) => workspace('accept', args));
  ipcMain.handle('shell:workspace.reject', (_e, ...args: unknown[]) => workspace('reject', args));
  ipcMain.handle('shell:workspace.remove', (_e, ...args: unknown[]) => workspace('remove', args));
  ipcMain.handle('shell:workspace.share', (_e, ...args: unknown[]) => workspace('share', args));

  ipcMain.handle('shell:bay.catalog', () =>
    indexUrl && indexKey ? store.catalog(readSettings(settingsFile).updateChannel) : null,
  );
  ipcMain.handle('shell:bay.prepare', async (_e, id: unknown, version: unknown) => {
    const p = await store.prepare(str(id), str(version), readSettings(settingsFile).updateChannel);
    const { token, diff, dataVersionChanged } = p;
    return { token, id: p.id, version: p.version, name: p.manifest.name, diff, dataVersionChanged };
  });
  ipcMain.handle('shell:bay.confirm', (_e, token: unknown) => {
    const id = store.confirm(str(token));
    // Only sidebar bays run (ADR 0017): a newly installed one goes there.
    const settings = readSettings(settingsFile);
    if (!settings.bays.includes(id))
      writeSettings(settingsFile, { ...settings, bays: [...settings.bays, id] });
  });
  ipcMain.handle('shell:bay.cancel', (_e, token: unknown) => store.cancel(str(token)));
  ipcMain.handle('shell:bay.rollback', (_e, id: unknown) => store.rollback(str(id)));

  ipcMain.handle('shell:settings', () => readSettings(settingsFile));
  // The switch of the local server (ADR 0036, step 4b): applies at the next start.
  ipcMain.handle('shell:localServer.setting', () =>
    process.platform === 'darwin'
      ? {
          active: localServer,
          enabled: localServerWanted({
            platform: process.platform,
            packaged: app.isPackaged,
            setting: readSettings(settingsFile).localServer,
            env: process.env.HANGAR_LOCAL_SERVER,
          }),
          forced: ['0', '1'].includes(process.env.HANGAR_LOCAL_SERVER ?? ''),
        }
      : null,
  );
  ipcMain.handle('shell:localServer.enable', (_e, enabled: unknown) => {
    writeSettings(settingsFile, { ...readSettings(settingsFile), localServer: enabled === true });
  });
  ipcMain.on('shell:relaunch', () => {
    app.relaunch();
    app.quit();
  });
  ipcMain.handle('shell:updateChannel', (_e, channel: unknown) => {
    const updateChannel = channel === 'beta' ? 'beta' : 'stable';
    writeSettings(settingsFile, { ...readSettings(settingsFile), updateChannel });
    startUpdates(updateChannel);
  });
  ipcMain.handle('shell:language', (_e, language: unknown) => {
    const valid = language === 'de' || language === 'en' ? language : 'system';
    writeSettings(settingsFile, { ...readSettings(settingsFile), language: valid });
  });
  ipcMain.handle('shell:theme', (_e, theme: unknown) => {
    const valid = themeSetting(theme);
    writeSettings(settingsFile, { ...readSettings(settingsFile), theme: valid });
    nativeTheme.themeSource = valid;
  });
  // Bay settings (ADR 0023, 0025): only running bays, only declared keys of the declared type.
  const text = (t: { de: string; en: string }) =>
    catalogFor({ de: { t: t.de }, en: { t: t.en } }, locale).t;
  ipcMain.handle('shell:baySettings', () => {
    const stored = readSettings(settingsFile).baySettings;
    return [...host!.runtimes.values()]
      .filter((r) => r.bay.manifest.settings?.length)
      .map(({ id, bay: { manifest } }) => ({
        bayId: id,
        name: manifest.name,
        settings: manifest.settings!.map((s) => ({
          key: s.key,
          label: text(s.label),
          ...(s.description && { description: text(s.description) }),
          value: baySetting(stored[id], manifest.settings, s.key),
        })),
      }));
  });
  ipcMain.handle('shell:baySetting', (_e, bayId: unknown, key: unknown, value: unknown) => {
    const runtime = host!.runtimes.get(bayId as string);
    const declared = runtime?.bay.manifest.settings?.find((s) => s.key === key);
    if (!runtime || !declared || typeof value !== typeof declared.default) return;
    const settings = readSettings(settingsFile);
    const id = runtime.id;
    settings.baySettings[id] = {
      ...settings.baySettings[id],
      [key as string]: value as SettingValue,
    };
    writeSettings(settingsFile, settings);
    runtime.settingChanged(key as string);
  });
  startUpdates(readSettings(settingsFile).updateChannel);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => host?.show());
  app.on('activate', () => host?.show());
  void app.whenReady().then(start);

  let stopping = false;
  app.on('before-quit', (event) => {
    if (stopping || !host) return;
    stopping = true;
    host.quitting = true;
    event.preventDefault();
    void host
      .stop()
      .then(() => {
        workspaces?.close();
        return core?.close();
      })
      .finally(() => app.quit());
  });
}
