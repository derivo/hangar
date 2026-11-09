import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserTab } from '@hangar/sdk';

/** A fake web page: events, a URL, a history; `loadURL` answers as `nextLoad` says. */
class FakeContents extends EventEmitter {
  url = '';
  title = '';
  zoom = 1;
  loading = false;
  closed = false;
  openHandler?: (details: { url: string }) => { action: string };
  nextLoad: 'ok' | 'fail' | 'hang' = 'ok';
  navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => true,
    goBack: vi.fn(),
    goForward: vi.fn(),
  };
  reload = vi.fn();
  executeJavaScript = vi.fn(async () => 'result');
  capturePage = vi.fn(async () => ({ toPNG: () => Buffer.from('png') }));
  loadURL(url: string) {
    this.url = url;
    if (this.nextLoad === 'fail') return Promise.reject(new Error('ERR_NAME_NOT_RESOLVED'));
    if (this.nextLoad === 'hang') return new Promise<void>(() => {});
    return Promise.resolve();
  }
  getURL = () => this.url;
  getTitle = () => this.title;
  isLoading = () => this.loading;
  getZoomFactor = () => this.zoom;
  level = 0;
  getZoomLevel = () => this.level;
  setZoomLevel = vi.fn((level: number) => {
    this.level = level;
    this.zoom = 1.2 ** level;
  });
  close() {
    this.closed = true;
  }
  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) {
    this.openHandler = handler;
  }
}

class FakeView {
  static all: FakeView[] = [];
  webContents = new FakeContents();
  visible = true;
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  constructor(public options: { webPreferences: Record<string, unknown> }) {
    FakeView.all.push(this);
  }
  setVisible(visible: boolean) {
    this.visible = visible;
  }
  setBounds(bounds: typeof this.bounds) {
    this.bounds = bounds;
  }
}

class FakeWindow {
  destroyed = false;
  children: FakeView[] = [];
  contentView = {
    addChildView: (view: FakeView) => {
      this.children = [...this.children.filter((v) => v !== view), view];
    },
    removeChildView: (view: FakeView) => {
      this.children = this.children.filter((v) => v !== view);
    },
  };
  isDestroyed = () => this.destroyed;
}

const sessions = new Map<
  string,
  {
    request?: (wc: unknown, permission: string, callback: (ok: boolean) => void) => void;
    check?: () => boolean;
  }
>();

vi.mock('electron', () => ({
  WebContentsView: FakeView,
  session: {
    fromPartition: (partition: string) => {
      const ses: typeof sessions extends Map<string, infer S> ? S : never = {};
      sessions.set(partition, ses);
      return {
        setPermissionRequestHandler: (h: NonNullable<typeof ses.request>) => (ses.request = h),
        setPermissionCheckHandler: (h: NonNullable<typeof ses.check>) => (ses.check = h),
      };
    },
  },
}));

const { BrowserTabs, allowedUrl } = await import('./browser-tabs');

/** `BrowserTabs` with one placement per bay UI, set up by `place`. */
function setup() {
  const placements = new Map<
    FakeContents,
    { window: FakeWindow; offset: { x: number; y: number }; visible: () => boolean }
  >();
  const tabs = new BrowserTabs((contents) => placements.get(contents as never) as never);
  const main = new FakeWindow();
  const browser = tabs.forBay('dev.hangar.browser');
  const seen: BrowserTab[][] = [];
  browser.onChange((list) => seen.push(list));
  const place = (window = main, offset = { x: 80, y: 0 }, visible = true) => {
    const ui = new FakeContents();
    let shown = visible;
    placements.set(ui, { window, offset, visible: () => shown });
    return { ui, setVisible: (v: boolean) => (shown = v) };
  };
  const open = (url = 'https://example.com', options = {}) => browser.open(url, options);
  return { tabs, main, browser, seen, place, open, last: () => seen.at(-1)! };
}

