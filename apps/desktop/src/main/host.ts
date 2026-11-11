import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  shell,
  Tray,
  WebContentsView,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type WebContents,
} from 'electron';
import {
  linuxPackages,
  parseSetupAddress,
  ServerConnections,
  setUpServer,
  sshRemote,
} from '@hangar/bridge';
import type { Bus, Grant, GrantMode } from '@hangar/bus';
import type { HangarNotification, ViewRect } from '@hangar/sdk';
import { themeCss } from '@hangar/theme';
import {
  addShortcut,
  BayRuntime,
  discoverBays,
  isUrl,
  shortcutName,
  shortcutUrl,
  type Shortcut,
  type BayLoadError,
  type BaySource,
  type HostServices,
  type LoadedBay,
} from '@hangar/host';
import { BrowserTabs, type Placement } from './browser-tabs';
import { pairWhenReady } from './local-server';
import { tailFile } from './log-tail';
import { t } from '../messages';
import { gitIdentity } from './overview';
import { askWithDialog } from './prompter';
import {
  readViewState,
  restorableBounds,
  writeViewState,
  type BayWindowState,
  type Bounds,
} from './view-state';
import {
  UPDATE_HINT_HEIGHT,
  type JobsView,
  type OverviewView,
  type PermissionsView,
  type Selection,
  type ShellState,
  type SidebarLocalServer,
} from '../shared';

const SIDEBAR_WIDTH = 64;
/** Lines of the local server's log on its page while it is down. */
const LOG_LINES = 200;

/** What a bay view talks to: a bay running here, or one on a server (ADR 0019). */
interface BayTarget {
  /** Selection and view key: the bay id, or `remote:<server>:<bay>`. */
  key: string;
  /** The local bundle whose UI the view shows. */
  bay: LoadedBay;
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  /** Only for bays running here. */
  runtime?: BayRuntime;
  /** Name of the server, only for its bays. */
  server?: string;
}

const remoteKey = (server: string, bay: string) => `remote:${server}:${bay}`;

/** `list` with the item at `from` moved to `to` (ADR 0038). */
const moved = <T>(list: T[], from: number, to: number): T[] => {
  const next = [...list];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
};

/** A whole number in `[0, length)`. */
const place = (index: unknown, length: number): index is number =>
  Number.isInteger(index) && (index as number) >= 0 && (index as number) < length;

/**
 * Folders scanned for bays. `HANGAR_BAYS_DIR` (path list) replaces the default and wins over
 * installed bays; installed ones win over the bundled ones (ADR 0034).
 */
export function bayRoots(installed: BaySource[] = []): BaySource[] {
  if (process.env.HANGAR_BAYS_DIR) {
    return [...process.env.HANGAR_BAYS_DIR.split(delimiter), ...installed];
  }
  return [
    ...installed,
    app.isPackaged ? join(app.getAppPath(), 'bays') : join(app.getAppPath(), '../../bays'),
  ];
}

/**
 * Under `HANGAR_E2E` the windows stay off the screen and never take the focus, so
 * tests do not get in the way of whoever works on the machine. Unthrottled, so
 * hidden pages still render. `HANGAR_E2E_SHOW=1` shows them.
 */
const offscreen = () => !!process.env.HANGAR_E2E && !process.env.HANGAR_E2E_SHOW;

/** Shown anyway (`maximize`, the click on a notification), an `offscreen` window stays invisible. */
const visibility = () => ({ show: !offscreen(), opacity: offscreen() ? 0 : 1 });

/** Brings a window to the front; under `offscreen` only makes it visible, without the focus. */
function toFront(win: BrowserWindow): void {
  if (offscreen()) return win.showInactive();
  win.show();
  win.focus();
}

/** Notification as recorded instead of shown when `HANGAR_E2E` is set. */
export interface RecordedNotification extends HangarNotification {
  bayId: string;
  click(): void;
}

declare global {
  var __hangarNotifications: RecordedNotification[] | undefined;
}

/** Owns the window, the bay views, the bay runtimes and the tray. */
export class Host {
  window!: BrowserWindow;
  /** Set once Hangar really quits; until then closing the window only hides it. */
  quitting = false;
  private tray?: Tray;
  /** Keeps shown notifications alive so their click handler survives GC. */
  private readonly notifications = new Set<Notification>();
  readonly runtimes = new Map<string, BayRuntime>();
  /** Bays starting from `addBay`, by id. */
  private readonly adding = new Map<string, Promise<void>>();
  private readonly views = new Map<string, WebContentsView>();
  /** Extra windows of bays (ADR 0010). */
  private readonly bayWindows = new Map<BrowserWindow, BayWindowState>();
  private errors: BayLoadError[] = [];
  private selected: Selection = null;
  /** Ids of the connected servers, to reload the job list when they change. */
  private connectedServers = '';
  /** Every bay found on disk; only those in the sidebar run (ADR 0017). */
  private found: LoadedBay[] = [];
  /** A shell modal is open: bay views and tabs are hidden so it is not covered. */
  private modal = false;
  /** Measured by the shell (wrapped text at 200 % zoom); its fixed height until then. */
  private hintHeight = UPDATE_HINT_HEIGHT;
  /** Web page tabs of bays with the `browser` host module (ADR 0015). */
  private readonly tabs = new BrowserTabs((contents) => this.placement(contents));
  /** Bays of connected servers shown with a local bundle (ADR 0019). */
  private readonly remotes = new Map<string, BayTarget>();
  /** A server bay selected before the restart or the disconnect; selected again once back. */
  private pendingSelection?: string;
  private readonly servers: ServerConnections;
  /** Bundles of the local server's runtime copies, found again when the copies change. */
  private copies: { roots: string; bays: LoadedBay[] } = { roots: '', bays: [] };
  /** The local server's last failure since it was connected: retries do not flicker. */
  private localError?: string;
  private localRestarting?: Promise<void>;
  private localStarting = false;
  /** The local server's log, followed while its page says it is down. */
  private logTail?: { lines: string[]; stop(): void };
  /** The status line of the tray menu as last built; `''` without a local server. */
  private trayShown?: string;
  /** System icons of shortcut paths as data URLs, loaded once (ADR 0027). */
  private readonly shortcutIcons = new Map<string, string>();

