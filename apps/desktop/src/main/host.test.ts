import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Shortcut } from '@hangar/host';

// Electron is faked; the bay runtimes are real and load small bays from a temporary folder.

let nextId = 1;
class FakeContents extends EventEmitter {
  id = nextId++;
  send = vi.fn();
  insertCSS = vi.fn(async () => '');
  loadFile = vi.fn(async (_file: string, _options?: unknown) => undefined);
  close = vi.fn();
  openHandler?: (details: { url: string }) => { action: string };
  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) {
    this.openHandler = handler;
  }
  getZoomFactor = () => 1;
  // As a browser tab.
  loadURL = vi.fn(async () => undefined);
  getURL = () => 'about:blank';
  getTitle = () => '';
  isLoading = () => false;
  navigationHistory = { canGoBack: () => false, canGoForward: () => false };
}

class FakeView {
  static all: FakeView[] = [];
  webContents = new FakeContents();
  visible = true;
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  constructor(public options: { webPreferences: { partition?: string } }) {
    FakeView.all.push(this);
  }
  setVisible(visible: boolean) {
    this.visible = visible;
  }
  setBounds(bounds: typeof this.bounds) {
    this.bounds = bounds;
  }
  getBounds() {
    return this.bounds;
  }
}

class FakeWindow extends EventEmitter {
  static all: FakeWindow[] = [];
  webContents = new FakeContents();
  children: unknown[] = [];
  contentView = {
    addChildView: (view: unknown) => {
      this.children = [...this.children.filter((v) => v !== view), view];
    },
    removeChildView: (view: unknown) => {
      this.children = this.children.filter((v) => v !== view);
    },
  };
  destroyed = false;
  shown = true;
  minimized = false;
  maximized = false;
  focus = vi.fn();
  restore = vi.fn();
  loadURL = vi.fn(async () => undefined);
  loadFile = vi.fn(async () => undefined);
  constructor(public options: Record<string, unknown>) {
    super();
    FakeWindow.all.push(this);
  }
  isDestroyed = () => this.destroyed;
  destroy() {
    this.destroyed = true;
    this.emit('closed');
  }
  close() {
    const event = { prevented: false, preventDefault: () => (event.prevented = true) };
    this.emit('close', event);
    if (!event.prevented) this.destroy();
  }
  hide() {
    this.shown = false;
  }
  show() {
    this.shown = true;
  }
  showInactive() {
    this.shown = true;
  }
  setIgnoreMouseEvents = vi.fn();
  maximize() {
    this.maximized = true;
  }
  isMaximized = () => this.maximized;
  isMinimized = () => this.minimized;
  getNormalBounds = () => ({ x: 10, y: 20, width: 1100, height: 700 });
  getContentSize = () => [1000, 700];
}

const ipc = {
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
};
/** Calls an `ipcMain.handle` channel as `sender` would. */
const invoke = async (channel: string, sender: unknown, ...args: unknown[]) =>
  ipc.handlers.get(channel)!({ sender }, ...args);
/** Sends on an `ipcMain.on` channel; returns what a synchronous answer would be. */
const send = (channel: string, sender: unknown, ...args: unknown[]) => {
  const event = { sender, returnValue: undefined as unknown };
  ipc.listeners.get(channel)!(event, ...args);
  return event.returnValue;
};

type MenuItem = { label?: string; type?: string; enabled?: boolean; click?: () => void };
const menus: MenuItem[][] = [];
const clickMenu = (label: string) => menus.at(-1)!.find((i) => i.label === label)!.click!();

class FakeNotification extends EventEmitter {
  static supported = true;
  static all: FakeNotification[] = [];
  static isSupported = () => FakeNotification.supported;
  show = vi.fn();
  constructor(public options: { title: string; body: string }) {
    super();
    FakeNotification.all.push(this);
  }
}

class FakeTray extends EventEmitter {
  static last?: FakeTray;
  menu?: MenuItem[];
  setToolTip = vi.fn();
  menus = 0;
  setContextMenu(menu: { items: MenuItem[] }) {
    this.menu = menu.items;
    this.menus++;
  }
  constructor() {
    super();
    FakeTray.last = this;
  }
}

const electron = {
  app: {
    isPackaged: false,
    getAppPath: () => '/app/apps/desktop',
    getPath: (name: string) => `/home/${name}`,
    setBadgeCount: vi.fn(),
    getFileIcon: vi.fn(async () => ({ toDataURL: () => 'data:file-icon' })),
    quit: vi.fn(),
  },
  BrowserWindow: FakeWindow,
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
    showMessageBox: vi.fn(async () => ({ response: 0 })),
  },
  ipcMain: {
    handle: (channel: string, handler: (e: unknown, ...a: unknown[]) => unknown) =>
      ipc.handlers.set(channel, handler),
    on: (channel: string, handler: (e: unknown, ...a: unknown[]) => void) =>
      ipc.listeners.set(channel, handler),
  },
  Menu: {
    buildFromTemplate: (items: MenuItem[]) => {
      menus.push(items);
      return { items, popup: vi.fn() };
    },
  },
  nativeImage: {
    createFromPath: vi.fn(() => ({})),
    createThumbnailFromPath: vi.fn(async (path: string) => {
      if (path.includes('gone')) throw new Error('not found');
      return { toDataURL: () => `data:thumb:${path}` };
    }),
  },
  Notification: FakeNotification,
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
    }),
  },
  screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] },
  shell: {
    openExternal: vi.fn(async (_url: string) => undefined),
    openPath: vi.fn(async (_path: string) => ''),
  },
  Tray: FakeTray,
  WebContentsView: FakeView,
};
vi.mock('electron', () => electron);

/** Paired servers as the host sees them; `events` are the callbacks the host gave. */
class FakeConnections {
  static last: FakeConnections;
  servers: {
    id: string;
    name: string;
    status: string;
    error?: string;
    bays: { id: string; version: string }[];
    badges: Record<string, number>;
    local?: true;
    sessions?: number;
    retry?: number;
  }[] = [];
  list = () => this.servers;
  connectAll = vi.fn(async () => undefined);
  connect = vi.fn(async (_id: string) => undefined);
  disconnect = vi.fn();
  remove = vi.fn();
  probe = vi.fn(async (_address: string) => ({ id: 'probe', fingerprint: 'SHA256:x' }));
  pair = vi.fn(async (..._args: string[]) => 'srv');
  pairLocal = vi.fn(async (..._args: string[]) => 'local');
  pairSetUp = vi.fn(async (..._args: unknown[]) => 'machine');
  cancel = vi.fn();
  invoke = vi.fn(async (..._args: unknown[]) => 'from server');
  jobs = vi.fn(async (_id: string): Promise<unknown[]> => []);
  job = vi.fn(async (..._args: string[]) => undefined);
  workspaces = vi.fn(async (..._args: unknown[]): Promise<unknown> => 'from server');
  closeAll = vi.fn();
  offerAgain = vi.fn();
  constructor(
    public file: string,
    public me: { name: string; locale: string },
    public events: {
      changed(): void;
      event(server: string, bay: string, channel: string, payload: unknown): void;
      ask(server: string, request: unknown, signal: AbortSignal): Promise<unknown>;
      notify(server: string, bay: string, n: { title: string; body?: string }): void;
      jobs(): void;
      local?: {
        functions(): unknown[];
        call(
          target: string,
          args: unknown,
          caller: unknown,
          signal?: AbortSignal,
        ): Promise<unknown>;
        sessionEnded(bayId: string, sessionId: string): void;
        workspaces(): void;
      };
    },
    public ssh: string,
  ) {
    FakeConnections.last = this;
  }
}
const bridgeSetup = {
  linuxPackages: vi.fn(async (dir: string, version: string) => [{ dir, version }]),
  sshRemote: vi.fn((target: unknown, ssh: string) => ({ target, ssh })),
  setUpServer: vi.fn(async (..._args: unknown[]) => ({ linger: false, user: 'anna', port: 1 })),
};
vi.mock('@hangar/bridge', async (importOriginal) => {
  const { parseSetupAddress } = await importOriginal<typeof import('@hangar/bridge')>();
  return { ServerConnections: FakeConnections, parseSetupAddress, ...bridgeSetup };
});
vi.mock('./overview', () => ({ gitIdentity: async () => ({ name: 'Anna', email: 'a@x' }) }));
const askWithDialog = vi.fn(async () => 'deny');
vi.mock('./prompter', () => ({ askWithDialog }));

const { Host, bayRoots, pickFolder, userDataDir } = await import('./host');
const { UPDATE_HINT_HEIGHT } = await import('../shared');

/** What the test bays report: starts, stops and a gate per bay that holds its start. */
interface BayLog {
  started: string[];
  stopped: string[];
  gates: Map<string, Promise<void>>;
  failStart: Set<string>;
  failStop: Set<string>;
  contexts: Map<string, import('@hangar/sdk').BayContext>;
}
declare global {
  var __bays: BayLog;
}

const MAIN = `
let id;
export default {
  async activate(ctx) {
    id = ctx.bayId;
    const log = globalThis.__bays;
    log.started.push(id);
    await log.gates.get(id);
    if (log.failStart.has(id)) throw new Error('boom');
    ctx.ui.handle('echo', (x) => 'echo ' + x);
    log.contexts.set(id, ctx);
  },
  deactivate() {
    globalThis.__bays.stopped.push(id);
    if (globalThis.__bays.failStop.has(id)) throw new Error('stop failed');
  },
};`;

function writeBay(root: string, id: string, name: string, extra: Record<string, unknown> = {}) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      id,
      name,
      version: '0.1.0',
      minHangarVersion: '0.1.0',
      icon: 'icon.svg',
      ui: 'index.html',
      main: 'main.mjs',
      functions: [],
      ...extra,
    }),
  );
  writeFileSync(join(dir, 'icon.svg'), '<svg/>');
  writeFileSync(join(dir, 'index.html'), '<p>bay</p>');
  writeFileSync(join(dir, 'main.mjs'), MAIN);
  return dir;
}

/** Holds the start of bay `id` until `release`. */
function hold(id: string) {
  let release!: () => void;
  globalThis.__bays.gates.set(id, new Promise<void>((r) => (release = r)));
  return { release };
}

interface Options {
  sidebar?: string[];
  shortcuts?: Shortcut[];
  view?: Record<string, unknown>;
  localServer?: ConstructorParameters<typeof Host>[8];
}

