import { randomUUID } from 'node:crypto';
import { session, WebContentsView, type BrowserWindow, type WebContents } from 'electron';
import type { BayBrowser, BrowserTab, BrowserTabOptions, ViewRect } from '@hangar/sdk';

const LOAD_TIMEOUT_MS = 30_000;
/** Size of a tab that was never shown, so pages lay out and screenshots have content. */
const HIDDEN_SIZE = { width: 1280, height: 800 };
const ERR_ABORTED = -3;
/** Zoom level steps of the keys, as the app menu takes them; 0 resets. */
const ZOOM_KEYS: Record<string, number> = { '+': 0.5, '=': 0.5, '-': -0.5, '0': 0 };

export const allowedUrl = (url: string) => /^(https?:\/\/|about:blank$)/i.test(url);

/** Where a bay UI sits: its window, its offset in there, and whether it is visible now. */
export interface Placement {
  window: BrowserWindow;
  offset: { x: number; y: number };
  visible(): boolean;
}

interface Tab {
  id: string;
  bayId: string;
  partition: string;
  options: BrowserTabOptions;
  view: WebContentsView;
  parent?: BrowserWindow;
  error?: string;
  openerId?: string;
  /** The bay UI the tab is shown in, if any. */
  shownIn?: { contents: WebContents; placement: Placement };
}

/** Web page tabs of all bays with the `browser` host module (ADR 0015). */
export class BrowserTabs {
  private readonly tabs = new Map<string, Tab>();
  private readonly listeners = new Map<string, Set<(tabs: BrowserTab[]) => void>>();
  private readonly prepared = new Set<string>();
  private mainWindow?: BrowserWindow;

  constructor(private readonly placementOf: (contents: WebContents) => Placement | undefined) {}

  /** Hidden tabs live in the main window; tabs opened before it existed move there now. */
  attach(window: BrowserWindow): void {
    this.mainWindow = window;
    for (const tab of this.tabs.values()) if (!tab.parent) this.moveTo(tab, window);
  }

  forBay(bayId: string): BayBrowser {
    return {
      open: (url, options) => this.open(bayId, url, options ?? {}),
      navigate: (id, url) => this.load(this.tab(bayId, id), url),
      back: (id) => this.tab(bayId, id).view.webContents.navigationHistory.goBack(),
      forward: (id) => this.tab(bayId, id).view.webContents.navigationHistory.goForward(),
      reload: (id) => this.tab(bayId, id).view.webContents.reload(),
      resetZoom: (id) => this.zoom(this.tab(bayId, id), 0),
      close: (id) => this.close(this.tab(bayId, id)),
      list: () => this.list(bayId),
      onChange: (listener) => {
        const set = this.listeners.get(bayId) ?? new Set();
        set.add(listener);
        this.listeners.set(bayId, set);
      },
      screenshot: async (id) => {
        const image = await this.tab(bayId, id).view.webContents.capturePage(undefined, {
          stayHidden: true,
        });
        return image.toPNG();
      },
      evaluate: (id, script) =>
        this.tab(bayId, id).view.webContents.executeJavaScript(script, true),
    };
  }

  /** Shows a tab of `bayId` over `rect` of the calling bay UI; hides the one shown there before. */
  show(contents: WebContents, bayId: string, id: string | undefined, rect?: ViewRect): void {
    for (const tab of this.tabs.values()) {
      if (tab.shownIn?.contents === contents && tab.id !== id) this.hide(tab);
    }
    if (id === undefined || !rect) return;
    const tab = this.tab(bayId, id);
    const placement = this.placementOf(contents);
    if (!placement) throw new Error('Unknown sender');
    if (tab.shownIn && tab.shownIn.contents !== contents) this.hide(tab);
    // Only while still shown there: another bay UI may have taken the tab over meanwhile.
    if (!tab.shownIn) {
      contents.once('destroyed', () => tab.shownIn?.contents === contents && this.hide(tab));
    }
    this.moveTo(tab, placement.window);
    const zoom = contents.getZoomFactor();
    tab.view.setBounds({
      x: Math.round(placement.offset.x + rect.x * zoom),
      y: Math.round(placement.offset.y + rect.y * zoom),
      width: Math.max(1, Math.round(rect.width * zoom)),
      height: Math.max(1, Math.round(rect.height * zoom)),
    });
    tab.shownIn = { contents, placement };
    tab.view.setVisible(placement.visible());
  }

  /** Follows the visibility of the bay UIs (another bay selected, window resized). */
  refresh(): void {
    for (const tab of this.tabs.values()) {
      if (tab.shownIn) tab.view.setVisible(tab.shownIn.placement.visible());
    }
  }