  /** The `ssh` command for tunnels and the setup of servers. */
  private readonly ssh: string;

  constructor(
    private readonly services: Omit<
      HostServices,
      'sendToUi' | 'badgeChanged' | 'notify' | 'browser'
    >,
    private readonly bus: Bus,
    /** `view.json`: window bounds and selection, restored on the next start. */
    private readonly viewFile: string,
    /** Ids of the bays in the sidebar, in order (`settings.json`, ADR 0017). */
    private readonly sidebar: { get(): string[]; set(ids: string[]): void },
    /** Shortcuts in the sidebar, in order (`settings.json`, ADR 0027). */
    private readonly shortcuts: { get(): Shortcut[]; set(list: Shortcut[]): void },
    /** `servers.json`: paired servers with their tokens (ADR 0019). */
    serversFile: string,
    /** The `ssh` command for server tunnels. */
    ssh: string,
    /** Active versions of installed bays (`BayStore.bayDirs`, ADR 0034). */
    private readonly installed: () => BaySource[] = () => [],
    /**
     * The local server (ADR 0036): bays it runs, never started here, the bay folders of its
     * runtime copies, where the UI of its version comes from, the version it runs, how it
     * starts anew in the version of this app, and its log.
     */
    private readonly localServer: {
      owns: string[];
      uiRoots(): string[];
      version?(): string | undefined;
      /** The build of this app the server would run after a restart, `<version>+<build id>`. */
      ready?(): string | undefined;
      restart?(): Promise<void>;
      log?: string;
    } = {
      owns: [],
      uiRoots: () => [],
    },
    /** Linux packages of the server this app ships and its version (ADR 0041). */
    private readonly linuxServer: { packages: string; version: string } = {
      packages: '',
      version: '0.0.0',
    },
  ) {
    this.ssh = ssh;
    const serverName = (id: string) => this.servers.list().find((s) => s.id === id)?.name ?? id;
    this.servers = new ServerConnections(
      serversFile,
      { name: hostname(), locale: services.locale },
      {
        changed: () => this.syncRemotes(),
        event: (server, bay, channel, payload) => {
          for (const contents of this.contentsOf(remoteKey(server, bay))) {
            contents.send('bay:event', channel, payload);
          }
        },
        ask: (server, request, signal) => askWithDialog(request, serverName(server), signal),
        // The title names the server, as the sidebar does (ADR 0019).
        notify: (server, bay, n) => {
          const local = this.servers.list().find((s) => s.id === server)?.local;
          const title = local ? n.title : `${serverName(server)}: ${n.title}`;
          this.notify(remoteKey(server, bay), { ...n, title });
        },
        jobs: () => this.jobsChanged(),
        // The bays started here, for agents of the local server (ADR 0036).
        local: {
          functions: () =>
            this.bus
              .list()
              .filter((f) => this.runtimes.has(f.bayId))
              .map(({ bayId, spec }) => ({ bayId, spec })),
          call: async (target, args, caller, signal) => {
            const bay = target.slice(0, target.indexOf('/'));
            if (!this.runtimes.has(bay)) throw new Error(`Unknown function: ${target}`);
            // Field by field: the message must not set `kind` (and with it the subject).
            const { bayId, sessionId } = caller;
            // A bay of the server, not its agents, calling what the manifest of this app's copy
            // declares in `uses` (ADR 0032).
            const declared =
              !sessionId &&
              !!this.found.find((b) => b.manifest.id === bayId)?.manifest.uses?.includes(target);
            const from = {
              kind: 'local-server' as const,
              bayId,
              ...(sessionId && { sessionId }),
              ...(declared && { declared }),
            };
            return this.bus.call(from, target, args, signal);
          },
          sessionEnded: (bayId, sessionId) => {
            this.bus.endSession(sessionId);
            // Named like the subject, apart from agents of this app (browser partitions).
            const session = { bayId: `local-server:${bayId}`, sessionId };
            for (const r of this.runtimes.values()) r.agentSessionEnded(session);
          },
          workspaces: () => this.workspacesChanged(),
        },
      },
      ssh,
    );
  }

  async start(): Promise<void> {
    const { bays, errors } = discoverBays(bayRoots(this.installed()), this.services.hangarVersion);
    this.errors = errors;
    this.found = bays;
    for (const id of this.sidebar.get()) {
      // A sidebar bay that is no longer on disk is skipped silently.
      const bay = this.startable().find((b) => b.manifest.id === id);
      if (!bay) continue;
      try {
        await this.activate(bay);
      } catch (e) {
        this.errors.push({
          dir: bay.dir,
          id: bay.manifest.id,
          name: bay.manifest.name,
          error: (e as Error).message,
        });
      }
    }
    const view = readViewState(this.viewFile);
    this.registerIpc();
    this.createWindow(view.bounds, view.maximized);
    this.createTray();
    for (const w of view.windows) {
      if (this.runtimes.has(w.bay)) this.openBayWindow(w);
    }
    // The last bay or the settings again, if still there; otherwise the overview.
    const known =
      view.selected === 'settings' ||
      this.runtimes.has(view.selected ?? '') ||
      this.isLocalKey(view.selected);
    this.selected = known ? view.selected : 'overview';
    if (view.selected?.startsWith('remote:')) this.pendingSelection = view.selected;
    this.layout();
    this.loadShortcutIcons();
    void this.servers.connectAll();
  }

  /**
   * Sets up the server on a Linux machine over ssh and pairs with it (ADR 0041). `linger`: whether
   * the service keeps running after the person logs out there; `user` names them for the hint.
   */
  async setUpServer(name: string, address: string): Promise<{ linger: boolean; user: string }> {
    const target = parseSetupAddress(address);
    const { packages, version } = this.linuxServer;
    const setup = await setUpServer(
      sshRemote(target, this.ssh),
      await linuxPackages(packages, version),
    );
    // `pair-code` is written before the bays are active; until then `/connect` answers 503.
    await pairWhenReady(() => this.servers.pairSetUp(target, name, setup));
    return { linger: setup.linger, user: setup.user };
  }

  /** Pairs with the local server in `dataDir` once; afterwards it connects like any (ADR 0036). */
  pairLocalServer(dataDir: string): Promise<string> {
    return this.servers.pairLocal(dataDir, t.localServer);
  }

