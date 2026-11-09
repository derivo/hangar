import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** What the preloads ask of the main process and what they hand to the page. */
const ipc = {
  sendSync: vi.fn((channel: string) => (channel === 'hangar:locale' ? 'en' : sync.server)),
  invoke: vi.fn(async (..._args: unknown[]) => 'answer'),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
};
const sync = { server: null as string | null };
const exposed: Record<string, Record<string, unknown>> = {};

vi.mock('electron', () => ({
  ipcRenderer: ipc,
  contextBridge: { exposeInMainWorld: (key: string, api: object) => (exposed[key] = api as never) },
}));

/** Loads a preload afresh, as a new page does. */
async function load(file: 'bay' | 'shell', search = '') {
  vi.resetModules();
  window.history.replaceState(null, '', `/index.html${search}`);
  await import(`./${file}.ts`);
  return exposed[file === 'bay' ? 'hangar' : 'hangarShell']!;
}

/** Channels the main process registers, by kind (`handle` answers `invoke`, `on` takes `send`). */
const registered = (() => {
  const main = join(__dirname, '../main');
  const source = ['host.ts', 'index.ts'].map((f) => readFileSync(join(main, f), 'utf8')).join();
  const found = new Map<string, string>();
  for (const [, kind, channel] of source.matchAll(/ipcMain\.(handle|on)\(\s*'([^']+)'/g)) {
    found.set(channel!, kind!);
  }
  return found;
})();

/** Every call the preload made, checked against what the main process registers. */
function expectRegistered() {
  for (const [channel] of ipc.invoke.mock.calls as unknown as [string][]) {
    expect(registered.get(channel), `invoke ${channel}`).toBe('handle');
  }
  for (const [channel] of [...ipc.send.mock.calls, ...ipc.sendSync.mock.calls] as [string][]) {
    expect(registered.get(channel), `send ${channel}`).toBe('on');
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  sync.server = null;
});

describe('bay preload (window.hangar)', () => {
  it('gives the locale, sets the page language and leaves out server and window locally', async () => {
    const api = await load('bay');
    expect(api.locale).toBe('en');
    expect(api).not.toHaveProperty('server');
    expect((api.windows as { current?: string }).current).toBeUndefined();
    window.dispatchEvent(new Event('DOMContentLoaded'));
    expect(document.documentElement.lang).toBe('en');
  });

  it('names the server it runs on and the window it is shown in', async () => {
    sync.server = 'Heimserver';
    const api = await load('bay', '?window=session%3As1');
    expect(api.server).toBe('Heimserver');
    expect((api.windows as { current?: string }).current).toBe('session:s1');
  });

  it('sends every call on its channel with its arguments', async () => {
    const api = (await load('bay')) as unknown as {
      invoke(channel: string, ...args: unknown[]): Promise<unknown>;
      browser: { show(id?: string, rect?: object): Promise<void> };
      windows: {
        open(key: string, title: string): Promise<void>;
        close(key: string): Promise<void>;
        list(): Promise<string[]>;
      };
    };
    await expect(api.invoke('session.create', 'p1', { place: 'project' })).resolves.toBe('answer');
    await api.browser.show('t1', { x: 1, y: 2, width: 3, height: 4 });
    await api.windows.open('session:s1', 'Titel');
    await api.windows.close('session:s1');
    await api.windows.list();
    expect(ipc.invoke.mock.calls).toEqual([
      ['bay:invoke', 'session.create', ['p1', { place: 'project' }]],
      ['bay:browser.show', 't1', { x: 1, y: 2, width: 3, height: 4 }],
      ['bay:window.open', 'session:s1', 'Titel'],
      ['bay:window.close', 'session:s1'],
      ['bay:window.list'],
    ]);
    expectRegistered();
  });

  it('passes on only the events of the channel listened to, until unsubscribed', async () => {
    const api = (await load('bay')) as unknown as {
      on(channel: string, listener: (payload: unknown) => void): () => void;
      windows: { onChange(listener: (keys: string[]) => void): () => void };
    };
    const listener = vi.fn();
    const off = api.on('state', listener);
    const [channel, handler] = ipc.on.mock.calls[0] as [string, (...a: unknown[]) => void];
    expect(channel).toBe('bay:event');
    handler({}, 'session.data', 'x');
    handler({}, 'state', { projects: [] });
    expect(listener.mock.calls).toEqual([[{ projects: [] }]]);
    off();
    expect(ipc.removeListener).toHaveBeenCalledWith('bay:event', handler);

    const keys = vi.fn();
    const offWindows = api.windows.onChange(keys);
    const [windowsChannel, windowsHandler] = ipc.on.mock.calls[1] as [
      string,
      (...a: unknown[]) => void,
    ];
    expect(windowsChannel).toBe('bay:windows');
    windowsHandler({}, ['session:s1']);
    expect(keys).toHaveBeenCalledWith(['session:s1']);
    offWindows();
    expect(ipc.removeListener).toHaveBeenCalledWith('bay:windows', windowsHandler);
    expectRegistered();
  });
});

