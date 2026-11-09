import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { ShellApi, ShellState } from '../shared';

const base: ShellState = {
  bays: [],
  errors: [],
  servers: [],
  shortcuts: [],
  selected: null,
  available: [],
};

beforeAll(() => {
  globalThis.ResizeObserver = class {
    constructor(private readonly cb: () => void) {}
    observe() {
      this.cb();
    }
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

function fakeApi(initial: ShellState) {
  let listener: (s: ShellState) => void = () => {};
  const api: ShellApi = {
    locale: 'de',
    getState: vi.fn(async () => initial),
    getOverview: vi.fn(async () => ({
      version: '0.1.0',
      git: { installed: false },
      bays: [],
      errors: [],
    })),
    getJobs: vi.fn(async () => ({ bays: [], jobs: [], servers: [] })),
    setJobPaused: vi.fn(async () => {}),
    runJob: vi.fn(async () => {}),
    removeJob: vi.fn(async () => {}),
    onJobs: vi.fn(() => () => {}),
    getPermissions: vi.fn(async () => ({ bays: [], functions: [], grants: [] })),
    revoke: vi.fn(async () => {}),
    setGrant: vi.fn(async () => {}),
    getSettings: vi.fn(async () => ({
      updateChannel: 'stable' as const,
      language: 'system' as const,
      theme: 'system' as const,
      bays: [],
      baySettings: {},
      shortcuts: [],
    })),
    setTheme: vi.fn(async () => {}),
    getBaySettings: vi.fn(async () => []),
    setBaySetting: vi.fn(async () => {}),
    setUpdateChannel: vi.fn(async () => {}),
    setLanguage: vi.fn(async () => {}),
    select: vi.fn(),
    addBay: vi.fn(async () => {}),
    bayMenu: vi.fn(),
    setModal: vi.fn(),
    setHintHeight: vi.fn(),
    probeServer: vi.fn(),
    pairServer: vi.fn(),
    cancelProbe: vi.fn(),
    serverMenu: vi.fn(),
    pickShortcut: vi.fn(),
    addUrlShortcut: vi.fn(),
    openShortcut: vi.fn(),
    shortcutMenu: vi.fn(),
    moveBay: vi.fn(),
    moveShortcut: vi.fn(),
    getWorkspaces: vi.fn(async () => ({
      status: 'off' as const,
      name: 'anna-mac',
      fingerprint: 'a'.repeat(64),
      workspaces: [],
      functions: [],
    })),
    connectRelay: vi.fn(),
    createWorkspace: vi.fn(),
    inviteToWorkspace: vi.fn(),
    joinWorkspace: vi.fn(),
    acceptMember: vi.fn(),
    rejectMember: vi.fn(),
    removeMember: vi.fn(),
    setWorkspaceShare: vi.fn(),
    onWorkspaces: vi.fn(() => () => {}),
    getBayCatalog: vi.fn(async () => null),
    prepareBay: vi.fn(),
    confirmBay: vi.fn(),
    cancelBay: vi.fn(),
    rollbackBay: vi.fn(),
    restartLocalServer: vi.fn(async () => {}),
    openLocalServerLog: vi.fn(),
    getLocalServer: vi.fn(async () => null),
    setLocalServer: vi.fn(async () => {}),
    relaunch: vi.fn(),
    onState: (l) => {
      listener = l;
      return () => {};
    },
  };
  return { api, push: (s: ShellState) => act(() => listener(s)) };
}

describe('App', () => {
  it('loads the initial state and follows pushed updates', async () => {
    const { api, push } = fakeApi(base);
    render(<App api={api} />);
    expect(await screen.findByText('Keine Bay geladen.')).toBeVisible();
    push({ ...base, selected: 'settings' });
    expect(screen.getByRole('heading', { name: 'Einstellungen' })).toBeVisible();
    push({ ...base, selected: 'overview' });
    expect(await screen.findByRole('heading', { name: 'Hangar-Übersicht' })).toBeVisible();
  });

  it('says on a bay of the local server that it is down, restarts it and opens its log', async () => {
    const key = 'remote:loc:dev.hangar.agents';
    const bay = { id: key, name: 'Agents', icon: 'data:image/svg+xml;base64,PHN2Zy8+', badge: 0 };
    const down: ShellState = {
      ...base,
      selected: key,
      localServer: {
        status: 'failed',
        error: 'Cannot reach ws://127.0.0.1:1/connect',
        bays: [bay],
      },
    };
    const { api, push } = fakeApi(down);
    render(<App api={api} />);
    expect(
      await screen.findByRole('heading', { name: 'Lokaler Server läuft nicht' }),
    ).toBeVisible();
    expect(screen.getByText('Cannot reach ws://127.0.0.1:1/connect')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Neu starten' }));
    expect(api.restartLocalServer).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Log öffnen' }));
    expect(api.openLocalServerLog).toHaveBeenCalled();
    push({ ...down, localServer: { status: 'connecting', bays: [bay] } });
    expect(screen.getByRole('heading', { name: 'Lokaler Server startet …' })).toBeVisible();
    // Connected, the bay's view lies over the content; only another bay shows nothing here.
    push({ ...down, localServer: { status: 'connected', bays: [bay] } });
    expect(screen.queryByRole('heading')).toBeNull();
    push({ ...down, selected: 'dev.other', localServer: { status: 'failed', bays: [bay] } });
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('shows the hint of a new version above a bay of the local server, with the restart', async () => {
    const key = 'remote:loc:dev.hangar.agents';
    const bay = { id: key, name: 'Agents', icon: 'data:image/svg+xml;base64,PHN2Zy8+', badge: 0 };
    const { api } = fakeApi({
      ...base,
      selected: key,
      localServer: {
        status: 'connected',
        bays: [bay],
        update: { running: '0.1.0', ready: '0.2.0' },
      },
    });
    render(<App api={api} />);
    const hint = await screen.findByRole('region', { name: 'Neue Version' });
    expect(hint).toHaveTextContent(
      'Neue Version bereit: Im lokalen Server läuft Hangar 0.1.0, installiert ist 0.2.0.',
    );
    // It grows with its text (200 % zoom) and tells the host, which moves the bay below it.
    expect(hint.style.minHeight).toBe('48px');
    // ResizeObserver reports after the next layout, on a slow runner later than the render.
    await vi.waitFor(() => expect(api.setHintHeight).toHaveBeenCalledWith(hint.offsetHeight));
    await userEvent.click(within(hint).getByRole('button', { name: 'Lokalen Server neu starten' }));
    expect(api.restartLocalServer).toHaveBeenCalled();
  });

  it('shows in the hint that the local server restarts, without the button', async () => {
    const key = 'remote:loc:dev.hangar.agents';
    const bay = { id: key, name: 'Agents', icon: 'data:image/svg+xml;base64,PHN2Zy8+', badge: 0 };
    const { api } = fakeApi({
      ...base,
      selected: key,
      localServer: {
        status: 'connected',
        bays: [bay],
        update: { running: '0.1.0', ready: '0.2.0' },
        restarting: true,
      },
    });
    render(<App api={api} />);
    const hint = await screen.findByRole('region', { name: 'Neue Version' });
    expect(within(hint).getByRole('status')).toHaveTextContent('Lokaler Server startet …');
    expect(within(hint).queryByRole('button')).toBeNull();
  });
});