  /** Appends a target unless it is already there (ADR 0027). */
  private addShortcut(target: string): void {
    this.shortcuts.set(addShortcut(this.shortcuts.get(), target, randomUUID()));
    this.pushState();
    this.loadShortcutIcons();
  }

  private loadShortcutIcons(): void {
    for (const { target } of this.shortcuts.get()) {
      if (isUrl(target) || this.shortcutIcons.has(target)) continue;
      // getFileIcon gives programs a blank icon on macOS; thumbnails are macOS and Windows only.
      (process.platform === 'linux'
        ? app.getFileIcon(target)
        : nativeImage.createThumbnailFromPath(target, { width: 48, height: 48 })
      ).then(
        (icon) => {
          this.shortcutIcons.set(target, icon.toDataURL());
          this.pushState();
        },
        // A path that is gone keeps the glyph of the sidebar.
        () => undefined,
      );
    }
  }

  private async pickShortcut(kind: unknown): Promise<boolean> {
    const result = await dialog.showOpenDialog(this.window, {
      properties: [kind === 'folder' ? 'openDirectory' : 'openFile'],
    });
    const path = result.canceled ? undefined : result.filePaths[0];
    if (path) this.addShortcut(path);
    return path !== undefined;
  }

  /** Opens a shortcut's target with the system; the renderer only names its id. */
  private async openShortcut(id: unknown): Promise<void> {
    const shortcut = this.shortcuts.get().find((s) => s.id === id);
    if (!shortcut) return;
    const { target } = shortcut;
    const error = isUrl(target)
      ? await shell.openExternal(target).then(
          () => '',
          (e: Error) => e.message,
        )
      : await shell.openPath(target);
    if (!error) return;
    await dialog.showMessageBox(this.window, {
      type: 'warning',
      message: t.shortcutFailed(shortcutName(target)),
      detail: error,
    });
  }

  private shortcutMenu(id: unknown): void {
    const list = this.shortcuts.get();
    const index = list.findIndex((s) => s.id === id);
    if (index < 0) return;
    Menu.buildFromTemplate([
      ...this.moveItems(index, list.length, (by) => {
        const from = this.shortcuts.get().findIndex((s) => s.id === id);
        this.moveShortcut(id, from + by);
      }),
      { type: 'separator' },
      {
        label: t.removeBay,
        click: () => {
          this.shortcuts.set(this.shortcuts.get().filter((s) => s.id !== id));
          this.pushState();
        },
      },
    ]).popup({ window: this.window });
  }

  /** The local bay or server bay behind a selection key. */
  private target(key: string): BayTarget | undefined {
    const runtime = this.runtimes.get(key);
    if (!runtime) return this.remotes.get(key);
    return { key, bay: runtime.bay, runtime, invoke: async (c, a) => runtime.handleUi(c, a) };
  }

  /** Creates and removes views for server bays after a server connected or went away. */
  private syncRemotes(): void {
    // Quitting closes the connections after the window is gone; nothing left to update.
    if (this.window?.isDestroyed()) return;
    const wanted = new Map<string, BayTarget>();
    for (const server of this.servers.list()) {
      if (server.status !== 'connected') continue;
      for (const info of server.bays) {
        const bay = this.localBundle(info);
        if (!bay) continue;
        const key = remoteKey(server.id, info.id);
        wanted.set(
          key,
          this.remotes.get(key) ?? {
            key,
            bay,
            // The local server's bays work as if they ran here: folder dialog, no path form.
            ...(!server.local && { server: server.name }),
            invoke: async (channel, args) => {
              // The one channel that opens a dialog (ADR 0036, point 6).
              if (server.local && channel === 'project.add' && typeof args[0] !== 'string') {
                const path = await this.services.pickFolder(undefined);
                if (!path) return undefined;
                args = [path];
              }
              return this.servers.invoke(server.id, info.id, channel, args);
            },
          },
        );
      }
    }
    for (const key of this.remotes.keys()) if (!wanted.has(key)) this.closeView(key);
    for (const [key, target] of wanted) {
      if (this.remotes.has(key)) continue;
      this.remotes.set(key, target);
      if (this.window) this.createView(key, target.bay);
    }
    // A server came or went, with or without bays shown here: its jobs too (phase 11d).
    const connected = this.servers
      .list()
      .filter((s) => s.status === 'connected')
      .map((s) => s.id)
      .join();
    if (connected !== this.connectedServers) {
      this.connectedServers = connected;
      this.jobsChanged();
      // The local server holds the workspaces (ADR 0036, point 11).
      this.workspacesChanged();
    }
    if (!this.window) return;
    // A bay of the local server stays selected while it is down: its page says so.
    if (
      this.selected?.startsWith('remote:') &&
      !wanted.has(this.selected) &&
      !this.isLocalKey(this.selected)
    ) {
      this.pendingSelection = this.selected;
      this.selected = 'overview';
    }
    if (this.pendingSelection && wanted.has(this.pendingSelection)) {
      this.selected = this.pendingSelection;
      this.pendingSelection = undefined;
    }
    this.layout();
    this.setAppBadge();
    this.updateTray();
    this.pushState();
  }

  /** The local server as the sidebar shows it; none without one (ADR 0036). */
  private localServerState(): SidebarLocalServer | undefined {
    if (this.localServer.owns.length === 0) return undefined;
    const server = this.servers.list().find((s) => s.local);
    const id = server?.id ?? 'local';
    const live = server?.status ?? 'connecting';
    if (live === 'connected') this.localError = undefined;
    else if (live === 'failed' && !this.localStarting) this.localError = server!.error;
    const status =
      live === 'connected'
        ? live
        : this.localStarting
          ? 'connecting'
          : this.localError !== undefined
            ? 'failed'
            : live;
    const error = status === 'failed' ? this.localError : undefined;
    const shown = (info: { id: string }) => this.remotes.get(remoteKey(id, info.id));
    // While it is down, the bays it runs stay in the sidebar, from the bundles of this app.
    const bays =
      status === 'connected'
        ? server!.bays.flatMap((info) => {
            const target = shown(info);
            return target ? [{ key: target.key, bay: target.bay, id: info.id }] : [];
          })
        : this.found
            .filter((b) => this.localServer.owns.includes(b.manifest.id))
            .map((bay) => ({ key: remoteKey(id, bay.manifest.id), bay, id: bay.manifest.id }));
    const running = this.localServer.version?.();
    const ready = this.localServer.ready?.() ?? this.services.hangarVersion;
    // The build id only where it is the difference: a new build of the same version.
    const plain = (v: string) => v.split('+')[0]!;
    const update =
      running &&
      running !== ready &&
      (plain(running) === plain(ready)
        ? { running, ready }
        : { running: plain(running), ready: plain(ready) });
    return {
      status,
      ...(error && { error }),
      bays: bays.map(({ key, bay, id: bayId }) => ({
        id: key,
        name: bay.manifest.name,
        icon: this.icon(bay),
        badge: status === 'connected' ? (server!.badges[bayId] ?? 0) : 0,
      })),
      ...(update && { update }),
      ...(this.localStarting && { restarting: true as const }),
      ...(status !== 'connected' && server?.retry && { retry: server.retry }),
      ...(this.logTail && { log: this.logTail.lines }),
    };
  }

