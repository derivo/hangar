import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserTab } from '@hangar/sdk';

/** A fake web page: events, a URL, a history; `loadURL` answers as `nextLoad` says. */
let nextContentsId = 0;
class FakeContents extends EventEmitter {
  id = ++nextContentsId;
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
  focus = vi.fn();
  findInPage = vi.fn(() => 1);
  stopFindInPage = vi.fn();
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
    completed?: (details: Record<string, unknown>) => void;
    failed?: (details: Record<string, unknown>) => void;
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
        webRequest: {
          onCompleted: (l: NonNullable<typeof ses.completed>) => (ses.completed = l),
          onErrorOccurred: (l: NonNullable<typeof ses.failed>) => (ses.failed = l),
        },
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

describe('BrowserTabs: page errors (ADR 0042)', () => {
  const partition = 'bay-browser:dev.hangar.browser:default';

  it('collects console errors and warnings, not info or debug', async () => {
    const { browser, open, last } = setup();
    const id = await open();
    const wc = FakeView.all[0]!.webContents;
    const log = (level: string, message: string) =>
      wc.emit('console-message', { level, message, lineNumber: 7, sourceId: 'https://x/app.js' });
    log('info', 'hello');
    log('debug', 'details');
    log('warning', 'deprecated');
    log('error', 'Uncaught TypeError: x is undefined');
    expect(browser.errors(id)).toEqual([
      {
        time: expect.any(Number),
        kind: 'console',
        level: 'warning',
        message: 'deprecated',
        source: 'https://x/app.js',
        line: 7,
      },
      {
        time: expect.any(Number),
        kind: 'console',
        level: 'error',
        message: 'Uncaught TypeError: x is undefined',
        source: 'https://x/app.js',
        line: 7,
      },
    ]);
    // Only errors count; warnings do not.
    expect(last()[0]!.errors).toBe(1);
  });

  it('reports the status of the page, a failing status as a load error, and failed requests of its own page only', async () => {
    const { browser, open, last } = setup();
    const id = await open();
    const other = await open('https://other.example');
    const wc = FakeView.all[0]!.webContents;
    const ses = sessions.get(partition)!;
    const done = (details: Record<string, unknown>) =>
      ses.completed!({ webContentsId: wc.id, ...details });
    wc.emit('did-navigate', {}, 'https://example.com/', 500, 'Internal Server Error');
    // The main document's response is no request error of its own: did-navigate names it.
    done({ url: 'https://example.com/', resourceType: 'mainFrame', statusCode: 500 });
    done({ url: 'https://example.com/ok.js', resourceType: 'script', statusCode: 200 });
    done({ url: 'https://example.com/api', resourceType: 'xhr', statusCode: 404 });
    ses.failed!({
      webContentsId: wc.id,
      url: 'https://x/a',
      resourceType: 'image',
      error: 'net::ERR_ABORTED',
    });
    ses.failed!({
      webContentsId: wc.id,
      url: 'https://example.com/',
      resourceType: 'mainFrame',
      error: 'net::ERR_FAILED',
    });
    ses.failed!({
      webContentsId: wc.id,
      url: 'http://localhost:9/ws',
      resourceType: 'xhr',
      error: 'net::ERR_CONNECTION_REFUSED',
    });
    ses.completed!({ url: 'https://example.com/bg', resourceType: 'xhr', statusCode: 500 });
    ses.completed!({
      webContentsId: 999,
      url: 'https://example.com/z',
      resourceType: 'xhr',
      statusCode: 500,
    });
    expect(
      browser
        .errors(id)
        .map(({ kind, level, message, source }) => ({ kind, level, message, source })),
    ).toEqual([
      { kind: 'load', level: 'error', message: 'HTTP 500', source: 'https://example.com/' },
      { kind: 'request', level: 'error', message: 'HTTP 404', source: 'https://example.com/api' },
      {
        kind: 'request',
        level: 'error',
        message: 'net::ERR_CONNECTION_REFUSED',
        source: 'http://localhost:9/ws',
      },
    ]);
    expect(last()[0]).toMatchObject({ status: 500, errors: 3 });
    expect(browser.errors(other)).toEqual([]);
    expect(last()[1]).not.toHaveProperty('errors');
    expect(last()[1]).not.toHaveProperty('status');
  });

  it('records a failed load of the main frame', async () => {
    const { browser, open } = setup();
    const id = await open();
    const wc = FakeView.all[0]!.webContents;
    wc.emit('did-fail-load', {}, -202, 'ERR_CERT_AUTHORITY_INVALID', 'https://self.test/', true);
    expect(browser.errors(id)).toEqual([
      {
        time: expect.any(Number),
        kind: 'load',
        level: 'error',
        message: 'ERR_CERT_AUTHORITY_INVALID',
        source: 'https://self.test/',
      },
    ]);
  });

  it('starts over when the page navigates to another document, and keeps at most 200 entries', async () => {
    const { browser, open, last } = setup();
    const id = await open();
    const wc = FakeView.all[0]!.webContents;
    for (let i = 0; i < 205; i++)
      wc.emit('console-message', { level: 'error', message: `e${i}`, lineNumber: 1, sourceId: '' });
    expect(browser.errors(id)).toHaveLength(200);
    expect(browser.errors(id)[0]!.message).toBe('e5');
    // Starting to load another page keeps the old one's errors: it is still shown (Codex).
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    wc.emit('console-message', { level: 'error', message: 'old', lineNumber: 1, sourceId: '' });
    expect(browser.errors(id).at(-1)!.message).toBe('old');
    // The new document replaces it: its errors start empty, with its status.
    wc.emit('did-navigate', {}, 'https://example.com/next', 200, 'OK');
    expect(browser.errors(id)).toEqual([]);
    expect(last()[0]).not.toHaveProperty('errors');
    expect(last()[0]!.status).toBe(200);
  });

  it('replaces the errors and status of the previous page by a failed load (Codex)', async () => {
    const { browser, open, last } = setup();
    const id = await open();
    const wc = FakeView.all[0]!.webContents;
    wc.emit('did-navigate', {}, 'https://example.com/', 500, 'Internal Server Error');
    wc.emit('console-message', { level: 'error', message: 'old', lineNumber: 1, sourceId: '' });
    // A load Electron refuses before navigating (invalid URL) keeps the shown page's list.
    wc.emit('did-fail-load', {}, -300, 'ERR_INVALID_URL', 'https://example.test:99999/', true);
    expect(browser.errors(id).map((e) => e.message)).toEqual([
      'HTTP 500',
      'old',
      'ERR_INVALID_URL',
    ]);
    expect(last()[0]!.status).toBe(500);
    // Electron shows its error page without did-navigate.
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:9/', true);
    expect(browser.errors(id).map((e) => e.message)).toEqual(['ERR_CONNECTION_REFUSED']);
    expect(last()[0]).not.toHaveProperty('status');
    expect(last()[0]!.errors).toBe(1);
  });

  it("keeps a tab's errors from other bays", async () => {
    const { tabs, open } = setup();
    const id = await open();
    expect(() => tabs.forBay('dev.hangar.other').errors(id)).toThrow(`Unknown tab "${id}"`);
  });
});

describe('BrowserTabs: find in page (ADR 0042)', () => {
  it('finds, reports the final result with the tab and stops', async () => {
    const { browser, open, last } = setup();
    const id = await open();
    const wc = FakeView.all[0]!.webContents;
    // Electron's findNext is true for a new search and false for the next match (Codex).
    browser.find(id, 'Hangar');
    expect(wc.findInPage).toHaveBeenLastCalledWith('Hangar', { forward: true, findNext: true });
    browser.find(id, 'Hangar', { forward: false, next: true });
    expect(wc.findInPage).toHaveBeenLastCalledWith('Hangar', { forward: false, findNext: false });
    wc.emit('found-in-page', {}, { activeMatchOrdinal: 1, matches: 0, finalUpdate: false });
    expect(last()[0]).not.toHaveProperty('find');
    wc.emit('found-in-page', {}, { activeMatchOrdinal: 3, matches: 17, finalUpdate: true });
    expect(last()[0]!.find).toEqual({ active: 3, matches: 17 });
    browser.stopFind(id);
    expect(wc.stopFindInPage).toHaveBeenCalledWith('clearSelection');
    expect(wc.focus).not.toHaveBeenCalled();
    browser.focus(id);
    expect(wc.focus).toHaveBeenCalled();
    expect(last()[0]).not.toHaveProperty('find');
  });

  it('takes Cmd/Ctrl+F from the page: focuses the bay UI and asks the bay to open its find bar', async () => {
    const { tabs, main, browser, open, place } = setup();
    tabs.attach(main as never);
    const id = await open();
    const wc = FakeView.all[0]!.webContents;
    const requests: string[] = [];
    browser.onFindRequest((tab) => requests.push(tab));
    const mod = process.platform === 'darwin' ? { meta: true } : { control: true };
    const press = (input: Record<string, unknown>) => {
      const e = { preventDefault: vi.fn() };
      wc.emit('before-input-event', e, { type: 'keyDown', ...input });
      return e.preventDefault;
    };
    // Not shown anywhere: the bay still hears of it, nothing to focus.
    expect(press({ ...mod, key: 'f' })).toHaveBeenCalled();
    const { ui } = place();
    tabs.show(ui as never, 'dev.hangar.browser', id, { x: 0, y: 0, width: 10, height: 10 });
    expect(press({ ...mod, key: 'F', shift: true })).not.toHaveBeenCalled();
    expect(press({ key: 'f' })).not.toHaveBeenCalled();
    expect(press({ ...mod, key: 'f' })).toHaveBeenCalled();
    expect(ui.focus).toHaveBeenCalledTimes(1);
    expect(requests).toEqual([id, id]);
  });
});

describe('BrowserTabs: trusting a certificate (ADR 0043)', () => {
  const certError = (wc: FakeContents, url: string, fingerprint: string, isMainFrame = true) => {
    const e = { preventDefault: vi.fn() };
    const callback = vi.fn();
    const certificate = { fingerprint };
    wc.emit(
      'certificate-error',
      e,
      url,
      'net::ERR_CERT_AUTHORITY_INVALID',
      certificate,
      callback,
      isMainFrame,
    );
    return {
      trusted: callback.mock.calls[0]?.[0] as boolean,
      prevented: e.preventDefault.mock.calls.length > 0,
    };
  };

  it('refuses an unknown certificate and offers it with the tab, until the next load', async () => {
    const { open, last } = setup();
    await open();
    const wc = FakeView.all[0]!.webContents;
    expect(certError(wc, 'https://self.test:8443/app', 'sha256/abc')).toEqual({
      trusted: false,
      prevented: false,
    });
    expect(last()[0]!.certificate).toEqual({ host: 'self.test', fingerprint: 'sha256/abc' });
    // A frame inside the page is not what the person sees refused.
    certError(wc, 'https://ads.test/', 'sha256/other', false);
    expect(last()[0]!.certificate).toEqual({ host: 'self.test', fingerprint: 'sha256/abc' });
    wc.emit('did-start-loading');
    expect(last()[0]).not.toHaveProperty('certificate');
  });

  it('trusts the refused certificate for its host in every tab and loads the page again', async () => {
    const { tabs, browser, open } = setup();
    const id = await open();
    const other = tabs.forBay('dev.hangar.other');
    await other.open('https://example.com/');
    const [wc, otherWc] = [FakeView.all[0]!.webContents, FakeView.all[1]!.webContents];
    certError(wc, 'https://self.test:8443/app', 'sha256/abc');
    const load = vi.spyOn(wc, 'loadURL');
    await browser.trustCertificate(id, { host: 'self.test', fingerprint: 'sha256/abc' });
    expect(load).toHaveBeenCalledWith('https://self.test:8443/app');
    expect(certError(wc, 'https://self.test:8443/app', 'sha256/abc')).toEqual({
      trusted: true,
      prevented: true,
    });
    // Same host, other port, a frame, another bay's tab: the same certificate is trusted there.
    expect(certError(otherWc, 'https://self.test:3000/', 'sha256/abc', false).trusted).toBe(true);
    // Another certificate of the host, or the certificate for another host: refused.
    expect(certError(wc, 'https://self.test:8443/', 'sha256/new').trusted).toBe(false);
    expect(certError(wc, 'https://evil.test/', 'sha256/abc').trusted).toBe(false);
  });

  it('trusts nothing without a refused certificate, and not for tabs of other bays', async () => {
    const { tabs, browser, open } = setup();
    const id = await open();
    await expect(
      browser.trustCertificate(id, { host: 'self.test', fingerprint: 'sha256/abc' }),
    ).rejects.toThrow('No refused certificate');
    certError(FakeView.all[0]!.webContents, 'https://self.test/', 'sha256/abc');
    expect(() =>
      tabs
        .forBay('dev.hangar.other')
        .trustCertificate(id, { host: 'self.test', fingerprint: 'sha256/abc' }),
    ).toThrow(`Unknown tab "${id}"`);
  });

  it('trusts only the certificate the person saw (Codex)', async () => {
    const { browser, open } = setup();
    const id = await open();
    const wc = FakeView.all[0]!.webContents;
    certError(wc, 'https://b.test/', 'sha256/b');
    const load = vi.spyOn(wc, 'loadURL');
    // The person saw A; the agent moved the tab to B meanwhile.
    await expect(
      browser.trustCertificate(id, { host: 'b.test', fingerprint: 'sha256/a' }),
    ).rejects.toThrow('The certificate changed');
    // Same certificate, another host (a shared dev certificate): refused too (Codex round 2).
    await expect(
      browser.trustCertificate(id, { host: 'a.test', fingerprint: 'sha256/b' }),
    ).rejects.toThrow('The certificate changed');
    expect(load).not.toHaveBeenCalled();
    expect(certError(wc, 'https://b.test/', 'sha256/b').trusted).toBe(false);
  });

  it('drops the certificate when another navigation starts, the error when a page commits (Codex)', async () => {
    const { open, last } = setup();
    await open();
    const wc = FakeView.all[0]!.webContents;
    certError(wc, 'https://a.test/', 'sha256/a');
    wc.emit('did-fail-load', {}, -202, 'ERR_CERT_AUTHORITY_INVALID', 'https://a.test/', true);
    // B starts while the load of A has not stopped: no new did-start-loading.
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(last()[0]).not.toHaveProperty('certificate');
    wc.emit('did-navigate', {}, 'https://b.test/', 200, 'OK');
    expect(last()[0]).not.toHaveProperty('error');
  });
});

describe('BrowserTabs: OpenCode review (ADR 0042)', () => {
  it('caps the text of an entry', async () => {
    const { browser, open } = setup();
    const id = await open();
    const wc = FakeView.all[0]!.webContents;
    const long = 'x'.repeat(50_000);
    wc.emit('console-message', { level: 'error', message: long, lineNumber: 1, sourceId: long });
    const [entry] = browser.errors(id);
    expect(entry!.message.length).toBeLessThanOrEqual(2_000);
    expect(entry!.message.endsWith('…')).toBe(true);
    expect(entry!.source!.length).toBeLessThanOrEqual(2_000);
  });

  it('has no status for a page without HTTP, and forgets the find result of the old page', async () => {
    const { browser, open, last } = setup();
    const id = await open();
    const wc = FakeView.all[0]!.webContents;
    browser.find(id, 'x');
    wc.emit('found-in-page', {}, { activeMatchOrdinal: 1, matches: 3, finalUpdate: true });
    wc.emit('did-navigate', {}, 'about:blank', -1, '');
    expect(last()[0]).not.toHaveProperty('status');
    expect(last()[0]).not.toHaveProperty('find');
  });

  it('ends a navigation that never commits (HTTP 204, abort): a later refused load keeps the page', async () => {
    const { browser, open, last } = setup();
    const id = await open();
    const wc = FakeView.all[0]!.webContents;
    wc.emit('did-navigate', {}, 'https://a.test/', 500, 'Internal Server Error');
    wc.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'https://a.test/204',
    });
    // Electron 45 emits no event for a navigation without commit, loading just stops (Codex).
    wc.emit('did-stop-loading');
    wc.emit('did-fail-load', {}, -300, 'ERR_INVALID_URL', 'https://example.test:99999/', true);
    expect(last()[0]!.status).toBe(500);
    expect(browser.errors(id).map((e) => e.message)).toEqual(['HTTP 500', 'ERR_INVALID_URL']);
  });