describe('shell preload (window.hangarShell)', () => {
  type Api = Record<string, (...args: unknown[]) => unknown>;
  const calls = [
    ['getState', [], 'invoke', ['shell:state']],
    ['getOverview', [], 'invoke', ['shell:overview']],
    ['getPermissions', [], 'invoke', ['shell:permissions']],
    ['revoke', [{ id: 'g' }], 'invoke', ['shell:revoke', { id: 'g' }]],
    ['setGrant', ['s', 't', 'allow'], 'invoke', ['shell:setGrant', 's', 't', 'allow']],
    ['getJobs', [], 'invoke', ['shell:jobs']],
    ['setJobPaused', ['j', true, 'srv'], 'invoke', ['shell:job.pause', 'j', true, 'srv']],
    ['runJob', ['j', undefined], 'invoke', ['shell:job.run', 'j', undefined]],
    ['removeJob', ['j', 'srv'], 'invoke', ['shell:job.remove', 'j', 'srv']],
    ['getSettings', [], 'invoke', ['shell:settings']],
    ['setUpdateChannel', ['beta'], 'invoke', ['shell:updateChannel', 'beta']],
    ['setLanguage', ['de'], 'invoke', ['shell:language', 'de']],
    ['setTheme', ['dark'], 'invoke', ['shell:theme', 'dark']],
    ['getBaySettings', [], 'invoke', ['shell:baySettings']],
    ['setBaySetting', ['b', 'k', 1], 'invoke', ['shell:baySetting', 'b', 'k', 1]],
    ['addBay', ['b'], 'invoke', ['shell:addBay', 'b']],
    ['probeServer', ['h:1'], 'invoke', ['shell:server.probe', 'h:1']],
    ['pairServer', ['p', 'n', 'c'], 'invoke', ['shell:server.pair', 'p', 'n', 'c']],
    ['pickShortcut', ['folder'], 'invoke', ['shell:shortcut.pick', 'folder']],
    ['addUrlShortcut', ['https://x'], 'invoke', ['shell:shortcut.url', 'https://x']],
    ['select', ['overview'], 'send', ['shell:select', 'overview']],
    ['bayMenu', ['b'], 'send', ['shell:bayMenu', 'b']],
    ['moveBay', ['b', 1], 'send', ['shell:moveBay', 'b', 1]],
    ['setModal', [true], 'send', ['shell:modal', true]],
    ['setHintHeight', [70], 'send', ['shell:hintHeight', 70]],
    ['cancelProbe', ['p'], 'send', ['shell:server.cancel', 'p']],
    ['serverMenu', ['s'], 'send', ['shell:serverMenu', 's']],
    ['openShortcut', ['x'], 'send', ['shell:shortcut.open', 'x']],
    ['shortcutMenu', ['x'], 'send', ['shell:shortcutMenu', 'x']],
    ['moveShortcut', ['x', 0], 'send', ['shell:moveShortcut', 'x', 0]],
    ['getWorkspaces', [], 'invoke', ['shell:workspaces']],
    ['connectRelay', ['wss://r'], 'invoke', ['shell:workspace.connect', 'wss://r']],
    ['createWorkspace', ['w', 't'], 'invoke', ['shell:workspace.create', 'w', 't']],
    ['inviteToWorkspace', ['w'], 'invoke', ['shell:workspace.invite', 'w']],
    ['joinWorkspace', ['w', 't', 'f'], 'invoke', ['shell:workspace.join', 'w', 't', 'f']],
    ['acceptMember', ['w', 'f'], 'invoke', ['shell:workspace.accept', 'w', 'f']],
    ['rejectMember', ['w', 'f'], 'invoke', ['shell:workspace.reject', 'w', 'f']],
    ['removeMember', ['w', 'f'], 'invoke', ['shell:workspace.remove', 'w', 'f']],
    ['setWorkspaceShare', ['w', 'x', true], 'invoke', ['shell:workspace.share', 'w', 'x', true]],
    ['getBayCatalog', [], 'invoke', ['shell:bay.catalog']],
    ['prepareBay', ['dev.a.b', '1.0.0'], 'invoke', ['shell:bay.prepare', 'dev.a.b', '1.0.0']],
    ['confirmBay', ['tok'], 'invoke', ['shell:bay.confirm', 'tok']],
    ['cancelBay', ['tok'], 'invoke', ['shell:bay.cancel', 'tok']],
    ['rollbackBay', ['dev.a.b'], 'invoke', ['shell:bay.rollback', 'dev.a.b']],
    ['restartLocalServer', [], 'invoke', ['shell:localServer.restart']],
    ['openLocalServerLog', [], 'send', ['shell:localServer.log']],
    ['getLocalServer', [], 'invoke', ['shell:localServer.setting']],
    ['setLocalServer', [false], 'invoke', ['shell:localServer.enable', false]],
    ['relaunch', [], 'send', ['shell:relaunch']],
  ] as const;

  it.each(calls)('%s sends on its channel', async (method, args, kind, call) => {
    const api = (await load('shell')) as Api;
    const result = api[method]!(...args);
    expect(ipc[kind].mock.calls).toEqual([call]);
    // invoke answers reach the caller; send has none.
    if (kind === 'invoke') await expect(result).resolves.toBe('answer');
    else expect(result).toBeUndefined();
    expectRegistered();
  });

  it('covers every method of the shell API in the table above', async () => {
    const api = (await load('shell')) as Api;
    const listeners = ['onJobs', 'onState', 'onWorkspaces'];
    const methods = Object.keys(api).filter((k) => typeof api[k] === 'function');
    expect(methods.filter((m) => !listeners.includes(m)).sort()).toEqual(
      calls.map(([method]) => method).sort(),
    );
    expect(api.locale).toBe('en');
  });

  it('passes on state and job changes until unsubscribed', async () => {
    const api = (await load('shell')) as Api;
    const state = vi.fn();
    const offState = api.onState!(state) as () => void;
    const jobs = vi.fn();
    const offJobs = api.onJobs!(jobs) as () => void;
    const workspaces = vi.fn();
    const offWorkspaces = api.onWorkspaces!(workspaces) as () => void;
    const handlers = Object.fromEntries(ipc.on.mock.calls as [string, (...a: unknown[]) => void][]);
    handlers['shell:state']!({}, { bays: [] });
    handlers['shell:jobs']!({}, 'ignored');
    handlers['shell:workspaces']!({}, 'ignored');
    expect(state).toHaveBeenCalledWith({ bays: [] });
    expect(jobs.mock.calls).toEqual([[]]);
    expect(workspaces.mock.calls).toEqual([[]]);
    offState();
    offJobs();
    offWorkspaces();
    expect(ipc.removeListener.mock.calls).toEqual([
      ['shell:state', handlers['shell:state']],
      ['shell:jobs', handlers['shell:jobs']],
      ['shell:workspaces', handlers['shell:workspaces']],
    ]);
  });
});