  /** Follows the log while the page of a selected bay of the local server says it is down. */
  private followLog(): void {
    const local = this.localServerState();
    const wanted =
      !!this.localServer.log &&
      !!local &&
      local.status !== 'connected' &&
      local.bays.some((b) => b.id === this.selected);
    if (wanted === !!this.logTail) return;
    if (!wanted) return this.stopLog();
    const tail = { lines: [] as string[], stop: () => {} };
    this.logTail = tail;
    tail.stop = tailFile(this.localServer.log!, LOG_LINES, (lines) => {
      tail.lines = lines;
      if (this.logTail === tail) this.pushState();
    });
  }

  private stopLog(): void {
    this.logTail?.stop();
    this.logTail = undefined;
  }

  private isLocalKey(key: string | null | undefined): boolean {
    return !!key && !!this.localServerState()?.bays.some((b) => b.id === key);
  }

  /** Starts the local server anew in this version; its shells end, so it asks first. Clicks
   * meanwhile join the running restart. */
  private restartLocalServer(): Promise<void> {
    this.localRestarting ??= this.restartOnce().finally(() => {
      this.localRestarting = undefined;
      this.pushState();
    });
    return this.localRestarting;
  }

  private async restartOnce(): Promise<void> {
    const server = this.servers.list().find((s) => s.local);
    // Unknown unless connected and told: an old server may still run shells.
    const shells = server?.status === 'connected' ? server.sessions : undefined;
    if (shells !== 0) {
      const { response } = await dialog.showMessageBox(this.window, {
        type: 'warning',
        message: t.restartLocalServerTitle,
        detail: t.restartLocalServerDetail(shells),
        buttons: [t.restart, t.cancel],
        defaultId: 1,
        cancelId: 1,
      });
      if (response !== 0) return;
    }
    this.localError = undefined;
    this.localStarting = true;
    this.pushState();
    try {
      await this.localServer.restart?.();
    } catch (e) {
      await dialog.showMessageBox(this.window, {
        type: 'error',
        message: t.restartLocalServerFailed,
        detail: (e as Error).message,
      });
    } finally {
      this.localStarting = false;
    }
  }

  /** Found bundles without those the local server runs. */
  private startable(): LoadedBay[] {
    return this.found.filter((b) => !this.localServer.owns.includes(b.manifest.id));
  }

  /** The bundle found here, or in a runtime copy of the local server, matching a server bay. */
  private localBundle(info: { id: string; version: string }): LoadedBay | undefined {
    const match = (b: LoadedBay) =>
      b.manifest.id === info.id && b.manifest.version === info.version;
    const here = this.found.find(match);
    if (here) return here;
    const roots = this.localServer.uiRoots();
    if (roots.join('\n') !== this.copies.roots) {
      this.copies = {
        roots: roots.join('\n'),
        // One root at a time: across roots the first bay of an id would hide other versions.
        bays: roots.flatMap((r) => discoverBays([r], this.services.hangarVersion).bays),
      };
    }
    return this.copies.bays.find(match);
  }

  /** Closes a bay's view and windows. */
  private closeView(key: string): void {
    for (const [win, w] of this.bayWindows) if (w.bay === key) win.destroy();
    const view = this.views.get(key);
    if (view) {
      this.window.contentView.removeChildView(view);
      view.webContents.close();
      this.views.delete(key);
    }
    this.remotes.delete(key);
  }

  /** Starts a bay's main part; on failure releases what it started and throws. */
  private async activate(bay: LoadedBay): Promise<BayRuntime> {
    const runtime = new BayRuntime(bay, {
      ...this.services,
      sendToUi: (id, channel, payload) => {
        for (const contents of this.contentsOf(id)) contents.send('bay:event', channel, payload);
      },
      badgeChanged: () => this.badgeChanged(),
      notify: (id, n) => this.notify(id, n),
      browser: (id) => this.tabs.forBay(id),
      unregisterAgentSession: (bayId, sessionId) => {
        this.services.unregisterAgentSession(bayId, sessionId);
        for (const r of this.runtimes.values()) r.agentSessionEnded({ bayId, sessionId });
      },
    });
    try {
      await runtime.activate();
    } catch (e) {
      // Release what the bay started before it failed (shells, timers).
      await runtime.deactivate().catch(() => undefined);
      this.bus.unregisterBay(bay.manifest.id);
      throw new Error(`Start failed: ${(e as Error).message}`, { cause: e });
    }
    this.runtimes.set(bay.manifest.id, runtime);
    return runtime;
  }

  /** Starts a found bay, puts it at the end of the sidebar and selects it (ADR 0017). */
  addBay(id: string): Promise<void> {
    if (this.runtimes.has(id)) return Promise.resolve(this.select(id));
    // Adding again while the bay starts waits for that start instead of starting it twice.
    const running = this.adding.get(id);
    if (running) return running;
    const adding = this.startBay(id).finally(() => this.adding.delete(id));
    this.adding.set(id, adding);
    return adding;
  }

  private async startBay(id: string): Promise<void> {
    const bay = this.startable().find((b) => b.manifest.id === id);
    if (!bay) throw new Error(`Unknown bay "${id}"`);
    this.createView(id, (await this.activate(bay)).bay);
    this.errors = this.errors.filter((e) => e.id !== id);
    this.sidebar.set([...this.sidebar.get().filter((b) => b !== id), id]);
    this.select(id);
    this.servers.offerAgain();
  }