  it('keeps the next navigation when the aborted one reports late', async () => {
    const { browser, open } = setup();
    const id = await open();
    const wc = FakeView.all[0]!.webContents;
    wc.emit('did-navigate', {}, 'https://a.test/', 500, 'Internal Server Error');
    wc.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'https://one.test/',
    });
    wc.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'https://two.test/',
    });
    wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'https://two.test/', true);
    expect(browser.errors(id).map((e) => e.message)).toEqual(['ERR_CONNECTION_REFUSED']);
  });

  it('forgets the find result when a started navigation fails (Codex)', async () => {
    const { browser, open, last } = setup();
    const id = await open();
    const wc = FakeView.all[0]!.webContents;
    browser.find(id, 'x');
    wc.emit('found-in-page', {}, { activeMatchOrdinal: 2, matches: 7, finalUpdate: true });
    wc.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'http://127.0.0.1:9/',
    });
    // Real Electron reports the refusal as provisional failure first (E2E).
    wc.emit(
      'did-fail-provisional-load',
      {},
      -102,
      'ERR_CONNECTION_REFUSED',
      'http://127.0.0.1:9/',
      true,
    );
    wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:9/', true);
    expect(last()[0]).not.toHaveProperty('find');
    expect(browser.errors(id).map((e) => e.message)).toEqual(['ERR_CONNECTION_REFUSED']);
  });
});
