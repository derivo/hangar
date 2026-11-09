// Test helper: a BayContext with an in-memory browser.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type {
  BayBrowser,
  BayContext,
  BayFunction,
  BrowserTab,
  BrowserTabOptions,
  CallInfo,
} from '@hangar/sdk';

export interface FakeTab extends BrowserTab {
  options: BrowserTabOptions;
  /** Result of `evaluate` in this tab. */
  result?: unknown;
}

export function fakeBrowser() {
  const tabs = new Map<string, FakeTab>();
  const listeners: ((tabs: BrowserTab[]) => void)[] = [];
  let next = 0;
  const list = (): BrowserTab[] =>
    [...tabs.values()].map(({ options: _o, result: _r, ...tab }) => tab);
  const changed = () => listeners.forEach((l) => l(list()));
  const get = (id: string) => {
    const tab = tabs.get(id);
    if (!tab) throw new Error(`Unknown tab "${id}"`);
    return tab;
  };
  const browser = {
    open: vi.fn(async (url: string, options: BrowserTabOptions = {}) => {
      const id = `t${++next}`;
      tabs.set(id, {
        id,
        url,
        title: url,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        partition: options.partition ?? 'default',
        options,
      });
      changed();
      return id;
    }),
    navigate: vi.fn(async (id: string, url: string) => {
      get(id).url = url;
      changed();
    }),
    back: vi.fn((id: string) => void get(id)),
    forward: vi.fn((id: string) => void get(id)),
    reload: vi.fn((id: string) => void get(id)),
    resetZoom: vi.fn((id: string) => void get(id)),
    close: vi.fn((id: string) => {
      get(id);
      tabs.delete(id);
      changed();
    }),
    list,
    onChange: (listener: (tabs: BrowserTab[]) => void) => void listeners.push(listener),
    screenshot: vi.fn(async (id: string) => (get(id), new Uint8Array([137, 80, 78, 71]))),
    evaluate: vi.fn(async (id: string, _script: string) => get(id).result),
  } satisfies BayBrowser;
  /** Simulates a page opening a window: a new tab with `openerId`. */
  const popup = (openerId: string, url: string) => {
    const opener = get(openerId);
    const id = `t${++next}`;
    tabs.set(id, { ...opener, id, url, title: url, openerId });
    changed();
    return id;
  };
  return { browser, tabs, popup };
}

export function fakeContext(dataDir = mkdtempSync(join(tmpdir(), 'hangar-browser-'))) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const functions = new Map<string, BayFunction>();
  const fake = fakeBrowser();
  const ended: ((s: { bayId: string; sessionId: string }) => void)[] = [];
  const ctx = {
    bayId: 'dev.hangar.browser',
    dataDir,
    hangarVersion: '0.1.0',
    locale: 'de',
    browser: fake.browser,
    provide: vi.fn((name: string, fn: BayFunction) => void functions.set(name, fn)),
    call: vi.fn(),
    notify: vi.fn(),
    setBadge: vi.fn(),
    setRunning: vi.fn(),
    registerAgentSession: vi.fn(),
    unregisterAgentSession: vi.fn(),
    onAgentSessionEnded: (listener: (s: { bayId: string; sessionId: string }) => void) =>
      void ended.push(listener),
    onLocaleChange: vi.fn(),
    settings: { get: vi.fn(() => false), onChange: vi.fn() },
    pickFolder: vi.fn(),
    labelSessions: vi.fn(),
    jobs: { onRun: vi.fn(), add: vi.fn(), list: vi.fn(), remove: vi.fn() },
    ui: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        void handlers.set(channel, handler),
      send: vi.fn(),
    },
  } satisfies BayContext;
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler ${channel}`);
    return handler(...args);
  };
  const session = (sessionId: string): CallInfo => ({
    caller: { kind: 'session', bayId: 'dev.hangar.agents', sessionId },
  });
  const call = async (name: string, args: unknown, info: CallInfo) => {
    const fn = functions.get(name);
    if (!fn) throw new Error(`no function ${name}`);
    return fn(args, info);
  };
  /** Another bay ended an agent session. */
  const endSession = (sessionId: string, bayId = 'dev.hangar.agents') =>
    ended.forEach((l) => l({ bayId, sessionId }));
  return { ctx, invoke, call, session, endSession, functions, ...fake };
}