  /** Stops a bay and takes it out of the sidebar; its data folder stays. */
  async removeBay(id: string): Promise<void> {
    // Removed during its start: wait for it, or the start would put the bay back afterwards.
    await this.adding.get(id)?.catch(() => undefined);
    const runtime = this.runtimes.get(id);
    this.sidebar.set(this.sidebar.get().filter((b) => b !== id));
    this.errors = this.errors.filter((e) => e.id !== id);
    if (runtime) {
      this.closeView(id);
      this.runtimes.delete(id);
      this.tabs.closeBay(id);
      await runtime.deactivate().catch((e) => console.error(`Bay ${id}: deactivate failed`, e));
      this.bus.unregisterBay(id);
      this.badgeChanged();
      this.servers.offerAgain();
    }
    if (this.selected === id) this.select('overview');
    else this.pushState();
  }

  /** Menu of a bay of the app or of the local server; only the first can be removed. */
  private bayMenu(id: string): void {
    const order = this.order();
    const index = order.findIndex((b) => b.id === id);
    if (index < 0) return;
    const move = this.moveItems(index, order.length, (by) =>
      this.moveBay(id, this.order().findIndex((b) => b.id === id) + by),
    );
    Menu.buildFromTemplate(
      this.runtimes.has(id)
        ? [
            ...move,
            { type: 'separator' },
            { label: t.removeBay, click: () => void this.removeBay(id) },
          ]
        : move,
    ).popup({ window: this.window });
  }

  /**
   * „Nach oben“ and „Nach unten“: moving without dragging (WCAG 2.5.7, ADR 0038). `move` finds
   * the place at the click; the sidebar may have changed while the menu was open.
   */
  private moveItems(index: number, length: number, move: (by: number) => void) {
    return [
      { label: t.moveUp, enabled: index > 0, click: () => move(-1) },
      { label: t.moveDown, enabled: index < length - 1, click: () => move(1) },
    ];
  }

  /**
   * Bays of the app and of the local server in the order of `settings.json` `bays`; a bay
   * missing there comes after the others (ADR 0038). `id` is what the sidebar shows.
   */
  private order(): { id: string; bayId: string }[] {
    const sidebar = this.sidebar.get();
    const rank = (bayId: string) => {
      const i = sidebar.indexOf(bayId);
      return i < 0 ? sidebar.length : i;
    };
    return [
      ...[...this.runtimes.keys()].map((id) => ({ id, bayId: id })),
      ...(this.localServerState()?.bays ?? []).map(({ id }) => ({
        id,
        bayId: id.slice(id.lastIndexOf(':') + 1),
      })),
    ].sort((a, b) => rank(a.bayId) - rank(b.bayId));
  }

  /** Puts a bay of the sidebar at `index`; entries it does not show stay at the end. */
  private moveBay(id: unknown, index: unknown): void {
    const order = this.order();
    const from = order.findIndex((b) => b.id === id);
    if (from < 0 || !place(index, order.length)) return;
    // A bay may run in the app and in the local server: written once.
    const ids = [...new Set(moved(order, from, index).map((b) => b.bayId))];
    this.sidebar.set([...ids, ...this.sidebar.get().filter((b) => !ids.includes(b))]);
    this.pushState();
  }

  private moveShortcut(id: unknown, index: unknown): void {
    const list = this.shortcuts.get();
    const from = list.findIndex((s) => s.id === id);
    if (from < 0 || !place(index, list.length)) return;
    this.shortcuts.set(moved(list, from, index));
    this.pushState();
  }

  private serverMenu(id: string): void {
    const server = this.servers.list().find((s) => s.id === id);
    if (!server) return;
    const live = server.status === 'connected' || server.status === 'connecting';
    Menu.buildFromTemplate([
      live
        ? { label: t.disconnect, click: () => this.servers.disconnect(id) }
        : { label: t.connect, click: () => void this.servers.connect(id) },
      { type: 'separator' },
      { label: t.removeServer, click: () => this.servers.remove(id) },
    ]).popup({ window: this.window });
  }

  private setModal(open: boolean): void {
    this.modal = open;
    this.layout();
  }

  async stop(): Promise<void> {
    // Saved on quit only; a crash loses the last window position.
    writeViewState(this.viewFile, {
      bounds: this.window.getNormalBounds(),
      maximized: this.window.isMaximized(),
      selected: this.selected,
      windows: [...this.bayWindows].map(([win, w]) => ({ ...w, bounds: win.getNormalBounds() })),
    });
    this.stopLog();
    this.servers.closeAll();
    for (const runtime of this.runtimes.values()) await runtime.deactivate();
  }

  /** Brings the window to the front, optionally switching to a bay. */
  show(selection?: Selection): void {
    if (selection !== undefined) this.select(selection);
    if (this.window.isMinimized()) this.window.restore();
    toFront(this.window);
  }

  select(selection: Selection): void {
    this.selected = selection;
    this.layout();
    this.pushState();
  }

  state(): ShellState {
    return {
      bays: [...this.runtimes.values()].map((r) => ({
        id: r.id,
        name: r.bay.manifest.name,
        icon: this.icon(r.bay),
        badge: r.badge,
      })),
      order: this.order().map((b) => b.id),
      errors: this.bayErrors(),
      servers: this.servers
        .list()
        .filter((s) => !s.local)
        .map((server) => ({
          id: server.id,
          name: server.name,
          status: server.status,
          ...(server.error && { error: server.error }),
          bays: server.bays.flatMap((info) => {
            const target = this.remotes.get(remoteKey(server.id, info.id));
            if (!target) return [];
            const { bay } = target;
            return [
              {
                id: target.key,
                name: bay.manifest.name,
                icon: this.icon(bay),
                badge: server.badges[info.id] ?? 0,
              },
            ];
          }),
          errors: server.bays
            .filter((info) => !this.remotes.has(remoteKey(server.id, info.id)))
            .map((info) => {
              const local = this.found.find((b) => b.manifest.id === info.id);
              return {
                label: local?.manifest.name ?? info.id,
                error: local
                  ? t.versionMismatch(info.version, local.manifest.version)
                  : t.bayMissing,
              };
            }),
        })),
      ...(this.localServerState() && { localServer: this.localServerState() }),
      shortcuts: this.shortcuts.get().map(({ id, target }) => {
        const icon = this.shortcutIcons.get(target);
        return {
          id,
          name: shortcutName(target),
          target,
          url: isUrl(target),
          ...(icon && { icon }),
        };
      }),
      selected: this.selected,
      available: this.startable()
        .filter((b) => !this.runtimes.has(b.manifest.id))
        .map((b) => ({ id: b.manifest.id, name: b.manifest.name, icon: this.icon(b) })),
    };
  }