beforeEach(() => {
  FakeView.all = [];
  sessions.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('allowedUrl', () => {
  it.each([
    ['https://example.com', true],
    ['HTTP://example.com', true],
    ['about:blank', true],
    ['about:blankx', false],
    ['about:config', false],
    ['file:///etc/passwd', false],
    ['javascript:alert(1)', false],
    ['data:text/html,hi', false],
    ['chrome://settings', false],
    ['example.com', false],
    ['', false],
  ])('%j → %s', (url, allowed) => {
    expect(allowedUrl(url)).toBe(allowed);
  });
});

describe('BrowserTabs: opening', () => {
  it('refuses anything but http, https and about:blank, before creating a view', async () => {
    const { browser } = setup();
    await expect(browser.open('file:///etc/passwd')).rejects.toThrow(
      'Only http, https and about:blank can be opened: file:///etc/passwd',
    );
    expect(FakeView.all).toEqual([]);
  });

  it('opens a hidden, sandboxed tab of page size in the main window', async () => {
    const { tabs, main, browser, open } = setup();
    tabs.attach(main as never);
    const id = await open();
    const view = FakeView.all[0]!;
    expect(view.options.webPreferences).toEqual({
      partition: 'bay-browser:dev.hangar.browser:default',
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
    });
    expect(view.visible).toBe(false);
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
    expect(main.children).toEqual([view]);
    expect(browser.list()).toEqual([
      {
        id,
        url: 'https://example.com',
        title: '',
        loading: false,
        canGoBack: false,
        canGoForward: true,
        partition: 'default',
      },
    ]);
  });

  it('names partitions per bay, name and persistence and gives pages no permissions', async () => {
    const { open } = setup();
    await open('https://a.example', { partition: 'work' });
    await open('https://b.example', { partition: 'work' });
    await open('https://c.example', { partition: 'work', persist: true });
    expect([...sessions.keys()]).toEqual([
      'bay-browser:dev.hangar.browser:work',
      'persist:bay-browser:dev.hangar.browser:work',
    ]);
    for (const ses of sessions.values()) {
      const callback = vi.fn();
      ses.request!({}, 'media', callback);
      expect(callback).toHaveBeenCalledWith(false);
      expect(ses.check!()).toBe(false);
    }
  });

  it('moves tabs opened before the main window existed into it', async () => {
    const { tabs, main, open } = setup();
    await open();
    expect(main.children).toEqual([]);
    tabs.attach(main as never);
    expect(main.children).toEqual([FakeView.all[0]]);
  });

  it('answers a failed load without throwing; the error comes from did-fail-load', async () => {
    const { browser, last } = setup();
    const before = FakeView.all.length;
    const opening = browser.open('https://nowhere.invalid');
    const wc = FakeView.all[before]!.webContents;
    wc.nextLoad = 'fail';
    // The first load already started: navigate again to load with the failing fake.
    const id = await opening;
    await expect(browser.navigate(id, 'https://nowhere.invalid')).resolves.toBeUndefined();
    wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://nowhere.invalid', true);
    expect(last()[0]!.error).toBe('ERR_NAME_NOT_RESOLVED');
  });

  it('gives up waiting for a page after 30 seconds', async () => {
    vi.useFakeTimers();
    const { browser } = setup();
    const id = await browser.open('about:blank');
    FakeView.all[0]!.webContents.nextLoad = 'hang';
    let done = false;
    const navigating = browser.navigate(id, 'https://slow.example').then(() => (done = true));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await navigating;
    expect(done).toBe(true);
  });

  it('refuses to navigate to a forbidden address', async () => {
    const { browser, open } = setup();
    const id = await open();
    await expect(browser.navigate(id, 'javascript:alert(1)')).rejects.toThrow(
      'Only http, https and about:blank can be opened: javascript:alert(1)',
    );
    expect(FakeView.all[0]!.webContents.url).toBe('https://example.com');
  });
});

describe('BrowserTabs: page events', () => {
  it('reports load errors of the main frame only, not aborted loads, and clears them on the next load', async () => {
    const { open, last } = setup();
    await open();
    const wc = FakeView.all[0]!.webContents;
    wc.emit('did-fail-load', {}, -105, 'ERR_SUB', 'https://x', false);
    wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://x', true);
    expect(last()[0]!.error).toBeUndefined();
    wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://x', true);
    expect(last()[0]!.error).toBe('ERR_NAME_NOT_RESOLVED');
    wc.emit('did-start-loading');
    expect(last()[0]).not.toHaveProperty('error');
  });

  it('reports a crashed page', async () => {
    const { open, last } = setup();
    await open();
    FakeView.all[0]!.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(last()[0]!.error).toBe('Page crashed (crashed)');
  });

  it.each(['did-stop-loading', 'page-title-updated', 'did-navigate-in-page'])(
    'reports changes on %s',
    async (event) => {
      const { open, last } = setup();
      await open();
      const wc = FakeView.all[0]!.webContents;
      wc.title = 'Neu';
      wc.emit(event);
      expect(last()[0]!.title).toBe('Neu');
    },
  );

  it.each(['will-navigate', 'will-redirect'])(
    'stops %s to a forbidden address and lets allowed ones through',
    async (event) => {
      const { open } = setup();
      await open();
      const wc = FakeView.all[0]!.webContents;
      const forbidden = { url: 'file:///etc/passwd', preventDefault: vi.fn() };
      const allowed = { url: 'https://other.example', preventDefault: vi.fn() };
      wc.emit(event, forbidden);
      wc.emit(event, allowed);
      expect(forbidden.preventDefault).toHaveBeenCalled();
      expect(allowed.preventDefault).not.toHaveBeenCalled();
    },
  );

  it('opens popups as tabs of the same bay with their opener; never as windows', async () => {
    const { browser, open } = setup();
    const id = await open('https://a.example', { partition: 'work' });
    const wc = FakeView.all[0]!.webContents;
    expect(wc.openHandler!({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' });
    expect(FakeView.all).toHaveLength(1);
    expect(wc.openHandler!({ url: 'https://popup.example' })).toEqual({ action: 'deny' });
    await vi.waitFor(() => expect(browser.list()[1]?.url).toBe('https://popup.example'));
    expect(browser.list()[1]).toMatchObject({
      url: 'https://popup.example',
      partition: 'work',
      openerId: id,
    });
  });
});

describe('BrowserTabs: other bays and actions', () => {
  it('zooms a page with Cmd/Ctrl +, - and 0, reports it in percent and resets it', async () => {
    const { browser, open } = setup();
    const id = await open();
    const wc = FakeView.all[0]!.webContents;
    const seen: (number | undefined)[] = [];
    browser.onChange((tabs) => seen.push(tabs[0]!.zoom));
    expect(browser.list()[0]!.zoom).toBeUndefined();
    const mod = process.platform === 'darwin' ? { meta: true } : { control: true };
    const press = (input: Record<string, unknown>) => {
      const e = { preventDefault: vi.fn() };
      wc.emit('before-input-event', e, { type: 'keyDown', ...input });
      return e.preventDefault;
    };
    expect(press({ ...mod, key: '+' })).toHaveBeenCalled();
    expect(wc.level).toBe(0.5);
    expect(browser.list()[0]!.zoom).toBe(110);
    expect(press({ ...mod, key: '=' })).toHaveBeenCalled();
    expect(browser.list()[0]!.zoom).toBe(120);
    press({ ...mod, key: '-' });
    press({ ...mod, key: '-' });
    press({ ...mod, key: '-' });
    expect(browser.list()[0]!.zoom).toBe(91);
    press({ ...mod, key: '0' });
    expect(wc.level).toBe(0);
    expect(browser.list()[0]!.zoom).toBeUndefined();
    // Other keys, key up and keys without the modifier reach the page.
    expect(press({ ...mod, key: 'r' })).not.toHaveBeenCalled();
    expect(press({ key: '+' })).not.toHaveBeenCalled();
    // Another modifier besides it is someone else's shortcut (Codex); Shift is how "+" is typed.
    expect(press({ meta: true, control: true, key: '=' })).not.toHaveBeenCalled();
    expect(press({ ...mod, alt: true, key: '0' })).not.toHaveBeenCalled();
    expect(press({ ...mod, shift: true, key: '+' })).toHaveBeenCalled();
    press({ ...mod, key: '0' });
    const e = { preventDefault: vi.fn() };
    wc.emit('before-input-event', e, { type: 'keyUp', ...mod, key: '+' });
    expect(e.preventDefault).not.toHaveBeenCalled();
    press({ ...mod, key: '+' });
    browser.resetZoom(id);
    expect(wc.level).toBe(0);
    expect(seen).toEqual([110, 120, 110, undefined, 91, undefined, 110, undefined, 110, undefined]);
  });

  it("keeps a bay's tabs from other bays", async () => {
    const { tabs, open } = setup();
    const id = await open();
    const other = tabs.forBay('dev.hangar.other');
    expect(other.list()).toEqual([]);
    expect(() => other.close(id)).toThrow(`Unknown tab "${id}"`);
    expect(() => other.navigate(id, 'https://x.example')).toThrow(`Unknown tab "${id}"`);
    expect(() => other.back(id)).toThrow(`Unknown tab "${id}"`);
  });

  it('goes back, forward, reloads, evaluates as a user gesture and screenshots hidden', async () => {
    const { browser, open } = setup();
    const id = await open();
    const wc = FakeView.all[0]!.webContents;
    browser.back(id);
    browser.forward(id);
    browser.reload(id);
    expect(wc.navigationHistory.goBack).toHaveBeenCalled();
    expect(wc.navigationHistory.goForward).toHaveBeenCalled();
    expect(wc.reload).toHaveBeenCalled();
    await expect(browser.evaluate(id, '1+1')).resolves.toBe('result');
    expect(wc.executeJavaScript).toHaveBeenCalledWith('1+1', true);
    expect((await browser.screenshot(id)).toString()).toBe('png');
    expect(wc.capturePage).toHaveBeenCalledWith(undefined, { stayHidden: true });
  });

  it('closes a tab: out of its window, page closed, listeners told', async () => {
    const { tabs, main, browser, open, last } = setup();
    tabs.attach(main as never);
    const id = await open();
    browser.close(id);
    expect(main.children).toEqual([]);
    expect(FakeView.all[0]!.webContents.closed).toBe(true);
    expect(last()).toEqual([]);
    expect(() => browser.close(id)).toThrow(`Unknown tab "${id}"`);
  });

  it('closes every tab of a bay leaving the sidebar, and only those', async () => {
    const { tabs, browser, seen, open } = setup();
    await open();
    await open();
    const other = tabs.forBay('dev.hangar.other');
    await other.open('https://other.example');
    const calls = seen.length;
    tabs.closeBay('dev.hangar.browser');
    expect(browser.list()).toEqual([]);
    expect(other.list()).toHaveLength(1);
    // Listeners of the removed bay hear nothing more.
    expect(seen.length).toBe(calls);
  });
});

describe('BrowserTabs: showing over a bay UI', () => {
  it('lays a tab over the rectangle, scaled by the zoom of the bay UI', async () => {
    const { tabs, main, open, place } = setup();
    tabs.attach(main as never);
    const id = await open();
    const { ui } = place(main, { x: 80, y: 10 });
    ui.zoom = 1.5;
    tabs.show(ui as never, 'dev.hangar.browser', id, { x: 10, y: 20, width: 100.4, height: 0.2 });
    const view = FakeView.all[0]!;
    expect(view.bounds).toEqual({ x: 95, y: 40, width: 151, height: 1 });
    expect(view.visible).toBe(true);
    expect(main.children.at(-1)).toBe(view);
  });

  it('shows one tab per bay UI: showing another hides the first', async () => {
    const { tabs, main, open, place } = setup();
    tabs.attach(main as never);
    const a = await open();
    const b = await open();
    const { ui } = place();
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    tabs.show(ui as never, 'dev.hangar.browser', a, rect);
    tabs.show(ui as never, 'dev.hangar.browser', b, rect);
    expect(FakeView.all.map((v) => v.visible)).toEqual([false, true]);
    tabs.show(ui as never, 'dev.hangar.browser', undefined);
    expect(FakeView.all.map((v) => v.visible)).toEqual([false, false]);
  });

  it('moves a tab into the window of a bay UI there and back to the main window when hidden', async () => {
    const { tabs, main, open, place } = setup();
    tabs.attach(main as never);
    const id = await open();
    const undocked = new FakeWindow();
    const { ui } = place(undocked);
    tabs.show(ui as never, 'dev.hangar.browser', id, { x: 0, y: 0, width: 10, height: 10 });
    expect(undocked.children).toEqual([FakeView.all[0]]);
    expect(main.children).toEqual([]);
    tabs.show(ui as never, 'dev.hangar.browser', undefined);
    expect(main.children).toEqual([FakeView.all[0]]);
    expect(undocked.children).toEqual([]);
  });

  it('takes a tab over from another bay UI', async () => {
    const { tabs, main, open, place } = setup();
    tabs.attach(main as never);
    const id = await open();
    const first = place(main, { x: 0, y: 0 });
    const second = place(main, { x: 500, y: 0 });
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    tabs.show(first.ui as never, 'dev.hangar.browser', id, rect);
    tabs.show(second.ui as never, 'dev.hangar.browser', id, rect);
    expect(FakeView.all[0]!.bounds.x).toBe(500);
    // Hiding in the first UI no longer touches it.
    tabs.show(first.ui as never, 'dev.hangar.browser', undefined);
    expect(FakeView.all[0]!.visible).toBe(true);
  });

  it('keeps a tab another bay UI took over when the first one is destroyed', async () => {
    const { tabs, main, open, place } = setup();
    tabs.attach(main as never);
    const id = await open();
    const first = place(main, { x: 0, y: 0 });
    const second = place(main, { x: 500, y: 0 });
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    tabs.show(first.ui as never, 'dev.hangar.browser', id, rect);
    tabs.show(second.ui as never, 'dev.hangar.browser', id, rect);
    first.ui.emit('destroyed');
    expect(FakeView.all[0]!.visible).toBe(true);
    second.ui.emit('destroyed');
    expect(FakeView.all[0]!.visible).toBe(false);
  });

  it('hides the tab when its bay UI is destroyed', async () => {
    const { tabs, main, open, place } = setup();
    tabs.attach(main as never);
    const id = await open();
    const { ui } = place();
    tabs.show(ui as never, 'dev.hangar.browser', id, { x: 0, y: 0, width: 10, height: 10 });
    ui.emit('destroyed');
    expect(FakeView.all[0]!.visible).toBe(false);
  });

  it('follows the visibility of the bay UI on refresh', async () => {
    const { tabs, main, open, place } = setup();
    tabs.attach(main as never);
    const id = await open();
    const { ui, setVisible } = place(main, { x: 0, y: 0 }, false);
    tabs.show(ui as never, 'dev.hangar.browser', id, { x: 0, y: 0, width: 10, height: 10 });
    expect(FakeView.all[0]!.visible).toBe(false);
    setVisible(true);
    tabs.refresh();
    expect(FakeView.all[0]!.visible).toBe(true);
  });

  it('refuses an unknown sender and a tab of another bay', async () => {
    const { tabs, main, open, place } = setup();
    tabs.attach(main as never);
    const id = await open();
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    expect(() => tabs.show(new FakeContents() as never, 'dev.hangar.browser', id, rect)).toThrow(
      'Unknown sender',
    );
    const { ui } = place();
    expect(() => tabs.show(ui as never, 'dev.hangar.other', id, rect)).toThrow(
      `Unknown tab "${id}"`,
    );
  });

  it('leaves a hidden tab where it is when the main window is gone', async () => {
    const { tabs, main, open, place } = setup();
    tabs.attach(main as never);
    const id = await open();
    const undocked = new FakeWindow();
    const { ui } = place(undocked);
    tabs.show(ui as never, 'dev.hangar.browser', id, { x: 0, y: 0, width: 10, height: 10 });
    main.destroyed = true;
    tabs.show(ui as never, 'dev.hangar.browser', undefined);
    expect(undocked.children).toEqual([FakeView.all[0]]);
    expect(FakeView.all[0]!.visible).toBe(false);
  });
});
