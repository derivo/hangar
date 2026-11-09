import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Scheduler } from '@hangar/scheduler';
import { BayRuntime, type HostServices } from './bay-runtime';
import type { LoadedBay } from './bay-loader';
import type { BayBrowser, BayContext, BayWorkspaces } from '@hangar/sdk';

function setup(
  mainSource?: string,
  hostModules?: ('browser' | 'workspaces' | 'secrets')[],
  settings?: LoadedBay['manifest']['settings'],
  extra: Partial<LoadedBay['manifest']> = { agentSessions: true, uses: ['dev.hangar.other/x'] },
) {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-bay-'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'hangar-data-'));
  if (mainSource) {
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'main.cjs'), mainSource);
  }
  const bay: LoadedBay = {
    dir,
    manifest: {
      id: 'dev.hangar.test',
      name: 'Test',
      version: '0.1.0',
      icon: 'icon.svg',
      ui: 'index.html',
      main: mainSource ? 'dist/main.cjs' : undefined,
      functions: [{ name: 'echo.say', sensitive: false }],
      ...(hostModules && { hostModules }),
      ...(settings && { settings }),
      ...extra,
    },
  };
  const services: HostServices = {
    dataRoot,
    hangarVersion: '0.1.0',
    locale: 'en',
    pickFolder: vi.fn(async () => '/picked'),
    notify: vi.fn(),
    badgeChanged: vi.fn(),
    runningChanged: vi.fn(),
    sendToUi: vi.fn(),
    provide: vi.fn(),
    call: vi.fn(async () => 'called'),
    registerAgentSession: vi.fn(() => ({ token: 't', mcpUrl: 'u', cliDir: 'c' })),
    unregisterAgentSession: vi.fn(),
    scheduler: new Scheduler({ file: join(dataRoot, 'jobs.json') }),
    browser: vi.fn((bayId: string) => ({ bayId }) as unknown as BayBrowser),
    workspaces: vi.fn((bayId: string) => ({ bayId }) as unknown as BayWorkspaces),
    secrets: { encrypt: (text: string) => `x${text}`, decrypt: (data: string) => data.slice(1) },
    baySettings: vi.fn((): Record<string, boolean> => ({ copy: false, stray: true })),
  };
  return { runtime: new BayRuntime(bay, services), services, dataRoot };
}