  private icon(bay: LoadedBay): string {
    return `data:image/svg+xml;base64,${readFileSync(join(bay.dir, bay.manifest.icon)).toString('base64')}`;
  }

  private bayErrors() {
    return this.errors.map((e) => ({ label: e.name ?? e.id ?? e.dir, error: e.error }));
  }

  async overview(): Promise<OverviewView> {
    return {
      version: this.services.hangarVersion,
      git: await gitIdentity(),
      bays: [...this.runtimes.values()].map(({ bay: { manifest } }) => ({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
      })),
      errors: this.bayErrors(),
    };
  }

  permissions(): PermissionsView {
    return {
      bays: [...this.runtimes.values()].map((r) => ({ id: r.id, name: r.bay.manifest.name })),
      functions: this.bus.list().map((f) => ({
        id: f.id,
        bayId: f.bayId,
        sensitive: f.spec.sensitive,
        ...(f.spec.description && { description: f.spec.description }),
      })),
      grants: this.bus.grants().map((g) => {
        const sessionLabel = g.sessionId && this.runtimes.get(g.subject)?.sessionLabel(g.sessionId);
        return sessionLabel ? { ...g, sessionLabel } : g;
      }),
    };
  }

  async jobs(): Promise<JobsView> {
    const connected = this.servers.list().filter((s) => s.status === 'connected');
    return {
      // Found bundles too: they name the bays of server jobs.
      bays: [
        ...[...this.runtimes.values()].map((r) => r.bay),
        ...this.found.filter((b) => !this.runtimes.has(b.manifest.id)),
      ].map(({ manifest }) => ({ id: manifest.id, name: manifest.name })),
      jobs: this.services.scheduler.list(),
      servers: await Promise.all(
        connected.map(({ id, name }) =>
          this.servers.jobs(id).then(
            (jobs) => ({ id, name, jobs }),
            (e: Error) => ({ id, name, jobs: [], error: e.message }),
          ),
        ),
      ),
    };
  }

  /** Tells the settings page to reload the job list. */
  /** Settings → Workspaces on the local server's workspaces (ADR 0036, point 11). */
  async localWorkspaces(action: string, args: (string | boolean)[]): Promise<unknown> {
    const server = this.servers.list().find((s) => s.local && s.status === 'connected');
    if (action !== 'view') {
      if (!server) throw new Error(t.localServerDown);
      return this.servers.workspaces(server.id, action, args);
    }
    // The page says why it is empty: server down, or without workspaces (Codex).
    const failed = (error: string) => ({
      status: 'error',
      error,
      name: '',
      fingerprint: '',
      workspaces: [],
      functions: [],
    });
    if (!server) return failed(t.localServerDown);
    return this.servers.workspaces(server.id, action, args).catch((e: Error) => failed(e.message));
  }

  /** Workspaces, members or the relay connection changed (ADR 0030). */
  workspacesChanged(): void {
    if (this.window?.isDestroyed() === false) this.window.webContents.send('shell:workspaces');
  }

  jobsChanged(): void {
    if (this.window?.isDestroyed() === false) this.window.webContents.send('shell:jobs');
  }