/** A host over three test bays (A, B with browser module, C); not started yet. */
function setup({ sidebar = ['dev.test.a'], shortcuts = [], view, localServer }: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hangar-host-'));
  const bays = join(root, 'bays');
  writeBay(bays, 'dev.test.a', 'Alpha');
  writeBay(bays, 'dev.test.b', 'Beta', { hostModules: ['browser'] });
  writeBay(bays, 'dev.test.c', 'Gamma', { uses: ['dev.test.a/echo'] });
  // A folder with a broken manifest shows as an error in the sidebar.
  mkdirSync(join(bays, 'broken'));
  writeFileSync(join(bays, 'broken', 'manifest.json'), '{"name":"Kaputt"}');
  mkdirSync(join(bays, 'nameless'));
  writeFileSync(join(bays, 'nameless', 'manifest.json'), 'not json');
  process.env.HANGAR_BAYS_DIR = bays;
  const viewFile = join(root, 'view.json');
  if (view) writeFileSync(viewFile, JSON.stringify(view));
  const store = { sidebar: [...sidebar], shortcuts: [...shortcuts] };
  const bus = {
    unregisterBay: vi.fn(),
    list: () => [
      { id: 'dev.test.a/echo', bayId: 'dev.test.a', spec: { sensitive: false } },
      {
        id: 'dev.test.a/secret',
        bayId: 'dev.test.a',
        spec: { sensitive: true, description: 'Geheim' },
      },
    ],
    grants: () => [
      { subject: 'dev.test.a', target: 'dev.test.a/echo', mode: 'allow', sessionId: 's1' },
      { subject: 'dev.test.c', target: 'dev.test.a/echo', mode: 'deny' },
    ],
    revoke: vi.fn(),
    setMode: vi.fn(),
    call: vi.fn(async () => 'done'),
    endSession: vi.fn(),
  };
  const scheduler = {
    list: vi.fn(() => [{ id: 'j1' }]),
    setPaused: vi.fn(),
    runNow: vi.fn(async () => ({ ok: true })),
    remove: vi.fn(),
    handle: vi.fn(),
    unhandle: vi.fn(),
  };
  const services = {
    dataRoot: join(root, 'data'),
    hangarVersion: '0.1.0',
    locale: 'de' as const,
    pickFolder: vi.fn(async () => undefined),
    provide: vi.fn(),
    call: vi.fn(),
    registerAgentSession: vi.fn(() => ({ token: 't', mcpUrl: 'u', cliDir: 'c' })),
    unregisterAgentSession: vi.fn(),
    scheduler: scheduler as never,
    baySettings: () => ({}),
  };
  const host = new Host(
    services,
    bus as never,
    viewFile,
    { get: () => store.sidebar, set: (ids) => (store.sidebar = ids) },
    { get: () => store.shortcuts, set: (list) => (store.shortcuts = list) },
    join(root, 'servers.json'),
    'my-ssh',
    undefined,
    localServer,
  );
  const servers = FakeConnections.last;
  /** The view of a bay or server bay by its key. */
  const viewOf = (key: string) =>
    FakeView.all.find((v) => v.options.webPreferences.partition === `persist:bay:${key}`);
  const window = () => FakeWindow.all[0]!;
  const shellState = () =>
    window()
      .webContents.send.mock.calls.filter(([c]) => c === 'shell:state')
      .at(-1)?.[1] as ReturnType<typeof host.state>;
  return {
    host,
    store,
    bus,
    scheduler,
    services,
    servers,
    viewFile,
    viewOf,
    window,
    shellState,
  };
}

async function started(options?: Options) {
  const h = setup(options);
  await h.host.start();
  // The tray menu is built on start; tests look at the menus built after.
  menus.length = 0;
  return h;
}

beforeEach(() => {
  globalThis.__bays = {
    started: [],
    stopped: [],
    gates: new Map(),
    failStart: new Set(),
    failStop: new Set(),
    contexts: new Map(),
  };
  FakeView.all = [];
  FakeWindow.all = [];
  FakeNotification.all = [];
  FakeNotification.supported = true;
  menus.length = 0;
  ipc.handlers.clear();
  ipc.listeners.clear();
  vi.clearAllMocks();
  delete process.env.HANGAR_E2E;
  delete process.env.HANGAR_E2E_SHOW;
  delete process.env.ELECTRON_RENDERER_URL;
});

afterEach(() => {
  delete process.env.HANGAR_BAYS_DIR;
});

describe('bayRoots and pickFolder', () => {
  it('takes the bay folders from HANGAR_BAYS_DIR, else next to the app', () => {
    process.env.HANGAR_BAYS_DIR = ['/a', '/b'].join(delimiter);
    expect(bayRoots()).toEqual(['/a', '/b']);
    delete process.env.HANGAR_BAYS_DIR;
    expect(bayRoots()).toEqual([join('/app/apps/desktop', '../../bays')]);
    electron.app.isPackaged = true;
    try {
      expect(bayRoots()).toEqual([join('/app/apps/desktop', 'bays')]);
    } finally {
      electron.app.isPackaged = false;
    }
  });

  it('puts installed bays before the bundled ones, but after a development folder (ADR 0034)', () => {
    const installed = [{ bay: '/data/packages/dev.hangar.notes/1.0.0' }];
    expect(bayRoots(installed)).toEqual([...installed, join('/app/apps/desktop', '../../bays')]);
    process.env.HANGAR_BAYS_DIR = '/dev-bays';
    expect(bayRoots(installed)).toEqual(['/dev-bays', ...installed]);
  });

  it('keeps development apart from the profile in daily use', () => {
    expect(userDataDir()).toBe(join('/home/appData', 'Hangar Dev'));
    process.env.HANGAR_USER_DATA = '/tmp/e2e';
    expect(userDataDir()).toBe('/tmp/e2e');
    delete process.env.HANGAR_USER_DATA;
    electron.app.isPackaged = true;
    try {
      expect(userDataDir()).toBeUndefined();
    } finally {
      electron.app.isPackaged = false;
    }
  });

  it('picks a folder or answers nothing when cancelled', async () => {
    electron.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/p'] });
    await expect(pickFolder({ title: 'Projekt' })).resolves.toBe('/p');
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith({
      title: 'Projekt',
      properties: ['openDirectory', 'createDirectory'],
    });
    await expect(pickFolder()).resolves.toBeUndefined();
  });

  it('attaches the folder picker to the window it is given, so it opens in front', async () => {
    const parent = {} as Electron.BrowserWindow;
    await pickFolder({ title: 'Projekt' }, parent);
    expect(electron.dialog.showOpenDialog).toHaveBeenLastCalledWith(parent, {
      title: 'Projekt',
      properties: ['openDirectory', 'createDirectory'],
    });
  });
});

describe('Host: start', () => {
  it('starts the bays of the sidebar, skips missing ones and opens window and tray', async () => {
    const { host, window, viewOf, servers } = await started({
      sidebar: ['dev.test.a', 'dev.test.gone', 'dev.test.c'],
    });
    expect(globalThis.__bays.started).toEqual(['dev.test.a', 'dev.test.c']);
    expect([...host.runtimes.keys()]).toEqual(['dev.test.a', 'dev.test.c']);
    // macOS: the click that activates the window also reaches the page (terminal focus).
    expect(window().options).toMatchObject({
      width: 1280,
      height: 820,
      title: 'Hangar',
      acceptFirstMouse: true,
    });
    expect(window().loadFile).toHaveBeenCalledWith(
      expect.stringMatching(/renderer[/\\]index\.html$/),
    );
    expect(viewOf('dev.test.a')).toBeDefined();
    expect(viewOf('dev.test.b')).toBeUndefined();
    expect(servers.connectAll).toHaveBeenCalled();
    expect(servers.me.locale).toBe('de');
    expect(servers.ssh).toBe('my-ssh');
    expect(FakeTray.last!.setToolTip).toHaveBeenCalledWith('Hangar');
  });

  it('loads the dev server URL when there is one', async () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173';
    const { window } = await started();
    expect(window().loadURL).toHaveBeenCalledWith('http://localhost:5173');
    expect(window().loadFile).not.toHaveBeenCalled();
  });

  it('names a bay whose start failed and released what it started', async () => {
    globalThis.__bays.failStart.add('dev.test.a');
    const { host, bus } = await started();
    expect(host.runtimes.size).toBe(0);
    expect(globalThis.__bays.stopped).toEqual(['dev.test.a']);
    expect(bus.unregisterBay).toHaveBeenCalledWith('dev.test.a');
    expect(host.state().errors).toContainEqual({
      label: 'Alpha',
      error: 'Start failed: boom',
    });
  });

  it('names bays whose manifest is broken', async () => {
    const { host } = await started();
    const labels = host.state().errors.map((e) => e.label);
    expect(labels).toContain('Kaputt');
    // Without a name, the folder names it.
    expect(labels).toContainEqual(expect.stringMatching(/nameless$/));
  });

  it.each([
    ['dev.test.a', 'dev.test.a'],
    ['settings', 'settings'],
    ['dev.test.c', 'overview'],
    [null, 'overview'],
  ])('selects %j again after a restart as %j', async (selected, expected) => {
    const { host } = await started({ view: { selected, windows: [] } });
    expect(host.state().selected).toBe(expected);
  });

  it('restores bounds, maximized state and the windows of running bays', async () => {
    const { window } = await started({
      view: {
        bounds: { x: 100, y: 100, width: 900, height: 600 },
        maximized: true,
        selected: 'dev.test.a',
        windows: [
          { bay: 'dev.test.a', key: 'session:1', title: 'Eins' },
          { bay: 'dev.test.c', key: 'session:2', title: 'Zwei' },
        ],
      },
    });
    expect(window().options).toMatchObject({ x: 100, y: 100, width: 900, height: 600 });
    expect(window().maximized).toBe(true);
    expect(FakeWindow.all).toHaveLength(2);
    expect(FakeWindow.all[1]!.options).toMatchObject({
      title: 'Eins',
      width: 960,
      height: 640,
      acceptFirstMouse: true,
    });
  });

  it('shows only the selected bay, beside the sidebar, and none while a modal is open', async () => {
    const { host, viewOf, window } = await started({ sidebar: ['dev.test.a', 'dev.test.c'] });
    host.select('dev.test.c');
    expect(viewOf('dev.test.a')!.visible).toBe(false);
    expect(viewOf('dev.test.c')!.visible).toBe(true);
    expect(viewOf('dev.test.c')!.bounds).toEqual({ x: 64, y: 0, width: 936, height: 700 });
    send('shell:modal', window().webContents, true);
    expect(viewOf('dev.test.c')!.visible).toBe(false);
    send('shell:modal', window().webContents, 'yes');
    expect(viewOf('dev.test.c')!.visible).toBe(true);
    window().emit('resize');
    expect(viewOf('dev.test.c')!.visible).toBe(true);
  });

  it('keeps its windows off the screen and out of the focus under HANGAR_E2E', async () => {
    process.env.HANGAR_E2E = '1';
    const { host, window } = await started({
      view: { maximized: true, windows: [{ bay: 'dev.test.a', key: 'session:1', title: 'Eins' }] },
    });
    const bay = FakeWindow.all[1]!;
    for (const win of [window(), bay]) {
      // Shown anyway (maximize, the click on a notification), they stay invisible and let clicks through.
      expect(win.options).toMatchObject({
        show: false,
        opacity: 0,
        webPreferences: { backgroundThrottling: false },
      });
      expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    }
    window().hide();
    host.show();
    expect(window().shown).toBe(true);
    expect(window().focus).not.toHaveBeenCalled();
  });

  it('shows its windows under HANGAR_E2E when HANGAR_E2E_SHOW is set', async () => {
    process.env.HANGAR_E2E = '1';
    process.env.HANGAR_E2E_SHOW = '1';
    const { host, window } = await started();
    expect(window().options).toMatchObject({ show: true, opacity: 1 });
    expect(window().setIgnoreMouseEvents).not.toHaveBeenCalled();
    host.show();
    expect(window().focus).toHaveBeenCalled();
  });

  it('hides the window on close until Hangar quits', async () => {
    const { host, window } = await started();
    window().close();
    expect(window().destroyed).toBe(false);
    expect(window().shown).toBe(false);
    host.quitting = true;
    window().close();
    expect(window().destroyed).toBe(true);
  });

  it('brings the window to the front from the tray, restoring it when minimized', async () => {
    const { window } = await started();
    window().hide();
    window().minimized = true;
    FakeTray.last!.emit('click');
    expect(window().restore).toHaveBeenCalled();
    expect(window().shown).toBe(true);
    expect(window().focus).toHaveBeenCalled();
    expect(FakeTray.last!.menu!.map((i) => i.label ?? i.type)).toEqual([
      'Öffnen',
      'separator',
      'Beenden',
    ]);
    FakeTray.last!.menu!.find((i) => i.label === 'Beenden')!.click!();
    expect(electron.app.quit).toHaveBeenCalled();
  });
});

