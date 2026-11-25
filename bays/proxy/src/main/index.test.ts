import type { Engine, EngineStatus } from './engine';
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxyBay, installAddon } from './index';
import { fakeContext } from './test-ctx';

const status = (state: EngineStatus['state']): EngineStatus => ({
  state,
  version: null,
  reason: null,
  listeners: 0,
  warnings: { broken: 0, unknown: 0, overflow: 0, dropped: 0 },
});

function fakeEngine() {
  let current = status('stopped');
  const statusListeners: ((s: EngineStatus) => void)[] = [];
  const engine = {
    start: vi.fn(),
    stop: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    listen: vi.fn(),
    unlisten: vi.fn(),
    setCapture: vi.fn(),
    ignore: vi.fn(),
    status: () => current,
    onEvent: vi.fn(),
    onStatus: (l: (s: EngineStatus) => void) => void statusListeners.push(l),
  } satisfies Engine;
  const setState = (state: EngineStatus['state']) => {
    current = status(state);
    for (const l of statusListeners) l(current);
  };
  return { engine, setState };
}

function setup() {
  const { engine, setState } = fakeEngine();
  const bay = createProxyBay(() => engine);
  const fake = fakeContext();
  const settingsChanged = () =>
    fake.ctx.settings.onChange.mock.calls[0]![0] as (c: { key: string; value: string }) => void;
  return { bay, engine, setState, ...fake, settingsChanged };
}

describe('dev.hangar.proxy', () => {
  it('reports the engine status to bays and its UI, and status changes to the UI', async () => {
    const { bay, ctx, call, invoke, setState } = setup();
    await bay.activate(ctx);
    expect(ctx.provide).toHaveBeenCalledWith('proxy.status', expect.any(Function), {
      type: 'object',
      properties: {},
    });
    expect(await call('proxy.status')).toMatchObject({ state: 'stopped' });
    setState('running');
    expect(await invoke('status')).toMatchObject({ state: 'running' });
    expect(ctx.ui.send).toHaveBeenCalledWith(
      'status',
      expect.objectContaining({ state: 'running' }),
    );
  });

  it('restarts a started engine when its settings change', async () => {
    const { bay, ctx, engine, setState, settingsChanged } = setup();
    await bay.activate(ctx);
    settingsChanged()({ key: 'mitmdumpPath', value: '/x' });
    expect(engine.restart).not.toHaveBeenCalled(); // never started: nothing to restart
    setState('failed');
    settingsChanged()({ key: 'mitmdumpPath', value: '/x' });
    settingsChanged()({ key: 'other', value: '' });
    expect(engine.restart).toHaveBeenCalledTimes(1);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    engine.restart.mockRejectedValueOnce(new Error('mitmdump not found'));
    settingsChanged()({ key: 'upstreamCaFile', value: '/ca.pem' });
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('[proxy] restart: mitmdump not found'),
    );
    warn.mockRestore();
  });

  it('stops the engine on deactivate', async () => {
    const { bay, ctx, engine } = setup();
    await bay.deactivate?.();
    await bay.activate(ctx);
    await bay.deactivate?.();
    expect(engine.stop).toHaveBeenCalledTimes(1);
  });

  it('builds a real engine by default that starts only on demand', async () => {
    const bay = createProxyBay();
    const { ctx, call } = fakeContext();
    ctx.settings.get.mockReturnValue('');
    await bay.activate(ctx);
    expect(await call('proxy.status')).toMatchObject({ state: 'stopped', listeners: 0 });
    await bay.deactivate?.();
  });
});

describe('installAddon', () => {
  it('copies the addon into the data folder and rewrites it only when it changed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-proxy-addon-'));
    const source = join(dir, 'source.py');
    writeFileSync(source, 'addons = []\n');
    const target = installAddon(join(dir, 'data'), source);
    expect(target).toBe(join(dir, 'data', 'addon', 'hangar_proxy.py'));
    expect(readFileSync(target, 'utf8')).toBe('addons = []\n');
    const written = statSync(target).mtimeMs;
    utimesSync(target, 0, 0);
    installAddon(join(dir, 'data'), source);
    expect(statSync(target).mtimeMs).toBe(0);
    writeFileSync(source, 'addons = [1]\n');
    installAddon(join(dir, 'data'), source);
    expect(readFileSync(target, 'utf8')).toBe('addons = [1]\n');
    expect(written).toBeGreaterThan(0);
  });

  it('defaults to the addon of the bay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-proxy-addon-'));
    expect(readFileSync(installAddon(dir), 'utf8')).toContain('class HangarProxy');
  });
});