  /** System notification; clicking it brings the bay to the front. */
  notify(bayId: string, n: HangarNotification): void {
    const click = () => this.show(bayId);
    if (process.env.HANGAR_E2E) {
      (globalThis.__hangarNotifications ??= []).push({ bayId, ...n, click });
      return;
    }
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title: n.title, body: n.body ?? '' });
    this.notifications.add(notification);
    notification.on('click', click);
    notification.on('close', () => this.notifications.delete(notification));
    notification.show();
  }

  private badgeChanged(): void {
    this.setAppBadge();
    this.pushState();
  }

  /** Badges of the bays here and of the connected servers' bays shown in the sidebar. */
  private setAppBadge(): void {
    let total = 0;
    for (const r of this.runtimes.values()) total += r.badge;
    for (const server of this.servers.list()) {
      for (const info of server.bays) {
        if (this.remotes.has(remoteKey(server.id, info.id))) total += server.badges[info.id] ?? 0;
      }
    }
    app.setBadgeCount(total);
  }

  pushState(): void {
    // Bays may set badges while they activate, before the window exists.
    if (!this.window || this.window.isDestroyed()) return;
    this.followLog();
    this.window.webContents.send('shell:state', this.state());
  }

  private createWindow(saved: Bounds | undefined, maximized: boolean): void {
    const bounds = restorableBounds(
      saved,
      screen.getAllDisplays().map((d) => d.workArea),
    ) ?? { width: 1280, height: 820 };
    this.window = new BrowserWindow({
      ...bounds,
      minWidth: 640,
      minHeight: 400,
      title: 'Hangar',
      backgroundColor: '#18181b',
      // macOS: the click that activates the window also reaches the page, so one click
      // into a terminal focuses it.
      acceptFirstMouse: true,
      ...visibility(),
      webPreferences: {
        preload: join(__dirname, '../preload/shell.js'),
        contextIsolation: true,
        sandbox: true,
        ...(offscreen() && { backgroundThrottling: false }),
      },
    });
    if (process.env.ELECTRON_RENDERER_URL) {
      void this.window.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      void this.window.loadFile(join(__dirname, '../renderer/index.html'));
    }
    // Clicks go to the windows below; tests click through CDP.
    if (offscreen()) this.window.setIgnoreMouseEvents(true);
    if (maximized) this.window.maximize();
    this.window.on('resize', () => this.layout());
    this.window.on('close', (e) => {
      if (this.quitting) return;
      e.preventDefault();
      this.window.hide();
    });

    for (const runtime of this.runtimes.values()) this.createView(runtime.id, runtime.bay);
    for (const target of this.remotes.values()) this.createView(target.key, target.bay);
    this.tabs.attach(this.window);
  }

  private createView(key: string, bay: LoadedBay): void {
    const view = new WebContentsView({
      webPreferences: this.bayPreferences(key),
    });
    this.loadBayUi(view.webContents, bay);
    view.setVisible(false);
    this.window.contentView.addChildView(view);
    this.views.set(key, view);
  }

  /** A server bay gets its own partition, apart from the same bay running here. */
  private bayPreferences(key: string) {
    return {
      preload: join(__dirname, '../preload/bay.js'),
      partition: `persist:bay:${key}`,
      contextIsolation: true,
      sandbox: true,
      ...(offscreen() && { backgroundThrottling: false }),
    };
  }

  private loadBayUi(contents: WebContents, bay: LoadedBay, window?: string): void {
    contents.on('dom-ready', () => void contents.insertCSS(themeCss));
    contents.on('will-navigate', (e) => e.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    const ui = join(bay.dir, bay.manifest.ui);
    void contents.loadFile(ui, window === undefined ? undefined : { query: { window } });
  }

  /** The bay's view and its extra windows. */
  private contentsOf(bay: string): WebContents[] {
    const view = this.views.get(bay);
    return [
      ...(view ? [view.webContents] : []),
      ...[...this.bayWindows]
        .filter(([win, w]) => w.bay === bay && !win.isDestroyed())
        .map(([win]) => win.webContents),
    ];
  }

  private windowKeys(bay: string): string[] {
    return [...this.bayWindows.values()].filter((w) => w.bay === bay).map((w) => w.key);
  }

  /** Opens a window of a bay, or brings it to the front if it is already open. */
  private openBayWindow(state: BayWindowState): void {
    for (const [win, w] of this.bayWindows) {
      if (w.bay === state.bay && w.key === state.key) {
        toFront(win);
        return;
      }
    }
    const target = this.target(state.bay)!;
    const bounds = restorableBounds(
      state.bounds,
      screen.getAllDisplays().map((d) => d.workArea),
    ) ?? { width: 960, height: 640 };
    const win = new BrowserWindow({
      ...bounds,
      minWidth: 480,
      minHeight: 320,
      title: state.title,
      backgroundColor: '#18181b',
      acceptFirstMouse: true,
      ...visibility(),
      webPreferences: this.bayPreferences(state.bay),
    });
    if (offscreen()) win.setIgnoreMouseEvents(true);
    // The page title would replace the one the bay chose.
    win.on('page-title-updated', (e) => e.preventDefault());
    this.bayWindows.set(win, { bay: state.bay, key: state.key, title: state.title });
    win.on('closed', () => {
      this.bayWindows.delete(win);
      // Quitting closes every window; the list was saved in stop() and must not shrink here.
      if (!this.quitting) this.windowsChanged(state.bay);
    });
    this.loadBayUi(win.webContents, target.bay, state.key);
    this.windowsChanged(state.bay);
  }

  private windowsChanged(bay: string): void {
    const keys = this.windowKeys(bay);
    for (const contents of this.contentsOf(bay)) contents.send('bay:windows', keys);
  }

  private createTray(): void {
    // `…Template.png` is recoloured by macOS for light and dark menu bars.
    this.tray = new Tray(
      nativeImage.createFromPath(join(app.getAppPath(), 'resources', 'trayTemplate.png')),
    );
    this.tray.setToolTip('Hangar');
    this.updateTray();
    this.tray.on('click', () => this.show());
  }

  /** The tray menu; with a local server, how many shells run there (ADR 0036). */
  private updateTray(): void {
    if (!this.tray) return;
    const local = this.localServerState();
    const server = this.servers.list().find((s) => s.local);
    const status =
      local?.status === 'connected'
        ? t.localServerShells(server?.sessions ?? 0)
        : local?.status === 'connecting'
          ? t.localServerStarting
          : t.localServerDown;
    // Called on every server change: build only what changed.
    const shown = local ? status : '';
    if (shown === this.trayShown) return;
    this.trayShown = shown;
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: t.open, click: () => this.show() },
        ...(local
          ? ([
              { type: 'separator' },
              { label: status, enabled: false },
              { label: t.restartLocalServerMenu, click: () => this.restartLocalServer() },
            ] as const)
          : []),
        { type: 'separator' },
        { label: t.quit, click: () => app.quit() },
      ]),
    );
  }

  private layout(): void {
    const [width, height] = this.window.getContentSize() as [number, number];
    // The hint „Neue Version bereit“ sits above a bay of the local server.
    const hint =
      this.isLocalKey(this.selected) && this.localServerState()?.update ? this.hintHeight : 0;
    for (const [id, view] of this.views) {
      const y = id === this.selected ? hint : 0;
      view.setBounds({ x: SIDEBAR_WIDTH, y, width: width - SIDEBAR_WIDTH, height: height - y });
      view.setVisible(id === this.selected && !this.modal);
    }
    this.tabs.refresh();
  }

  /** Where a bay view or bay window sits, for tabs shown over it. */
  private placement(contents: WebContents): Placement | undefined {
    for (const [id, view] of this.views) {
      if (view.webContents === contents) {
        return {
          window: this.window,
          offset: view.getBounds(),
          visible: () => id === this.selected && !this.modal,
        };
      }
    }
    for (const win of this.bayWindows.keys()) {
      if (!win.isDestroyed() && win.webContents === contents) {
        return { window: win, offset: { x: 0, y: 0 }, visible: () => true };
      }
    }
    return undefined;
  }

  private targetFor(event: Pick<IpcMainInvokeEvent, 'sender'>): BayTarget {
    for (const [key, view] of this.views) {
      if (view.webContents.id === event.sender.id) return this.target(key)!;
    }
    for (const [win, w] of this.bayWindows) {
      if (!win.isDestroyed() && win.webContents.id === event.sender.id) {
        return this.target(w.bay)!;
      }
    }
    throw new Error('Unknown sender');
  }

  private registerIpc(): void {
    ipcMain.handle('shell:state', () => this.state());
    ipcMain.on('shell:select', (_e, selection: Selection) => this.select(selection));
    ipcMain.handle('shell:addBay', (_e, id: unknown) => {
      if (typeof id !== 'string') throw new Error('Invalid bay');
      return this.addBay(id);
    });
    ipcMain.on('shell:bayMenu', (_e, id: unknown) => {
      if (typeof id === 'string') this.bayMenu(id);
    });
    ipcMain.on('shell:moveBay', (_e, id: unknown, index: unknown) => this.moveBay(id, index));
    ipcMain.on('shell:moveShortcut', (_e, id: unknown, index: unknown) =>
      this.moveShortcut(id, index),
    );
    ipcMain.on('shell:modal', (_e, open: unknown) => this.setModal(open === true));
    ipcMain.on('shell:hintHeight', (e, px: unknown) => {
      // CSS pixels of the shell; above 1000 is no hint any more.
      if (typeof px !== 'number' || !(px >= 0 && px <= 1000)) return;
      this.hintHeight = Math.ceil(px * e.sender.getZoomFactor());
      this.layout();
    });
    ipcMain.handle('shell:server.probe', (_e, address: unknown) =>
      this.servers.probe(String(address)),
    );
    ipcMain.handle(
      'shell:server.pair',
      async (_e, probeId: unknown, name: unknown, code: unknown) => {
        await this.servers.pair(String(probeId), String(name), String(code));
      },
    );
    ipcMain.handle('shell:server.setup', (_e, name: unknown, address: unknown) =>
      this.setUpServer(String(name), String(address)),
    );
    ipcMain.on('shell:server.cancel', (_e, probeId: unknown) =>
      this.servers.cancel(String(probeId)),
    );
    ipcMain.on('shell:serverMenu', (_e, id: unknown) => this.serverMenu(String(id)));
    ipcMain.handle('shell:localServer.restart', () => this.restartLocalServer());
    ipcMain.on('shell:localServer.log', () => {
      if (this.localServer.log) void shell.openPath(this.localServer.log);
    });
    ipcMain.handle('shell:shortcut.pick', (_e, kind: unknown) => this.pickShortcut(kind));
    ipcMain.handle('shell:shortcut.url', (_e, url: unknown) =>
      this.addShortcut(shortcutUrl(String(url))),
    );
    ipcMain.on('shell:shortcut.open', (_e, id: unknown) => void this.openShortcut(id));
    ipcMain.on('shell:shortcutMenu', (_e, id: unknown) => this.shortcutMenu(id));
    ipcMain.handle('shell:overview', () => this.overview());
    ipcMain.handle('shell:permissions', () => this.permissions());
    ipcMain.handle('shell:revoke', (_e, g: Grant) =>
      this.bus.revoke(g.subject, g.target, g.sessionId),
    );
    ipcMain.handle('shell:setGrant', (_e, subject: string, target: string, mode: GrantMode) =>
      this.bus.setMode(subject, target, mode),
    );
    const { scheduler } = this.services;
    ipcMain.handle('shell:jobs', () => this.jobs());
    // With `server`: a job of that connected server (phase 11d).
    ipcMain.handle('shell:job.pause', (_e, id: string, paused: boolean, server?: string) =>
      server
        ? this.servers.job(server, paused ? 'pause' : 'resume', id)
        : scheduler.setPaused(id, paused),
    );
    ipcMain.handle('shell:job.run', async (_e, id: string, server?: string) =>
      server ? this.servers.job(server, 'run', id) : void (await scheduler.runNow(id)),
    );
    ipcMain.handle('shell:job.remove', (_e, id: string, server?: string) =>
      server ? this.servers.job(server, 'remove', id) : scheduler.remove(id),
    );
    // Synchronous like the locale: the preload needs it before the bay UI starts.
    ipcMain.on('bay:server', (e) => {
      try {
        e.returnValue = this.targetFor(e).server ?? null;
      } catch {
        e.returnValue = null;
      }
    });
    ipcMain.handle('bay:invoke', (e, channel: string, args: unknown[]) =>
      this.targetFor(e).invoke(channel, args),
    );
    ipcMain.handle('bay:window.open', (e, key: unknown, title: unknown) => {
      if (typeof key !== 'string' || typeof title !== 'string') throw new Error('Invalid window');
      this.openBayWindow({ bay: this.targetFor(e).key, key, title });
    });
    ipcMain.handle('bay:window.close', (e, key: unknown) => {
      const bay = this.targetFor(e).key;
      for (const [win, w] of this.bayWindows) if (w.bay === bay && w.key === key) win.close();
    });
    ipcMain.handle('bay:window.list', (e) => this.windowKeys(this.targetFor(e).key));
    ipcMain.handle('bay:browser.show', (e, id: unknown, rect: unknown) => {
      const runtime = this.targetFor(e).runtime;
      if (!runtime?.hasHostModule('browser')) throw new Error('Bay has no host module "browser"');
      const valid =
        (id === undefined || typeof id === 'string') &&
        (rect === undefined ||
          (typeof rect === 'object' &&
            rect !== null &&
            ['x', 'y', 'width', 'height'].every((k) =>
              Number.isFinite((rect as Record<string, unknown>)[k]),
            )));
      if (!valid) throw new Error('Invalid tab placement');
      this.tabs.show(e.sender, runtime.id, id as string | undefined, rect as ViewRect | undefined);
    });
  }
}

/**
 * Data folder to use instead of Electron's: `HANGAR_USER_DATA`, else "Hangar Dev" when not
 * packaged, so a development run never touches the profile (and sessions) in daily use.
 */
export function userDataDir(): string | undefined {
  if (process.env.HANGAR_USER_DATA) return process.env.HANGAR_USER_DATA;
  return app.isPackaged ? undefined : join(app.getPath('appData'), 'Hangar Dev');
}

/** Opens the native folder picker; attached to `parent` so it opens in front of it. */
export async function pickFolder(
  options?: { title?: string },
  parent?: BrowserWindow,
): Promise<string | undefined> {
  const settings: OpenDialogOptions = {
    title: options?.title,
    properties: ['openDirectory', 'createDirectory'],
  };
  const result = await (parent
    ? dialog.showOpenDialog(parent, settings)
    : dialog.showOpenDialog(settings));
  return result.canceled ? undefined : result.filePaths[0];
}