  private async open(bayId: string, url: string, options: BrowserTabOptions, openerId?: string) {
    if (!allowedUrl(url)) throw new Error(`Only http, https and about:blank can be opened: ${url}`);
    const partition = `${options.persist ? 'persist:' : ''}bay-browser:${bayId}:${options.partition ?? 'default'}`;
    this.prepare(partition);
    const view = new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });
    const tab: Tab = {
      id: randomUUID(),
      bayId,
      partition: options.partition ?? 'default',
      options,
      view,
      ...(openerId && { openerId }),
    };
    this.tabs.set(tab.id, tab);
    view.setVisible(false);
    view.setBounds({ x: 0, y: 0, ...HIDDEN_SIZE });
    if (this.mainWindow) this.moveTo(tab, this.mainWindow);
    this.watch(tab);
    this.changed(bayId);
    await this.load(tab, url);
    return tab.id;
  }

  private watch(tab: Tab): void {
    const wc = tab.view.webContents;
    const changed = () => this.changed(tab.bayId);
    wc.on('did-start-loading', () => {
      tab.error = undefined;
      changed();
    });
    for (const event of [
      'did-stop-loading',
      'page-title-updated',
      'did-navigate-in-page',
    ] as const) {
      wc.on(event as 'did-stop-loading', changed);
    }
    // Zoom keys of the page: changed here, so the bay hears of it (the menu says nothing).
    wc.on('before-input-event', (e, input) => {
      const mac = process.platform === 'darwin';
      // Cmd (Ctrl elsewhere) alone, Shift allowed: it types "+" on some layouts.
      const mod = (mac ? input.meta : input.control) && !(mac ? input.control : input.meta);
      const step = ZOOM_KEYS[input.key];
      if (input.type !== 'keyDown' || !mod || input.alt || step === undefined) return;
      e.preventDefault();
      this.zoom(tab, step && wc.getZoomLevel() + step);
    });
    wc.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED) return;
      tab.error = description;
      changed();
    });
    wc.on('render-process-gone', (_e, details) => {
      tab.error = `Page crashed (${details.reason})`;
      changed();
    });
    const block = (e: { preventDefault(): void }, url: string) => {
      if (!allowedUrl(url)) e.preventDefault();
    };
    wc.on('will-navigate', (e) => block(e, e.url));
    wc.on('will-redirect', (e) => block(e, e.url));
    wc.setWindowOpenHandler(({ url }) => {
      if (allowedUrl(url)) void this.open(tab.bayId, url, tab.options, tab.id).catch(() => {});
      return { action: 'deny' };
    });
  }

  private zoom(tab: Tab, level: number): void {
    tab.view.webContents.setZoomLevel(level);
    this.changed(tab.bayId);
  }

  private async load(tab: Tab, url: string): Promise<void> {
    if (!allowedUrl(url)) throw new Error(`Only http, https and about:blank can be opened: ${url}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      // A failed load is reported through `did-fail-load` into `error`.
      tab.view.webContents.loadURL(url).catch(() => {}),
      new Promise<void>((resolve) => (timer = setTimeout(resolve, LOAD_TIMEOUT_MS))),
    ]);
    clearTimeout(timer);
  }

  /** Closes every tab of a bay that leaves the sidebar (ADR 0017). */
  closeBay(bayId: string): void {
    this.listeners.delete(bayId);
    for (const tab of [...this.tabs.values()]) if (tab.bayId === bayId) this.close(tab);
  }

  private close(tab: Tab): void {
    tab.parent?.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    this.tabs.delete(tab.id);
    this.changed(tab.bayId);
  }

  private hide(tab: Tab): void {
    tab.shownIn = undefined;
    tab.view.setVisible(false);
    if (this.mainWindow && !this.mainWindow.isDestroyed()) this.moveTo(tab, this.mainWindow);
  }

  /** Adds the view to `window` on top of everything there (also when it is there already). */
  private moveTo(tab: Tab, window: BrowserWindow): void {
    if (tab.parent && tab.parent !== window && !tab.parent.isDestroyed()) {
      tab.parent.contentView.removeChildView(tab.view);
    }
    window.contentView.addChildView(tab.view);
    tab.parent = window;
  }

  private list(bayId: string): BrowserTab[] {
    return [...this.tabs.values()]
      .filter((t) => t.bayId === bayId)
      .map((t) => {
        const wc = t.view.webContents;
        const zoom = Math.round(wc.getZoomFactor() * 100);
        return {
          id: t.id,
          url: wc.getURL(),
          title: wc.getTitle(),
          loading: wc.isLoading(),
          canGoBack: wc.navigationHistory.canGoBack(),
          canGoForward: wc.navigationHistory.canGoForward(),
          partition: t.partition,
          ...(t.error && { error: t.error }),
          ...(t.openerId && { openerId: t.openerId }),
          ...(zoom !== 100 && { zoom }),
        };
      });
  }

  private tab(bayId: string, id: string): Tab {
    const tab = this.tabs.get(id);
    if (!tab || tab.bayId !== bayId) throw new Error(`Unknown tab "${id}"`);
    return tab;
  }

  private changed(bayId: string): void {
    const tabs = this.list(bayId);
    for (const listener of this.listeners.get(bayId) ?? []) listener(tabs);
  }

  /** Pages get no permissions (camera, microphone, location, notifications …). */
  private prepare(partition: string): void {
    if (this.prepared.has(partition)) return;
    this.prepared.add(partition);
    const ses = session.fromPartition(partition);
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
  }
}