describe('Host: adding and removing bays', () => {
  it('starts a found bay once, appends it to the sidebar and selects it', async () => {
    const { host, store, viewOf } = await started();
    await host.addBay('dev.test.c');
    expect(store.sidebar).toEqual(['dev.test.a', 'dev.test.c']);
    expect(host.state().selected).toBe('dev.test.c');
    expect(viewOf('dev.test.c')!.visible).toBe(true);
    expect(host.state().available.map((b) => b.id)).toEqual(['dev.test.b']);
    // Adding a running bay only selects it.
    host.select('overview');
    await host.addBay('dev.test.c');
    expect(globalThis.__bays.started.filter((id) => id === 'dev.test.c')).toHaveLength(1);
    expect(host.state().selected).toBe('dev.test.c');
  });

  it('starts a bay once when it is added again during its start', async () => {
    const { host } = await started();
    const gate = hold('dev.test.c');
    const adds = [host.addBay('dev.test.c'), host.addBay('dev.test.c'), host.addBay('dev.test.c')];
    gate.release();
    await Promise.all(adds);
    expect(globalThis.__bays.started.filter((id) => id === 'dev.test.c')).toHaveLength(1);
  });

  it('refuses an unknown bay and a bay id that is not a string', async () => {
    const { host, window } = await started();
    await expect(host.addBay('dev.test.nope')).rejects.toThrow('Unknown bay "dev.test.nope"');
    await expect(invoke('shell:addBay', window().webContents, 42)).rejects.toThrow('Invalid bay');
  });

  it('can add a bay again after its start failed; the error goes away once it runs', async () => {
    const { host, store } = await started({ sidebar: [] });
    globalThis.__bays.failStart.add('dev.test.c');
    await expect(host.addBay('dev.test.c')).rejects.toThrow('Start failed: boom');
    expect(store.sidebar).toEqual([]);
    globalThis.__bays.failStart.delete('dev.test.c');
    await invoke('shell:addBay', FakeWindow.all[0]!.webContents, 'dev.test.c');
    expect(store.sidebar).toEqual(['dev.test.c']);
    expect(host.runtimes.has('dev.test.c')).toBe(true);
  });

  it('removes a bay: view closed, runtime stopped, functions and tabs gone, overview selected', async () => {
    const { host, store, bus, viewOf, window } = await started();
    host.select('dev.test.a');
    const view = viewOf('dev.test.a')!;
    await host.removeBay('dev.test.a');
    expect(store.sidebar).toEqual([]);
    expect(host.runtimes.has('dev.test.a')).toBe(false);
    expect(globalThis.__bays.stopped).toEqual(['dev.test.a']);
    expect(bus.unregisterBay).toHaveBeenCalledWith('dev.test.a');
    expect(window().children).not.toContain(view);
    expect(view.webContents.close).toHaveBeenCalled();
    expect(host.state().selected).toBe('overview');
    expect(electron.app.setBadgeCount).toHaveBeenLastCalledWith(0);
  });

  it('removes a bay even when its stop fails, and keeps another selection', async () => {
    const { host, store } = await started({ sidebar: ['dev.test.a', 'dev.test.c'] });
    host.select('dev.test.c');
    globalThis.__bays.failStop.add('dev.test.a');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await host.removeBay('dev.test.a');
    expect(error).toHaveBeenCalledWith('Bay dev.test.a: deactivate failed', expect.any(Error));
    error.mockRestore();
    expect(store.sidebar).toEqual(['dev.test.c']);
    expect(host.state().selected).toBe('dev.test.c');
  });

  it('removes a bay that is removed during its start, once the start is done', async () => {
    const { host, store, viewOf } = await started({ sidebar: [] });
    const gate = hold('dev.test.c');
    const adding = host.addBay('dev.test.c');
    const removing = host.removeBay('dev.test.c');
    gate.release();
    await Promise.all([adding, removing]);
    expect(host.runtimes.has('dev.test.c')).toBe(false);
    expect(store.sidebar).toEqual([]);
    expect(globalThis.__bays.stopped).toEqual(['dev.test.c']);
    expect(viewOf('dev.test.c')!.webContents.close).toHaveBeenCalled();
    expect(host.state().selected).toBe('overview');
  });

  it('removes a bay that is removed during a start that fails', async () => {
    const { host, store } = await started({ sidebar: [] });
    const gate = hold('dev.test.c');
    globalThis.__bays.failStart.add('dev.test.c');
    const adding = host.addBay('dev.test.c');
    const removing = host.removeBay('dev.test.c');
    gate.release();
    await expect(adding).rejects.toThrow('Start failed: boom');
    await removing;
    expect(store.sidebar).toEqual([]);
    expect(host.runtimes.has('dev.test.c')).toBe(false);
  });

  it('opens the bay menu only for running bays; its item removes the bay', async () => {
    const { host, window, store } = await started();
    send('shell:bayMenu', window().webContents, 'dev.test.c');
    send('shell:bayMenu', window().webContents, 7);
    expect(menus).toEqual([]);
    send('shell:bayMenu', window().webContents, 'dev.test.a');
    clickMenu('Aus Leiste entfernen');
    await vi.waitFor(() => expect(host.runtimes.size).toBe(0));
    expect(store.sidebar).toEqual([]);
  });
});