describe('BayRuntime', () => {
  it('runs without a main part', async () => {
    const { runtime } = setup();
    await runtime.activate();
    await runtime.deactivate();
    await expect(runtime.handleUi('x', [])).rejects.toThrow('No handler for "x"');
  });

  it('creates the data dir and wires the context into activate/deactivate', async () => {
    const { runtime, services, dataRoot } = setup(`
      let ctx;
      module.exports = {
        activate(c) {
          ctx = c;
          globalThis.__ctx = c;
          c.ui.handle('add', (a, b) => a + b);
        },
        deactivate() { globalThis.__deactivated = ctx.bayId; },
      };
    `);
    await runtime.activate();
    const ctx = (globalThis as Record<string, unknown>).__ctx as import('@hangar/sdk').BayContext;
    expect(ctx.bayId).toBe('dev.hangar.test');
    expect(ctx.hangarVersion).toBe('0.1.0');
    expect(ctx.locale).toBe('en');
    expect(ctx.dataDir).toBe(join(dataRoot, 'dev.hangar.test'));
    expect(existsSync(ctx.dataDir)).toBe(true);

    expect(await runtime.handleUi('add', [2, 3])).toBe(5);

    ctx.ui.send('evt', { a: 1 });
    expect(services.sendToUi).toHaveBeenCalledWith('dev.hangar.test', 'evt', { a: 1 });
    ctx.notify({ title: 'Hallo' });
    expect(services.notify).toHaveBeenCalledWith('dev.hangar.test', { title: 'Hallo' });
    ctx.setBadge(3);
    expect(runtime.badge).toBe(3);
    expect(services.badgeChanged).toHaveBeenCalledWith('dev.hangar.test', 3);
    // The shells it runs, for the tray of the local server (ADR 0036).
    ctx.setRunning(2.7);
    ctx.setRunning(-1);
    expect(services.runningChanged).toHaveBeenNthCalledWith(1, 'dev.hangar.test', 2);
    expect(services.runningChanged).toHaveBeenNthCalledWith(2, 'dev.hangar.test', 0);
    expect(await ctx.pickFolder()).toBe('/picked');
    expect(ctx.registerAgentSession('s1')).toEqual({ token: 't', mcpUrl: 'u', cliDir: 'c' });
    expect(services.registerAgentSession).toHaveBeenCalledWith('dev.hangar.test', 's1');
    ctx.unregisterAgentSession('s1');
    expect(services.unregisterAgentSession).toHaveBeenCalledWith('dev.hangar.test', 's1');

    const handler = () => 'hi';
    ctx.provide('echo.say', handler, { type: 'object' });
    expect(services.provide).toHaveBeenCalledWith(
      'dev.hangar.test',
      { name: 'echo.say', sensitive: false, inputSchema: { type: 'object' } },
      handler,
    );
    expect(() => ctx.provide('not.declared', handler)).toThrow(
      'Function "not.declared" is not declared in the manifest',
    );
    expect(await ctx.call('dev.hangar.other/x', { a: 1 })).toBe('called');
    expect(services.call).toHaveBeenCalledWith(
      { kind: 'bay', bayId: 'dev.hangar.test', declared: true },
      'dev.hangar.other/x',
      { a: 1 },
    );

    await runtime.deactivate();
    expect((globalThis as Record<string, unknown>).__deactivated).toBe('dev.hangar.test');
  });

  it('lets a bay call only what its manifest lists in uses, besides its own functions', async () => {
    const { runtime, services } = setup(
      `module.exports = { activate(c) { globalThis.__usesCtx = c; } };`,
      undefined,
      undefined,
      { uses: ['dev.hangar.other/x'] },
    );
    await runtime.activate();
    const ctx = (globalThis as Record<string, unknown>).__usesCtx as BayContext;
    await expect(ctx.call('dev.hangar.other/y')).rejects.toThrow(
      'Access denied: dev.hangar.test → dev.hangar.other/y (not in the manifest\'s "uses")',
    );
    await expect(ctx.call('dev.hangar.other')).rejects.toThrow('Access denied');
    expect(services.call).not.toHaveBeenCalled();
    expect(await ctx.call('dev.hangar.other/x')).toBe('called');
    expect(await ctx.call('dev.hangar.test/echo.say')).toBe('called');
    // Declared calls tell the bus so; it lets non-sensitive ones pass without a dialog.
    const call = (caller: object, target: string) =>
      expect.objectContaining({ 0: caller, 1: target }) as unknown;
    expect(vi.mocked(services.call).mock.calls).toEqual([
      call({ kind: 'bay', bayId: 'dev.hangar.test', declared: true }, 'dev.hangar.other/x'),
      call({ kind: 'bay', bayId: 'dev.hangar.test' }, 'dev.hangar.test/echo.say'),
    ]);
  });

  it('refuses every foreign call without uses', async () => {
    const { runtime, services } = setup(
      `module.exports = { activate(c) { globalThis.__noUsesCtx = c; } };`,
      undefined,
      undefined,
      {},
    );
    await runtime.activate();
    const ctx = (globalThis as Record<string, unknown>).__noUsesCtx as BayContext;
    await expect(ctx.call('dev.hangar.other/x')).rejects.toThrow('Access denied');
    expect(services.call).not.toHaveBeenCalled();
  });

  it('issues agent session tokens only to bays with agentSessions', async () => {
    const { runtime, services } = setup(
      `module.exports = { activate(c) { globalThis.__noSessionsCtx = c; } };`,
      undefined,
      undefined,
      {},
    );
    await runtime.activate();
    const ctx = (globalThis as Record<string, unknown>).__noSessionsCtx as BayContext;
    expect(() => ctx.registerAgentSession('s1')).toThrow(
      'registerAgentSession needs "agentSessions": true in the manifest',
    );
    expect(services.registerAgentSession).not.toHaveBeenCalled();
  });

  it('accepts ESM-style default exports', async () => {
    const { runtime } = setup(`exports.default = { activate(c) { c.ui.handle('v', () => 1); } };`);
    await runtime.activate();
    expect(await runtime.handleUi('v', [])).toBe(1);
  });

  it('ignores negative or fractional badge counts', async () => {
    const { runtime } = setup(`module.exports = { activate(c) { c.setBadge(-2); } };`);
    await runtime.activate();
    expect(runtime.badge).toBe(0);
  });

  it('names agent sessions for the settings once the bay labels them', async () => {
    const { runtime } = setup(
      `module.exports = { activate(c) { c.labelSessions((id) => id === 's1' ? 'Login' : undefined); } };`,
    );
    expect(runtime.sessionLabel('s1')).toBeUndefined();
    await runtime.activate();
    expect(runtime.sessionLabel('s1')).toBe('Login');
    expect(runtime.sessionLabel('s2')).toBeUndefined();
  });

  it('ends the agent sessions a bay still has when it is deactivated', async () => {
    // Removing a bay must not leave its session tokens valid (Codex review 2026-10-30).
    const { runtime, services } = setup(`
      module.exports = { activate(c) {
        c.registerAgentSession('open');
        c.registerAgentSession('closed');
        c.unregisterAgentSession('closed');
      } };
    `);
    await runtime.activate();
    vi.mocked(services.unregisterAgentSession).mockClear();
    await runtime.deactivate();
    expect(services.unregisterAgentSession).toHaveBeenCalledTimes(1);
    expect(services.unregisterAgentSession).toHaveBeenCalledWith('dev.hangar.test', 'open');
  });

  it('ends the sessions and job handler also when the bay fails to deactivate', async () => {
    const { runtime, services } = setup(`
      module.exports = {
        activate(c) { c.registerAgentSession('open'); c.jobs.onRun(() => 'x'); },
        deactivate() { throw new Error('kaputt'); },
      };
    `);
    await runtime.activate();
    const job = services.scheduler.add('dev.hangar.test', { label: 'j', schedule: '* * * * *' });
    await expect(runtime.deactivate()).rejects.toThrow('kaputt');
    expect(services.unregisterAgentSession).toHaveBeenCalledWith('dev.hangar.test', 'open');
    await expect(services.scheduler.runNow(job.id)).rejects.toThrow('is not loaded');
  });

  it('gives a bay its own jobs and drops its handler on deactivate', async () => {
    const { runtime, services } = setup(`
      module.exports = { activate(c) { globalThis.__jobsCtx = c; c.jobs.onRun((job) => 'ran ' + job.label); } };
    `);
    await runtime.activate();
    const ctx = (globalThis as Record<string, unknown>)
      .__jobsCtx as import('@hangar/sdk').BayContext;
    const other = services.scheduler.add('dev.hangar.other', { label: 'o', schedule: '* * * * *' });
    const job = ctx.jobs.add({ label: 'nightly', schedule: '0 2 * * *', payload: { a: 1 } });
    expect(job).toMatchObject({ bayId: 'dev.hangar.test', label: 'nightly', payload: { a: 1 } });
    expect(ctx.jobs.list().map((j) => j.id)).toEqual([job.id]);
    expect(await services.scheduler.runNow(job.id)).toMatchObject({
      ok: true,
      output: 'ran nightly',
    });
    expect(() => ctx.jobs.remove(other.id)).toThrow(`Unknown job "${other.id}"`);
    ctx.jobs.remove(job.id);
    expect(ctx.jobs.list()).toEqual([]);

    const again = ctx.jobs.add({ label: 'x', schedule: '* * * * *' });
    await runtime.deactivate();
    await expect(services.scheduler.runNow(again.id)).rejects.toThrow('is not loaded');
  });

  it('tells the bay about ended agent sessions, also when a listener fails (ADR 0016)', async () => {
    const { runtime } = setup(`
      module.exports = {
        activate(c) {
          globalThis.__ended = [];
          c.onAgentSessionEnded(() => { throw new Error('kaputt'); });
          c.onAgentSessionEnded((s) => globalThis.__ended.push(s));
        },
      };
    `);
    await runtime.activate();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    runtime.agentSessionEnded({ bayId: 'dev.hangar.agents', sessionId: 's1' });

    expect((globalThis as Record<string, unknown>).__ended).toEqual([
      { bayId: 'dev.hangar.agents', sessionId: 's1' },
    ]);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it('tells the bay when the language changes, once per change (server, ADR 0019)', async () => {
    const { runtime } = setup(`
      module.exports = {
        activate(c) {
          globalThis.__localeCtx = c;
          globalThis.__locales = [];
          c.onLocaleChange(() => { throw new Error('kaputt'); });
          c.onLocaleChange((l) => globalThis.__locales.push(l));
        },
      };
    `);
    await runtime.activate();
    // A failing listener stops neither the others nor the caller (Codex review).
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    runtime.localeChanged('de');
    runtime.localeChanged('de');
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
    const g = globalThis as Record<string, unknown>;
    expect(g.__locales).toEqual(['de']);
    expect((g.__localeCtx as BayContext).locale).toBe('de');
  });

  it('reads declared settings with their defaults and reports changes (ADR 0023)', async () => {
    const label = { de: 'x', en: 'x' };
    const { runtime, services } = setup(
      `module.exports = {
        activate(c) {
          globalThis.__settingsCtx = c;
          globalThis.__settingChanges = [];
          c.settings.onChange((change) => globalThis.__settingChanges.push(change));
        },
      };`,
      undefined,
      [
        { key: 'copy', type: 'boolean', default: true, label },
        { key: 'other', type: 'boolean', default: true, label },
      ],
    );
    await runtime.activate();
    const g = globalThis as Record<string, unknown>;
    const ctx = g.__settingsCtx as BayContext;
    expect(ctx.settings.get('copy')).toBe(false);
    expect(ctx.settings.get('other')).toBe(true);
    // Undeclared keys are not the bay's, even when stored.
    expect(ctx.settings.get('stray')).toBe(false);
    expect(services.baySettings).toHaveBeenCalledWith('dev.hangar.test');

    vi.mocked(services.baySettings).mockReturnValue({ copy: true });
    runtime.settingChanged('copy');
    runtime.settingChanged('stray');
    expect(g.__settingChanges).toEqual([{ key: 'copy', value: true }]);
    expect(ctx.settings.get('copy')).toBe(true);
  });

  it('gives the browser only to bays that declare the host module', async () => {
    const main = `module.exports = { activate(c) { globalThis.__browserCtx = c; } };`;
    const ctxOf = () => (globalThis as Record<string, unknown>).__browserCtx as BayContext;
    const plain = setup(main);
    await plain.runtime.activate();
    expect(ctxOf().browser).toBeUndefined();
    expect(plain.services.browser).not.toHaveBeenCalled();

    const browsing = setup(main, ['browser']);
    await browsing.runtime.activate();
    expect(ctxOf().browser).toEqual({ bayId: 'dev.hangar.test' });
    expect(browsing.runtime.hasHostModule('browser')).toBe(true);
    expect(plain.runtime.hasHostModule('browser')).toBe(false);
  });

  it('gives workspaces only to bays that declare the host module (ADR 0030)', async () => {
    const main = `module.exports = { activate(c) { globalThis.__wsCtx = c; } };`;
    const ctxOf = () => (globalThis as Record<string, unknown>).__wsCtx as BayContext;
    const plain = setup(main);
    await plain.runtime.activate();
    expect(ctxOf().workspaces).toBeUndefined();
    expect(plain.services.workspaces).not.toHaveBeenCalled();

    const sharing = setup(main, ['workspaces']);
    await sharing.runtime.activate();
    expect(ctxOf().workspaces).toEqual({ bayId: 'dev.hangar.test' });
  });

  it('gives the keychain only to bays that declare the host module secrets (ADR 0021)', async () => {
    const main = `module.exports = { activate(c) { globalThis.__secretsCtx = c; } };`;
    const ctxOf = () => (globalThis as Record<string, unknown>).__secretsCtx as BayContext;
    await setup(main).runtime.activate();
    expect(ctxOf().secrets).toBeUndefined();
    await setup(main, ['secrets']).runtime.activate();
    expect(ctxOf().secrets!.decrypt(ctxOf().secrets!.encrypt('geheim'))).toBe('geheim');
  });
});