describe('Host: what a bay view may do', () => {
  it('routes bay:invoke to the bay of the sender and refuses unknown senders', async () => {
    const { viewOf } = await started();
    const view = viewOf('dev.test.a')!;
    await expect(invoke('bay:invoke', view.webContents, 'echo', ['hi'])).resolves.toBe('echo hi');
    const stranger = new FakeContents();
    for (const [channel, args] of [
      ['bay:invoke', ['echo', ['hi']]],
      ['bay:window.open', ['k', 'T']],
      ['bay:window.close', ['k']],
      ['bay:window.list', []],
      ['bay:browser.show', [undefined, undefined]],
    ] as const) {
      await expect(invoke(channel, stranger, ...args), channel).rejects.toThrow('Unknown sender');
    }
    expect(send('bay:server', stranger)).toBeNull();
    expect(send('bay:server', view.webContents)).toBeNull();
  });

  it('opens a bay window once, lists it, closes it and tells the bay', async () => {
    const { viewOf } = await started();
    const view = viewOf('dev.test.a')!;
    await expect(invoke('bay:window.open', view.webContents, 1, 'T')).rejects.toThrow(
      'Invalid window',
    );
    await invoke('bay:window.open', view.webContents, 'session:1', 'Eins');
    await invoke('bay:window.open', view.webContents, 'session:1', 'Eins');
    expect(FakeWindow.all).toHaveLength(2);
    const win = FakeWindow.all[1]!;
    expect(win.focus).toHaveBeenCalled();
    expect(win.webContents.loadFile).toHaveBeenCalledWith(expect.stringContaining('index.html'), {
      query: { window: 'session:1' },
    });
    expect(view.webContents.send).toHaveBeenCalledWith('bay:windows', ['session:1']);
    // The window speaks for its bay too.
    await expect(invoke('bay:window.list', win.webContents)).resolves.toEqual(['session:1']);
    await expect(invoke('bay:invoke', win.webContents, 'echo', ['w'])).resolves.toBe('echo w');
    // Its page title does not replace the bay's.
    const title = { preventDefault: vi.fn() };
    win.emit('page-title-updated', title);
    expect(title.preventDefault).toHaveBeenCalled();
    await invoke('bay:window.close', view.webContents, 'session:1');
    expect(win.destroyed).toBe(true);
    expect(view.webContents.send).toHaveBeenLastCalledWith('bay:windows', []);
    await expect(invoke('bay:window.list', view.webContents)).resolves.toEqual([]);
  });

  it('closes only the named window, and all windows of a removed bay', async () => {
    const { host, viewOf } = await started();
    const view = viewOf('dev.test.a')!;
    await invoke('bay:window.open', view.webContents, 'session:1', 'Eins');
    await invoke('bay:window.open', view.webContents, 'session:2', 'Zwei');
    await invoke('bay:window.close', view.webContents, 'session:9');
    expect(FakeWindow.all.slice(1).map((w) => w.destroyed)).toEqual([false, false]);
    await host.removeBay('dev.test.a');
    expect(FakeWindow.all.slice(1).map((w) => w.destroyed)).toEqual([true, true]);
  });

  it('no longer answers for a bay window once it is destroyed', async () => {
    const { viewOf } = await started();
    await invoke('bay:window.open', viewOf('dev.test.a')!.webContents, 'session:1', 'Eins');
    const win = FakeWindow.all[1]!;
    // Destroyed without the closed event, as during shutdown.
    win.destroyed = true;
    await expect(invoke('bay:invoke', win.webContents, 'echo', ['x'])).rejects.toThrow(
      'Unknown sender',
    );
  });

  it('lays a tab over a bay window at its origin, always visible', async () => {
    const { viewOf } = await started({ sidebar: ['dev.test.b'] });
    await invoke('bay:window.open', viewOf('dev.test.b')!.webContents, 'tabs', 'Tabs');
    const win = FakeWindow.all[1]!;
    const id = await globalThis.__bays.contexts.get('dev.test.b')!.browser!.open('about:blank');
    const tabView = FakeView.all.at(-1)!;
    await invoke('bay:browser.show', win.webContents, id, { x: 5, y: 6, width: 7, height: 8 });
    expect(tabView.bounds).toEqual({ x: 5, y: 6, width: 7, height: 8 });
    expect(tabView.visible).toBe(true);
    expect(win.children).toContain(tabView);
  });

  it('keeps the window list when windows close because Hangar quits', async () => {
    const { host, viewOf } = await started();
    const view = viewOf('dev.test.a')!;
    await invoke('bay:window.open', view.webContents, 'session:1', 'Eins');
    view.webContents.send.mockClear();
    host.quitting = true;
    FakeWindow.all[1]!.close();
    expect(view.webContents.send).not.toHaveBeenCalled();
  });

  it('shows tabs only for bays with the browser module and checks the placement', async () => {
    const { host, viewOf } = await started({ sidebar: ['dev.test.a', 'dev.test.b'] });
    await expect(
      invoke('bay:browser.show', viewOf('dev.test.a')!.webContents, undefined, undefined),
    ).rejects.toThrow('Bay has no host module "browser"');
    const b = viewOf('dev.test.b')!.webContents;
    for (const [id, rect] of [
      [5, undefined],
      ['t', null],
      ['t', 'rect'],
      ['t', { x: 0, y: 0, width: 1 }],
      ['t', { x: 0, y: 0, width: 1, height: Number.NaN }],
      ['t', { x: 0, y: 0, width: 1, height: Infinity }],
    ] as const) {
      await expect(invoke('bay:browser.show', b, id, rect), JSON.stringify(rect)).rejects.toThrow(
        'Invalid tab placement',
      );
    }
    // Valid but unknown tab: the tab module answers.
    await expect(
      invoke('bay:browser.show', b, 'nope', { x: 0, y: 0, width: 1, height: 1 }),
    ).rejects.toThrow('Unknown tab "nope"');
    await expect(invoke('bay:browser.show', b, undefined, undefined)).resolves.toBeUndefined();
    // A tab opened by bay B is laid over its view and follows its visibility.
    const ctx = globalThis.__bays.contexts.get('dev.test.b')!;
    const id = await ctx.browser!.open('about:blank');
    const tabView = FakeView.all.at(-1)!;
    host.select('dev.test.b');
    await invoke('bay:browser.show', b, id, { x: 10, y: 10, width: 100, height: 50 });
    expect(tabView.bounds).toEqual({ x: 74, y: 10, width: 100, height: 50 });
    expect(tabView.visible).toBe(true);
    send('shell:modal', FakeWindow.all[0]!.webContents, true);
    expect(tabView.visible).toBe(false);
    // Removing the bay closes its tabs.
    await host.removeBay('dev.test.b');
    expect(ctx.browser!.list()).toEqual([]);
  });

  it('inserts the theme, blocks navigation and opens only web links outside', async () => {
    const { viewOf } = await started();
    const contents = viewOf('dev.test.a')!.webContents;
    contents.emit('dom-ready');
    expect(contents.insertCSS).toHaveBeenCalledWith(expect.stringContaining('--hangar-'));
    const navigation = { preventDefault: vi.fn() };
    contents.emit('will-navigate', navigation);
    expect(navigation.preventDefault).toHaveBeenCalled();
    expect(contents.openHandler!({ url: 'https://example.com' })).toEqual({ action: 'deny' });
    expect(contents.openHandler!({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
    expect(electron.shell.openExternal.mock.calls).toEqual([['https://example.com']]);
  });

  it('sends bay events to its view and windows, badges to the app and the shell', async () => {
    const { host, viewOf, shellState } = await started({ sidebar: ['dev.test.a', 'dev.test.c'] });
    const view = viewOf('dev.test.a')!;
    await invoke('bay:window.open', view.webContents, 'session:1', 'Eins');
    const win = FakeWindow.all[1]!;
    const ctx = globalThis.__bays.contexts.get('dev.test.a')!;
    ctx.ui.send('state', { n: 1 });
    expect(view.webContents.send).toHaveBeenCalledWith('bay:event', 'state', { n: 1 });
    expect(win.webContents.send).toHaveBeenCalledWith('bay:event', 'state', { n: 1 });
    ctx.setBadge(2);
    globalThis.__bays.contexts.get('dev.test.c')!.setBadge(3);
    expect(electron.app.setBadgeCount).toHaveBeenLastCalledWith(5);
    expect(shellState().bays.map((b) => [b.id, b.badge])).toEqual([
      ['dev.test.a', 2],
      ['dev.test.c', 3],
    ]);
    expect(host.state().bays[0]!.icon).toBe(
      `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`,
    );
  });

  it('tells every bay when an agent session ends', async () => {
    const { services } = await started({ sidebar: ['dev.test.a', 'dev.test.c'] });
    const ended = vi.fn();
    globalThis.__bays.contexts.get('dev.test.c')!.onAgentSessionEnded(ended);
    globalThis.__bays.contexts.get('dev.test.a')!.unregisterAgentSession('s1');
    expect(services.unregisterAgentSession).toHaveBeenCalledWith('dev.test.a', 's1');
    expect(ended).toHaveBeenCalledWith({ bayId: 'dev.test.a', sessionId: 's1' });
  });
});

describe('Host: notifications', () => {
  it('shows a system notification; clicking it brings the bay to the front', async () => {
    const { host, window } = await started();
    window().hide();
    globalThis.__bays.contexts.get('dev.test.a')!.notify({ title: 'Fertig', body: 'Session 1' });
    const [n] = FakeNotification.all;
    expect(n!.options).toEqual({ title: 'Fertig', body: 'Session 1' });
    expect(n!.show).toHaveBeenCalled();
    n!.emit('click');
    expect(window().shown).toBe(true);
    expect(host.state().selected).toBe('dev.test.a');
    n!.emit('close');
    host.notify('dev.test.a', { title: 'Ohne Text' });
    expect(FakeNotification.all[1]!.options.body).toBe('');
  });

  it('shows nothing where notifications are not supported', async () => {
    FakeNotification.supported = false;
    const { host } = await started();
    host.notify('dev.test.a', { title: 'x' });
    expect(FakeNotification.all).toEqual([]);
  });

  it('records notifications instead of showing them under HANGAR_E2E', async () => {
    process.env.HANGAR_E2E = '1';
    globalThis.__hangarNotifications = [];
    const { host } = await started();
    host.notify('dev.test.a', { title: 'x' });
    expect(FakeNotification.all).toEqual([]);
    expect(globalThis.__hangarNotifications).toEqual([
      { bayId: 'dev.test.a', title: 'x', click: expect.any(Function) },
    ]);
    globalThis.__hangarNotifications = undefined;
  });
});

describe('Host: shortcuts', () => {
  const site = { id: 's1', target: 'https://example.com/' };
  const folder = { id: 's2', target: '/Users/anna/Projekte' };
  const gone = { id: 's3', target: '/Users/anna/gone' };

  /** Runs `fn` as if on `platform` (the icon source depends on it). */
  const onPlatform = async (platform: string, fn: () => Promise<void>) => {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: platform });
    try {
      await fn();
    } finally {
      Object.defineProperty(process, 'platform', real);
    }
  };

  it('shows shortcuts with names and the thumbnails of their paths (macOS)', () =>
    onPlatform('darwin', async () => {
      const { host } = await started({ shortcuts: [site, folder, gone] });
      await vi.waitFor(() => expect(host.state().shortcuts[1]!.icon).toBeDefined());
      expect(host.state().shortcuts).toEqual([
        { id: 's1', name: 'example.com', target: site.target, url: true },
        {
          id: 's2',
          name: 'Projekte',
          target: folder.target,
          url: false,
          icon: `data:thumb:${folder.target}`,
        },
        { id: 's3', name: 'gone', target: gone.target, url: false },
      ]);
      expect(electron.nativeImage.createThumbnailFromPath).toHaveBeenCalledTimes(2);
    }));

  it('opens a website outside, a path with the system, and names what failed', async () => {
    const { window } = await started({ shortcuts: [site, folder] });
    send('shell:shortcut.open', window().webContents, 's1');
    send('shell:shortcut.open', window().webContents, 'unknown');
    await vi.waitFor(() => expect(electron.shell.openExternal).toHaveBeenCalledWith(site.target));
    electron.shell.openPath.mockResolvedValueOnce('Folder not found');
    send('shell:shortcut.open', window().webContents, 's2');
    await vi.waitFor(() =>
      expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(window(), {
        type: 'warning',
        message: '„Projekte“ lässt sich nicht öffnen.',
        detail: 'Folder not found',
      }),
    );
    electron.shell.openExternal.mockRejectedValueOnce(new Error('No browser'));
    send('shell:shortcut.open', window().webContents, 's1');
    await vi.waitFor(() =>
      expect(electron.dialog.showMessageBox).toHaveBeenLastCalledWith(
        window(),
        expect.objectContaining({ detail: 'No browser' }),
      ),
    );
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it('adds a website once and refuses an invalid address', async () => {
    const { store, window } = await started();
    await invoke('shell:shortcut.url', window().webContents, ' https://example.com ');
    await invoke('shell:shortcut.url', window().webContents, 'https://example.com');
    expect(store.shortcuts.map((s) => s.target)).toEqual(['https://example.com/']);
    await expect(invoke('shell:shortcut.url', window().webContents, 'ftp://x')).rejects.toThrow(
      'Invalid URL',
    );
  });

  it('adds a picked file or folder; a cancelled dialog adds nothing', async () => {
    const { store, window } = await started();
    await expect(invoke('shell:shortcut.pick', window().webContents, 'file')).resolves.toBe(false);
    expect(electron.dialog.showOpenDialog).toHaveBeenLastCalledWith(window(), {
      properties: ['openFile'],
    });
    electron.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/Applications/Notes.app'],
    });
    await expect(invoke('shell:shortcut.pick', window().webContents, 'folder')).resolves.toBe(true);
    expect(electron.dialog.showOpenDialog).toHaveBeenLastCalledWith(window(), {
      properties: ['openDirectory'],
    });
    expect(store.shortcuts.map((s) => s.target)).toEqual(['/Applications/Notes.app']);
  });

  it('uses the file icon on Linux', () =>
    onPlatform('linux', async () => {
      const { host } = await started({ shortcuts: [folder] });
      await vi.waitFor(() => expect(host.state().shortcuts[0]!.icon).toBe('data:file-icon'));
      expect(electron.nativeImage.createThumbnailFromPath).not.toHaveBeenCalled();
    }));

  it('removes a shortcut from its menu; unknown ids get no menu', async () => {
    const { store, window } = await started({ shortcuts: [site, folder] });
    send('shell:shortcutMenu', window().webContents, 'unknown');
    expect(menus).toEqual([]);
    send('shell:shortcutMenu', window().webContents, 's1');
    clickMenu('Aus Leiste entfernen');
    expect(store.shortcuts).toEqual([folder]);
  });
});

describe('Host: servers', () => {
  const connected = (bays = [{ id: 'dev.test.a', version: '0.1.0' }]) => ({
    id: 'srv',
    name: 'Heimserver',
    status: 'connected',
    bays,
    badges: { 'dev.test.a': 4 },
  });

  it('shows a connected server bay with the local bundle in its own partition', async () => {
    const { host, servers, viewOf, window } = await started();
    servers.servers = [connected()];
    servers.events.changed();
    const view = viewOf('remote:srv:dev.test.a')!;
    expect(view).toBeDefined();
    expect(view.webContents.loadFile).toHaveBeenCalledWith(
      expect.stringMatching(/dev\.test\.a[/\\]index\.html$/),
      undefined,
    );
    expect(host.state().servers).toEqual([
      {
        id: 'srv',
        name: 'Heimserver',
        status: 'connected',
        bays: [{ id: 'remote:srv:dev.test.a', name: 'Alpha', icon: expect.any(String), badge: 4 }],
        errors: [],
      },
    ]);
    expect(electron.app.setBadgeCount).toHaveBeenLastCalledWith(4);
    expect(window().webContents.send).toHaveBeenCalledWith('shell:jobs');
    // Calls of the view go to the server; its name is known to the preload.
    await expect(invoke('bay:invoke', view.webContents, 'echo', ['x'])).resolves.toBe(
      'from server',
    );
    expect(servers.invoke).toHaveBeenCalledWith('srv', 'dev.test.a', 'echo', ['x']);
    expect(send('bay:server', view.webContents)).toBe('Heimserver');
    await expect(
      invoke('bay:browser.show', view.webContents, undefined, undefined),
    ).rejects.toThrow('Bay has no host module "browser"');
    // Events of the server reach the view.
    servers.events.event('srv', 'dev.test.a', 'state', 1);
    expect(view.webContents.send).toHaveBeenCalledWith('bay:event', 'state', 1);
  });

  it('leaves the bays of the local server to it and shows them from its own copy (ADR 0036)', async () => {
    // The server still runs the version of its copy; this app has 0.1.0.
    const copy = mkdtempSync(join(tmpdir(), 'hangar-copy-'));
    const ui = writeBay(copy, 'dev.test.a', 'Alpha', { version: '0.0.9' });
    const { host, servers, services, viewOf } = await started({
      sidebar: ['dev.test.a', 'dev.test.c'],
      localServer: { owns: ['dev.test.a'], uiRoots: () => [copy] },
    });
    expect(globalThis.__bays.started).toEqual(['dev.test.c']);
    expect(host.state().available.map((b) => b.id)).not.toContain('dev.test.a');
    await expect(host.addBay('dev.test.a')).rejects.toThrow('Unknown bay "dev.test.a"');

    servers.servers = [
      { ...connected([{ id: 'dev.test.a', version: '0.0.9' }]), local: true as const },
    ];
    servers.events.changed();
    const view = viewOf('remote:srv:dev.test.a')!;
    expect(view.webContents.loadFile).toHaveBeenCalledWith(join(ui, 'index.html'), undefined);
    // Not a remote server for the bay: no path form, the folder dialog of this Mac.
    expect(send('bay:server', view.webContents)).toBeNull();
    services.pickFolder.mockResolvedValueOnce('/Users/ada/shop' as never);
    await expect(invoke('bay:invoke', view.webContents, 'project.add', [])).resolves.toBe(
      'from server',
    );
    expect(services.pickFolder).toHaveBeenCalledWith(undefined);
    expect(servers.invoke).toHaveBeenLastCalledWith('srv', 'dev.test.a', 'project.add', [
      '/Users/ada/shop',
    ]);
    servers.invoke.mockClear();
    await expect(invoke('bay:invoke', view.webContents, 'project.add', [])).resolves.toBe(
      undefined,
    );
    expect(servers.invoke).not.toHaveBeenCalled();
    await invoke('bay:invoke', view.webContents, 'state', []);
    expect(servers.invoke).toHaveBeenLastCalledWith('srv', 'dev.test.a', 'state', []);
  });

  it('finds the UI of the version the local server runs among several copies', async () => {
    const [older, newer] = [
      mkdtempSync(join(tmpdir(), 'hangar-copy-')),
      mkdtempSync(join(tmpdir(), 'hangar-copy-')),
    ];
    writeBay(older, 'dev.test.a', 'Alpha', { version: '0.0.8' });
    const ui = writeBay(newer, 'dev.test.a', 'Alpha', { version: '0.0.9' });
    const { servers, viewOf } = await started({
      localServer: { owns: ['dev.test.a'], uiRoots: () => [older, newer] },
    });
    servers.servers = [
      { ...connected([{ id: 'dev.test.a', version: '0.0.9' }]), local: true as const },
    ];
    servers.events.changed();
    expect(viewOf('remote:srv:dev.test.a')!.webContents.loadFile).toHaveBeenCalledWith(
      join(ui, 'index.html'),
      undefined,
    );
  });

  it('names server bays it cannot show: other version or missing here', async () => {
    const { host, servers } = await started();
    servers.servers = [
      {
        ...connected([
          { id: 'dev.test.a', version: '0.2.0' },
          { id: 'dev.test.x', version: '1.0.0' },
        ]),
        status: 'failed',
        error: 'gone',
      },
    ];
    servers.servers[0]!.status = 'connected';
    servers.events.changed();
    expect(host.state().servers[0]!.errors).toEqual([
      { label: 'Alpha', error: 'Version passt nicht (Server 0.2.0, hier 0.1.0)' },
      { label: 'dev.test.x', error: 'Bay fehlt hier' },
    ]);
    expect(host.state().servers[0]!.error).toBe('gone');
  });

  it('keeps a selected server bay in mind while the server is away and selects it again', async () => {
    const { host, servers, viewOf } = await started();
    servers.servers = [connected()];
    servers.events.changed();
    host.select('remote:srv:dev.test.a');
    const view = viewOf('remote:srv:dev.test.a')!;
    servers.servers = [{ ...connected(), status: 'disconnected', bays: [] }];
    servers.events.changed();
    expect(view.webContents.close).toHaveBeenCalled();
    expect(host.state().selected).toBe('overview');
    servers.servers = [connected()];
    servers.events.changed();
    expect(host.state().selected).toBe('remote:srv:dev.test.a');
  });

  it('selects a server bay chosen before the restart once the server is back', async () => {
    const { host, servers } = await started({
      view: { selected: 'remote:srv:dev.test.a', windows: [] },
    });
    expect(host.state().selected).toBe('overview');
    servers.servers = [connected()];
    servers.events.changed();
    expect(host.state().selected).toBe('remote:srv:dev.test.a');
  });

  it('ignores server changes while quitting, after the window is gone', async () => {
    const { servers, window, viewOf } = await started();
    window().destroyed = true;
    servers.servers = [connected()];
    servers.events.changed();
    expect(viewOf('remote:srv:dev.test.a')).toBeUndefined();
  });

  it('asks and notifies with the name of the server', async () => {
    const { host, servers } = await started();
    servers.servers = [connected()];
    servers.events.changed();
    const signal = new AbortController().signal;
    await servers.events.ask('srv', { target: 'x' }, signal);
    expect(askWithDialog).toHaveBeenCalledWith({ target: 'x' }, 'Heimserver', signal);
    await servers.events.ask('other', { target: 'x' }, signal);
    expect(askWithDialog).toHaveBeenLastCalledWith({ target: 'x' }, 'other', signal);
    servers.events.notify('srv', 'dev.test.a', { title: 'Fertig' });
    expect(FakeNotification.all[0]!.options.title).toBe('Heimserver: Fertig');
    FakeNotification.all[0]!.emit('click');
    expect(host.state().selected).toBe('remote:srv:dev.test.a');
    servers.events.jobs();
  });

  it('sets up a server on a Linux machine with the shipped packages and pairs (ADR 0041)', async () => {
    const { servers, window } = await started();
    const shell = window().webContents;
    // The server answers 503 until its bays are active: pairing is tried again (Codex).
    servers.pairSetUp.mockRejectedValueOnce(new Error('Cannot reach ws://127.0.0.1:1/connect'));
    await expect(invoke('shell:server.setup', shell, 'Heim', 'anna@heimserver')).resolves.toEqual({
      linger: false,
      user: 'anna',
    });
    expect(bridgeSetup.linuxPackages).toHaveBeenCalledWith('', '0.0.0');
    expect(bridgeSetup.sshRemote).toHaveBeenCalledWith(
      { user: 'anna', host: 'heimserver' },
      expect.any(String),
    );
    expect(bridgeSetup.setUpServer).toHaveBeenCalledWith(
      { target: { user: 'anna', host: 'heimserver' }, ssh: expect.any(String) },
      [{ dir: '', version: '0.0.0' }],
    );
    expect(servers.pairSetUp).toHaveBeenCalledTimes(2);
    expect(servers.pairSetUp).toHaveBeenCalledWith(
      { user: 'anna', host: 'heimserver' },
      'Heim',
      expect.objectContaining({ port: 1 }),
    );
    await expect(invoke('shell:server.setup', shell, 'Heim', 'heimserver:7420')).rejects.toThrow(
      'Invalid address: heimserver:7420',
    );
  });

  it('pairs with the local server under its own name (ADR 0036)', async () => {
    const { host, servers } = await started();
    await expect(host.pairLocalServer('/data/local-server/data')).resolves.toBe('local');
    expect(servers.pairLocal).toHaveBeenCalledWith('/data/local-server/data', 'Lokaler Server');
  });

  it('passes probe, pair and cancel on and offers connect or disconnect in its menu', async () => {
    const { servers, window } = await started();
    const shell = window().webContents;
    await expect(invoke('shell:server.probe', shell, '127.0.0.1:7420')).resolves.toEqual({
      id: 'probe',
      fingerprint: 'SHA256:x',
    });
    await expect(invoke('shell:server.pair', shell, 'probe', 'Heim', 'CODE')).resolves.toBe(
      undefined,
    );
    expect(servers.pair).toHaveBeenCalledWith('probe', 'Heim', 'CODE');
    send('shell:server.cancel', shell, 'probe');
    expect(servers.cancel).toHaveBeenCalledWith('probe');

    send('shell:serverMenu', shell, 'unknown');
    expect(menus).toEqual([]);
    servers.servers = [connected()];
    send('shell:serverMenu', shell, 'srv');
    expect(menus.at(-1)!.map((i) => i.label ?? i.type)).toEqual([
      'Verbindung trennen',
      'separator',
      'Server entfernen',
    ]);
    clickMenu('Verbindung trennen');
    expect(servers.disconnect).toHaveBeenCalledWith('srv');
    servers.servers = [{ ...connected(), status: 'failed' }];
    send('shell:serverMenu', shell, 'srv');
    clickMenu('Verbinden');
    expect(servers.connect).toHaveBeenCalledWith('srv');
    clickMenu('Server entfernen');
    expect(servers.remove).toHaveBeenCalledWith('srv');
  });
});

describe('Host: settings pages', () => {
  it('lists permissions with session names', async () => {
    const { window } = await started({ sidebar: ['dev.test.a', 'dev.test.c'] });
    globalThis.__bays.contexts
      .get('dev.test.a')!
      .labelSessions((id) => (id === 's1' ? 'Anmeldung' : undefined));
    await expect(invoke('shell:permissions', window().webContents)).resolves.toEqual({
      bays: [
        { id: 'dev.test.a', name: 'Alpha' },
        { id: 'dev.test.c', name: 'Gamma' },
      ],
      functions: [
        { id: 'dev.test.a/echo', bayId: 'dev.test.a', sensitive: false },
        { id: 'dev.test.a/secret', bayId: 'dev.test.a', sensitive: true, description: 'Geheim' },
      ],
      grants: [
        {
          subject: 'dev.test.a',
          target: 'dev.test.a/echo',
          mode: 'allow',
          sessionId: 's1',
          sessionLabel: 'Anmeldung',
        },
        { subject: 'dev.test.c', target: 'dev.test.a/echo', mode: 'deny' },
      ],
    });
  });

  it('revokes and sets grants on the bus', async () => {
    const { bus, window } = await started();
    await invoke('shell:revoke', window().webContents, {
      subject: 'a',
      target: 'b',
      sessionId: 's',
    });
    await invoke('shell:setGrant', window().webContents, 'a', 'b', 'ask');
    expect(bus.revoke).toHaveBeenCalledWith('a', 'b', 's');
    expect(bus.setMode).toHaveBeenCalledWith('a', 'b', 'ask');
  });

  it('lists jobs of here and of connected servers, with the error of one that fails', async () => {
    const { servers, window } = await started();
    servers.servers = [
      { id: 'srv', name: 'Heim', status: 'connected', bays: [], badges: {} },
      { id: 'bad', name: 'Kaputt', status: 'connected', bays: [], badges: {} },
      { id: 'off', name: 'Aus', status: 'disconnected', bays: [], badges: {} },
    ];
    servers.jobs.mockImplementation(async (id: string) => {
      if (id === 'bad') throw new Error('timeout');
      return [{ id: 'sj' }];
    });
    await expect(invoke('shell:jobs', window().webContents)).resolves.toEqual({
      bays: [
        { id: 'dev.test.a', name: 'Alpha' },
        { id: 'dev.test.b', name: 'Beta' },
        { id: 'dev.test.c', name: 'Gamma' },
      ],
      jobs: [{ id: 'j1' }],
      servers: [
        { id: 'srv', name: 'Heim', jobs: [{ id: 'sj' }] },
        { id: 'bad', name: 'Kaputt', jobs: [], error: 'timeout' },
      ],
    });
  });

  it('acts on a local job or on the job of a server', async () => {
    const { scheduler, servers, window } = await started();
    const shell = window().webContents;
    await invoke('shell:job.pause', shell, 'j1', true);
    await invoke('shell:job.pause', shell, 'j1', true, 'srv');
    await invoke('shell:job.pause', shell, 'j1', false, 'srv');
    await expect(invoke('shell:job.run', shell, 'j1')).resolves.toBeUndefined();
    await invoke('shell:job.run', shell, 'j1', 'srv');
    await invoke('shell:job.remove', shell, 'j1');
    await invoke('shell:job.remove', shell, 'j1', 'srv');
    expect(scheduler.setPaused).toHaveBeenCalledWith('j1', true);
    expect(scheduler.runNow).toHaveBeenCalledWith('j1');
    expect(scheduler.remove).toHaveBeenCalledWith('j1');
    expect(servers.job.mock.calls).toEqual([
      ['srv', 'pause', 'j1'],
      ['srv', 'resume', 'j1'],
      ['srv', 'run', 'j1'],
      ['srv', 'remove', 'j1'],
    ]);
  });

  it('answers state, overview and selection from the shell', async () => {
    const { window, host } = await started();
    const shell = window().webContents;
    send('shell:select', shell, 'settings');
    await expect(invoke('shell:state', shell)).resolves.toMatchObject({ selected: 'settings' });
    await expect(invoke('shell:overview', shell)).resolves.toEqual({
      version: '0.1.0',
      git: { name: 'Anna', email: 'a@x' },
      bays: [{ id: 'dev.test.a', name: 'Alpha', version: '0.1.0' }],
      errors: host.state().errors,
    });
  });

  it('tells nobody about jobs before the window exists', () => {
    const { host } = setup();
    expect(() => host.jobsChanged()).not.toThrow();
    expect(() => host.workspacesChanged()).not.toThrow();
    expect(() => host.pushState()).not.toThrow();
  });

  it('tells the shell when the workspaces changed (ADR 0030)', async () => {
    const { host } = setup();
    await host.start();
    host.workspacesChanged();
    expect(FakeWindow.all[0]!.webContents.send).toHaveBeenCalledWith('shell:workspaces');
  });
});

describe('Host: stop', () => {
  it('saves window, selection and bay windows, closes servers and stops the bays', async () => {
    const { host, servers, viewOf, viewFile } = await started();
    host.select('dev.test.a');
    await invoke('bay:window.open', viewOf('dev.test.a')!.webContents, 'session:1', 'Eins');
    await host.stop();
    expect(JSON.parse(readFileSync(viewFile, 'utf8'))).toEqual({
      bounds: { x: 10, y: 20, width: 1100, height: 700 },
      maximized: false,
      selected: 'dev.test.a',
      windows: [
        {
          bay: 'dev.test.a',
          key: 'session:1',
          title: 'Eins',
          bounds: { x: 10, y: 20, width: 1100, height: 700 },
        },
      ],
    });
    expect(servers.closeAll).toHaveBeenCalled();
    expect(globalThis.__bays.stopped).toEqual(['dev.test.a']);
  });
});

describe('Host: bays of this app for the local server (ADR 0036)', () => {
  it('offers the functions of the bays it runs, never those of others', async () => {
    const { servers, bus } = await started();
    const list = bus.list();
    bus.list = () => [
      ...list,
      // Of a bay not started here (another instance through the relay, say).
      { id: 'dev.remote/x', bayId: 'dev.remote', spec: { sensitive: false } },
    ];
    expect(servers.events.local!.functions()).toEqual([
      { bayId: 'dev.test.a', spec: { sensitive: false } },
      { bayId: 'dev.test.a', spec: { sensitive: true, description: 'Geheim' } },
    ]);
  });

  it('runs the calls of the local server under a caller of its own, only for its bays', async () => {
    const { servers, bus } = await started();
    const { local } = servers.events;
    const caller = { bayId: 'dev.hangar.agents', sessionId: 's1' };
    const signal = new AbortController().signal;
    await expect(local!.call('dev.test.a/echo', { x: 1 }, caller, signal)).resolves.toBe('done');
    // The signal ends the call after a dialog when the connection broke off.
    expect(bus.call).toHaveBeenCalledWith(
      { kind: 'local-server', bayId: 'dev.hangar.agents', sessionId: 's1' },
      'dev.test.a/echo',
      { x: 1 },
      signal,
    );
    await expect(local!.call('dev.test.c/echo', {}, caller)).rejects.toThrow(
      'Unknown function: dev.test.c/echo',
    );
    await expect(local!.call('nope', {}, caller)).rejects.toThrow('Unknown function: nope');
    // The server cannot pass itself off as a bay of this app.
    await local!.call('dev.test.a/echo', {}, { kind: 'bay', bayId: 'dev.test.a' });
    expect(bus.call).toHaveBeenLastCalledWith(
      { kind: 'local-server', bayId: 'dev.test.a' },
      'dev.test.a/echo',
      {},
      undefined,
    );
    expect(bus.call).toHaveBeenCalledTimes(2);
  });

  it('marks a call of a server bay declared in its `uses`, never one of its agents (ADR 0032)', async () => {
    const { servers, bus } = await started();
    const { local } = servers.events;
    await local!.call('dev.test.a/echo', {}, { bayId: 'dev.test.c' });
    expect(bus.call).toHaveBeenLastCalledWith(
      { kind: 'local-server', bayId: 'dev.test.c', declared: true },
      'dev.test.a/echo',
      {},
      undefined,
    );
    await local!.call('dev.test.a/echo', {}, { bayId: 'dev.test.c', sessionId: 's1' });
    await local!.call('dev.test.a/secret', {}, { bayId: 'dev.test.c' });
    await local!.call('dev.test.a/echo', {}, { bayId: 'dev.unknown' });
    for (const [n, caller] of [
      [2, { kind: 'local-server', bayId: 'dev.test.c', sessionId: 's1' }],
      [3, { kind: 'local-server', bayId: 'dev.test.c' }],
      [4, { kind: 'local-server', bayId: 'dev.unknown' }],
    ] as const)
      expect(bus.call).toHaveBeenNthCalledWith(n, caller, expect.any(String), {}, undefined);
  });

  it('ends a session of the local server in the bus and in its bays, apart from its own', async () => {
    const { servers, bus } = await started();
    const ended = vi.fn();
    globalThis.__bays.contexts.get('dev.test.a')!.onAgentSessionEnded(ended);
    servers.events.local!.sessionEnded('dev.hangar.agents', 's1');
    expect(bus.endSession).toHaveBeenCalledWith('s1');
    expect(ended).toHaveBeenCalledWith({
      bayId: 'local-server:dev.hangar.agents',
      sessionId: 's1',
    });
  });

  it('offers again after a bay was added or removed', async () => {
    const { host, servers } = await started();
    await host.addBay('dev.test.c');
    expect(servers.offerAgain).toHaveBeenCalledTimes(1);
    await host.removeBay('dev.test.c');
    expect(servers.offerAgain).toHaveBeenCalledTimes(2);
  });
});

describe('Host: the local server in sidebar, tray and notifications (ADR 0036, step 4)', () => {
  const local = (over: Record<string, unknown> = {}) => ({
    id: 'loc',
    name: 'Lokaler Server',
    status: 'connected',
    bays: [{ id: 'dev.test.c', version: '0.1.0' }],
    badges: { 'dev.test.c': 2 },
    local: true as const,
    ...over,
  });
  const remote = {
    id: 'srv',
    name: 'Heimserver',
    status: 'connected',
    bays: [],
    badges: {},
  };
  const options = (extra: Record<string, unknown> = {}) => ({
    localServer: {
      owns: ['dev.test.c'],
      uiRoots: () => [],
      restart: vi.fn(async () => {}),
      log: '/data/server.log',
      ...extra,
    },
  });
  const KEY = 'remote:loc:dev.test.c';

  it('shows its bays by their name apart from the servers, and keeps them while it is down', async () => {
    const { host, servers } = await started(options());
    servers.servers = [local(), remote];
    servers.events.changed();
    expect(host.state().servers.map((s) => s.id)).toEqual(['srv']);
    expect(host.state().localServer).toEqual({
      status: 'connected',
      bays: [{ id: KEY, name: 'Gamma', icon: expect.any(String), badge: 2 }],
    });
    host.select(KEY);
    servers.servers = [local({ status: 'failed', error: 'kaputt', bays: [] }), remote];
    servers.events.changed();
    // Selected still: the page there says it is down.
    expect(host.state().selected).toBe(KEY);
    // Its page follows the log, here one not written yet.
    expect(host.state().localServer).toEqual({
      status: 'failed',
      error: 'kaputt',
      bays: [{ id: KEY, name: 'Gamma', icon: expect.any(String), badge: 0 }],
      log: [],
    });
  });

  it('shows the bays it owns before it is paired, and none without a local server', async () => {
    const before = await started(options());
    expect(before.host.state().localServer).toEqual({
      status: 'connecting',
      bays: [{ id: 'remote:local:dev.test.c', name: 'Gamma', icon: expect.any(String), badge: 0 }],
    });
    const without = await started();
    expect(without.host.state().localServer).toBeUndefined();
  });

  it('names a newer version of the app and moves the bay below that hint', async () => {
    const { host, servers, viewOf } = await started(options({ version: () => '0.0.9' }));
    servers.servers = [local()];
    servers.events.changed();
    host.select(KEY);
    expect(host.state().localServer!.update).toEqual({ running: '0.0.9', ready: '0.1.0' });
    expect(viewOf(KEY)!.bounds.y).toBe(UPDATE_HINT_HEIGHT);
    // The hint as tall as the shell measured it, in window pixels (200 % zoom, wrapped text).
    const contents = FakeWindow.all[0]!.webContents as unknown as { getZoomFactor: () => number };
    contents.getZoomFactor = () => 2;
    send('shell:hintHeight', contents, 70.2);
    expect(viewOf(KEY)!.bounds.y).toBe(141);
    for (const wrong of ['70', -1, Number.NaN, 5000]) send('shell:hintHeight', contents, wrong);
    expect(viewOf(KEY)!.bounds.y).toBe(141);
    host.select('overview');
    const plain = await started(options({ version: () => '0.1.0' }));
    plain.servers.servers = [local()];
    plain.servers.events.changed();
    plain.host.select(KEY);
    expect(plain.host.state().localServer!.update).toBeUndefined();
    expect(plain.viewOf(KEY)!.bounds.y).toBe(0);
  });

  it('names a new build of the same version, and plain versions when they differ', async () => {
    const cases = [
      [
        { version: () => '0.1.0+aaaa1111', ready: () => '0.1.0+bbbb2222' },
        { running: '0.1.0+aaaa1111', ready: '0.1.0+bbbb2222' },
      ],
      [
        { version: () => '0.0.9+aaaa1111', ready: () => '0.1.0+bbbb2222' },
        { running: '0.0.9', ready: '0.1.0' },
      ],
      [{ version: () => '0.1.0+bbbb2222', ready: () => '0.1.0+bbbb2222' }, undefined],
    ] as const;
    for (const [server, update] of cases) {
      const { host, servers } = await started(options(server));
      servers.servers = [local()];
      servers.events.changed();
      expect(host.state().localServer!.update).toEqual(update);
    }
  });

  it('restarts it, asking first while shells run, and opens its log', async () => {
    const o = options();
    const { servers, window } = await started(o);
    servers.servers = [local({ sessions: 3 })];
    servers.events.changed();
    const restart = () => ipc.handlers.get('shell:localServer.restart')!({});
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
    await restart();
    expect(o.localServer.restart).not.toHaveBeenCalled();
    expect(electron.dialog.showMessageBox).toHaveBeenLastCalledWith(
      window(),
      expect.objectContaining({
        message: 'Lokalen Server neu starten?',
        detail: '3 laufende Shells enden; ihr Verlauf bleibt.',
        buttons: ['Neu starten', 'Abbrechen'],
      }),
    );
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    await restart();
    expect(o.localServer.restart).toHaveBeenCalledTimes(1);
    // Connected without shells: nothing to lose, no question.
    electron.dialog.showMessageBox.mockClear();
    servers.servers = [local({ sessions: 0 })];
    servers.events.changed();
    await restart();
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(o.localServer.restart).toHaveBeenCalledTimes(2);
    // Count unknown – down, or a server that never said: an old one may still run shells (Codex 4a).
    for (const view of [local({ status: 'failed', bays: [] }), local()]) {
      servers.servers = [view];
      servers.events.changed();
      electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });
      await restart();
      expect(electron.dialog.showMessageBox).toHaveBeenLastCalledWith(
        window(),
        expect.objectContaining({ detail: 'Laufende Shells enden; ihr Verlauf bleibt.' }),
      );
    }
    expect(o.localServer.restart).toHaveBeenCalledTimes(2);
    ipc.listeners.get('shell:localServer.log')!({});
    expect(electron.shell.openPath).toHaveBeenCalledWith('/data/server.log');
  });

  it('stays down between retries and says it starts while restarting', async () => {
    let finish!: () => void;
    const o = options({
      restart: vi.fn(() => new Promise<void>((r) => (finish = r))),
    });
    const { host, servers } = await started(o);
    const status = () => {
      const { status, error } = host.state().localServer!;
      return { status, error };
    };
    servers.servers = [local({ status: 'failed', error: 'weg', bays: [] })];
    servers.events.changed();
    // The next attempt of the retry: still down, with the last error, no flicker.
    servers.servers = [local({ status: 'connecting', bays: [] })];
    servers.events.changed();
    expect(status()).toEqual({ status: 'failed', error: 'weg' });
    // Down: the count is unknown, so it asks first; only then it starts.
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    const restarted = ipc.handlers.get('shell:localServer.restart')!({});
    expect(status()).toEqual({ status: 'failed', error: 'weg' });
    await vi.waitFor(() => expect(status()).toEqual({ status: 'connecting', error: undefined }));
    servers.servers = [local({ status: 'failed', error: 'noch nicht', bays: [] })];
    servers.events.changed();
    expect(status()).toEqual({ status: 'connecting', error: undefined });
    servers.servers = [local()];
    servers.events.changed();
    finish();
    await restarted;
    expect(status()).toEqual({ status: 'connected', error: undefined });
    // Connected once, a new attempt starts again.
    servers.servers = [local({ status: 'connecting', bays: [] })];
    servers.events.changed();
    expect(status()).toEqual({ status: 'connecting', error: undefined });
  });

  it('follows its log while its page says it is down, and names the reconnect attempt', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'hangar-log-')), 'server.log');
    writeFileSync(log, 'eins\nzwei\n');
    const { host, servers, shellState, window } = await started(options({ log }));
    servers.servers = [local({ status: 'failed', error: 'weg', bays: [], retry: 3 })];
    servers.events.changed();
    // Another page: the attempt counts, the log is not followed.
    expect(host.state().localServer).toMatchObject({ status: 'failed', retry: 3 });
    expect(host.state().localServer!.log).toBeUndefined();
    host.select(KEY);
    expect(shellState().localServer!.log).toEqual(['eins', 'zwei']);
    appendFileSync(log, 'drei\n');
    await vi.waitFor(
      () => expect(shellState().localServer!.log).toEqual(['eins', 'zwei', 'drei']),
      {
        timeout: 3000,
      },
    );
    // Connected: no attempt, the page goes away and the log is no longer followed.
    servers.servers = [local({ retry: 3 })];
    servers.events.changed();
    expect(host.state().localServer).not.toHaveProperty('retry');
    expect(host.state().localServer).not.toHaveProperty('log');
    const pushed = window().webContents.send.mock.calls.length;
    appendFileSync(log, 'vier\n');
    await new Promise((r) => setTimeout(r, 600));
    expect(window().webContents.send.mock.calls.length).toBe(pushed);
    // Down again on another page, and on quit: nothing followed.
    servers.servers = [local({ status: 'failed', bays: [] })];
    host.select(KEY);
    expect(host.state().localServer!.log).toEqual(['eins', 'zwei', 'drei', 'vier']);
    host.select('overview');
    expect(host.state().localServer).not.toHaveProperty('log');
    host.select(KEY);
    await host.stop();
    expect(host.state().localServer).not.toHaveProperty('log');
  });

  it('says it restarts while the old server is still connected', async () => {
    let finish!: () => void;
    const o = options({
      restart: vi.fn(() => new Promise<void>((r) => (finish = r))),
    });
    const { host, servers } = await started(o);
    servers.servers = [local({ sessions: 1 })];
    servers.events.changed();
    expect(host.state().localServer!.restarting).toBeUndefined();
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    const restarted = ipc.handlers.get('shell:localServer.restart')!({});
    await vi.waitFor(() => expect(host.state().localServer!.restarting).toBe(true));
    expect(host.state().localServer!.status).toBe('connected');
    finish();
    await restarted;
    expect(host.state().localServer!.restarting).toBeUndefined();
  });

  it('restarts once for many clicks and shows a failed restart (Codex 4a)', async () => {
    let finish!: (e?: Error) => void;
    const o = options({
      restart: vi.fn(() => new Promise<void>((r, j) => (finish = (e) => (e ? j(e) : r())))),
    });
    const { servers, window } = await started(o);
    servers.servers = [local({ sessions: 1 })];
    servers.events.changed();
    let answer!: (v: { response: number }) => void;
    electron.dialog.showMessageBox.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    const restart = () => ipc.handlers.get('shell:localServer.restart')!({});
    const clicks = [restart(), restart(), restart()];
    await Promise.resolve();
    answer({ response: 0 });
    await vi.waitFor(() => expect(o.localServer.restart).toHaveBeenCalledTimes(1));
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    finish(new Error('ditto failed'));
    await Promise.all(clicks);
    expect(o.localServer.restart).toHaveBeenCalledTimes(1);
    expect(electron.dialog.showMessageBox).toHaveBeenLastCalledWith(
      window(),
      expect.objectContaining({
        type: 'error',
        message: 'Lokaler Server ließ sich nicht neu starten',
        detail: 'ditto failed',
      }),
    );
  });

  it('builds the tray menu again only when it changes', async () => {
    // Every server change syncs; without a local server the menu stays as it was built.
    const { servers } = await started();
    const built = FakeTray.last!.menus;
    servers.servers = [remote];
    servers.events.changed();
    servers.events.changed();
    expect(FakeTray.last!.menus).toBe(built);
    const withLocal = await started(options());
    withLocal.servers.servers = [local({ sessions: 1 })];
    withLocal.servers.events.changed();
    const once = FakeTray.last!.menus;
    withLocal.servers.events.changed();
    expect(FakeTray.last!.menus).toBe(once);
    withLocal.servers.servers = [local({ sessions: 2 })];
    withLocal.servers.events.changed();
    expect(FakeTray.last!.menus).toBe(once + 1);
  });

  it('shows in the tray how many shells run there and restarts from it', async () => {
    const o = options();
    const { servers } = await started(o);
    servers.servers = [local({ sessions: 1 })];
    servers.events.changed();
    const labels = () => FakeTray.last!.menu!.map((i) => i.label);
    expect(labels()).toContain('Lokaler Server: 1 Shell läuft');
    servers.servers = [local({ sessions: 2 })];
    servers.events.changed();
    expect(labels()).toContain('Lokaler Server: 2 Shells laufen');
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    await FakeTray.last!.menu!.find((i) => i.label === 'Lokalen Server neu starten …')!.click!();
    expect(o.localServer.restart).toHaveBeenCalledTimes(1);
    servers.servers = [local({ status: 'failed', bays: [] })];
    servers.events.changed();
    expect(labels()).toContain('Lokaler Server läuft nicht');
  });

  it('names no server in the notifications of the local server', async () => {
    const { servers } = await started(options());
    servers.servers = [local(), remote];
    servers.events.changed();
    servers.events.notify('loc', 'dev.test.c', { title: 'Wartet' });
    servers.events.notify('srv', 'dev.test.a', { title: 'Fertig' });
    expect(FakeNotification.all.map((n) => n.options.title)).toEqual([
      'Wartet',
      'Heimserver: Fertig',
    ]);
  });
});

describe('Host: the workspaces of the local server (ADR 0036, point 11)', () => {
  it('runs the settings there, tells the page of changes and why it is empty while down', async () => {
    const { host, servers, window } = await started();
    await expect(host.localWorkspaces('view', [])).resolves.toMatchObject({
      status: 'error',
      error: 'Lokaler Server läuft nicht',
      workspaces: [],
      functions: [],
    });
    await expect(host.localWorkspaces('invite', ['team'])).rejects.toThrow(
      'Lokaler Server läuft nicht',
    );
    servers.servers = [
      { id: 'loc', name: 'Lokal', status: 'connected', bays: [], badges: {}, local: true },
    ];
    window().webContents.send.mockClear();
    servers.events.changed();
    // It came up: the page asks again.
    expect(window().webContents.send).toHaveBeenCalledWith('shell:workspaces');
    await expect(host.localWorkspaces('invite', ['team'])).resolves.toBe('from server');
    expect(servers.workspaces).toHaveBeenCalledWith('loc', 'invite', ['team']);
    window().webContents.send.mockClear();
    servers.events.local!.workspaces();
    expect(window().webContents.send).toHaveBeenCalledWith('shell:workspaces');
    // A server without workspaces (keys it cannot read): the page shows why (Codex 5).
    servers.workspaces.mockRejectedValueOnce(new Error('No workspaces on this server'));
    await expect(host.localWorkspaces('view', [])).resolves.toMatchObject({
      status: 'error',
      error: 'No workspaces on this server',
    });
  });
});

describe('Host: order of the sidebar (ADR 0038)', () => {
  const local = {
    id: 'srv',
    name: 'Lokaler Server',
    status: 'connected',
    bays: [{ id: 'dev.test.a', version: '0.1.0' }],
    badges: {},
    local: true as const,
  };

  it('sorts the bays of the app and of the local server as one list and keeps a move', async () => {
    const { host, store, servers, window } = await started({
      sidebar: ['dev.test.c', 'dev.test.a', 'dev.test.b'],
      localServer: { owns: ['dev.test.a'], uiRoots: () => [] },
    });
    servers.servers = [local];
    servers.events.changed();
    expect(host.state().order).toEqual(['dev.test.c', 'remote:srv:dev.test.a', 'dev.test.b']);
    send('shell:moveBay', window().webContents, 'remote:srv:dev.test.a', 2);
    expect(store.sidebar).toEqual(['dev.test.c', 'dev.test.b', 'dev.test.a']);
    expect(host.state().order).toEqual(['dev.test.c', 'dev.test.b', 'remote:srv:dev.test.a']);
    send('shell:moveBay', window().webContents, 'dev.test.b', 0);
    expect(store.sidebar).toEqual(['dev.test.b', 'dev.test.c', 'dev.test.a']);
    // Nothing for unknown bays, bad places or bad types.
    for (const args of [
      ['dev.test.x', 0],
      ['dev.test.b', 3],
      ['dev.test.b', -1],
      ['dev.test.b', 1.5],
      ['dev.test.b', '1'],
      [7, 0],
    ])
      send('shell:moveBay', window().webContents, ...args);
    expect(store.sidebar).toEqual(['dev.test.b', 'dev.test.c', 'dev.test.a']);
  });

  it('puts a local bay missing from the list after the others, and keeps entries it does not show', async () => {
    const { host, store, servers, window } = await started({
      sidebar: ['dev.test.gone', 'dev.test.c'],
      localServer: { owns: ['dev.test.a'], uiRoots: () => [] },
    });
    servers.servers = [local];
    servers.events.changed();
    expect(host.state().order).toEqual(['dev.test.c', 'remote:srv:dev.test.a']);
    send('shell:moveBay', window().webContents, 'remote:srv:dev.test.a', 0);
    expect(store.sidebar).toEqual(['dev.test.a', 'dev.test.c', 'dev.test.gone']);
  });

  it('moves bays up and down from their menu, the local ones too (WCAG 2.5.7)', async () => {
    const { store, servers, window } = await started({
      sidebar: ['dev.test.a', 'dev.test.c'],
      localServer: { owns: ['dev.test.a'], uiRoots: () => [] },
    });
    servers.servers = [local];
    servers.events.changed();
    send('shell:bayMenu', window().webContents, 'remote:srv:dev.test.a');
    expect(menus.at(-1)!.map((i) => [i.label, i.enabled])).toEqual([
      ['Nach oben', false],
      ['Nach unten', true],
    ]);
    clickMenu('Nach unten');
    expect(store.sidebar).toEqual(['dev.test.c', 'dev.test.a']);
    send('shell:bayMenu', window().webContents, 'dev.test.c');
    expect(menus.at(-1)!.map((i) => i.label ?? i.type)).toEqual([
      'Nach oben',
      'Nach unten',
      'separator',
      'Aus Leiste entfernen',
    ]);
    expect(menus.at(-1)!.find((i) => i.label === 'Nach unten')!.enabled).toBe(true);
    clickMenu('Nach unten');
    expect(store.sidebar).toEqual(['dev.test.a', 'dev.test.c']);
  });

  it('writes a bay that runs in the app and in the local server only once', async () => {
    const { store, servers, window } = await started({
      sidebar: ['dev.test.c', 'dev.test.a'],
      localServer: { owns: ['dev.test.a'], uiRoots: () => [] },
    });
    servers.servers = [
      {
        ...local,
        bays: [
          { id: 'dev.test.a', version: '0.1.0' },
          { id: 'dev.test.c', version: '0.1.0' },
        ],
      },
    ];
    servers.events.changed();
    send('shell:moveBay', window().webContents, 'remote:srv:dev.test.a', 0);
    expect(store.sidebar).toEqual(['dev.test.a', 'dev.test.c']);
  });

  it('moves from the place a bay has when the menu item is clicked', async () => {
    const { store, window } = await started({
      sidebar: ['dev.test.a', 'dev.test.b', 'dev.test.c'],
    });
    send('shell:bayMenu', window().webContents, 'dev.test.c');
    // Moved to the top while the menu is open: „Nach oben“ has nowhere to go.
    send('shell:moveBay', window().webContents, 'dev.test.c', 0);
    clickMenu('Nach oben');
    expect(store.sidebar).toEqual(['dev.test.c', 'dev.test.a', 'dev.test.b']);
    send('shell:shortcutMenu', window().webContents, 'unknown');
    clickMenu('Nach unten');
    expect(store.sidebar).toEqual(['dev.test.a', 'dev.test.c', 'dev.test.b']);
  });

  it('moves shortcuts by dragging and from their menu', async () => {
    const site = { id: 's1', target: 'https://example.com/' };
    const folder = { id: 's2', target: '/Users/anna/Projekte' };
    const { host, store, window } = await started({ shortcuts: [site, folder] });
    send('shell:moveShortcut', window().webContents, 's2', 0);
    expect(store.shortcuts).toEqual([folder, site]);
    expect(host.state().shortcuts.map((s) => s.id)).toEqual(['s2', 's1']);
    for (const args of [
      ['unknown', 0],
      ['s1', 2],
      ['s1', '0'],
    ])
      send('shell:moveShortcut', window().webContents, ...args);
    expect(store.shortcuts).toEqual([folder, site]);
    send('shell:shortcutMenu', window().webContents, 's1');
    expect(menus.at(-1)!.map((i) => [i.label ?? i.type, i.enabled])).toEqual([
      ['Nach oben', true],
      ['Nach unten', false],
      ['separator', undefined],
      ['Aus Leiste entfernen', undefined],
    ]);
    clickMenu('Nach oben');
    expect(store.shortcuts).toEqual([site, folder]);
  });
});
