import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bayDefault, { createAgentsBay } from './index';
import { createTempRepo } from './test-repo';
import { fakeSpawn } from './test-pty';
import { fakeContext } from './test-ctx';
import { setLocale } from './messages';
import type { Project, SessionRecord, StateView } from './types';
import type { RemoteBayState } from '@hangar/sdk';

afterEach(() => vi.useRealTimers());

describe('agents bay main', () => {
  it('shares projects with the workspaces and shows what others share (ADR 0030)', async () => {
    const bay = createAgentsBay(fakeSpawn());
    const { ctx, invoke } = fakeContext();
    const listeners: ((states: RemoteBayState[]) => void)[] = [];
    const anna = { workspace: 'team', instance: 'f'.repeat(64), name: 'Anna' };
    const workspaces = {
      publish: vi.fn(),
      states: vi.fn((): RemoteBayState[] => [
        { ...anna, state: { projects: [{ name: 'web', sessions: [] }] } },
      ]),
      onState: vi.fn((l: (states: RemoteBayState[]) => void) => void listeners.push(l)),
    };
    await bay.activate({ ...ctx, workspaces });
    // Published at the start, before anything changed: nothing shared yet.
    expect(workspaces.publish).toHaveBeenLastCalledWith({ projects: [] });
    expect(invoke('remote')).toEqual([{ ...anna, project: 'web', sessions: [] }]);
    const repo = createTempRepo();
    ctx.pickFolder.mockResolvedValueOnce(repo);
    const project = (await invoke('project.add')) as Project;
    invoke('project.setShared', project.id, true);
    expect(workspaces.publish).toHaveBeenLastCalledWith({
      projects: [{ name: project.name, sessions: [] }],
    });
    listeners[0]!([{ ...anna, state: { projects: [{ name: 'api', sessions: [] }] } }]);
    expect(ctx.ui.send).toHaveBeenCalledWith('remote', [{ ...anna, project: 'api', sessions: [] }]);
    await bay.deactivate?.();
  });

  it('shows no remote projects without workspaces', async () => {
    const bay = createAgentsBay(fakeSpawn());
    const { invoke, ctx } = fakeContext();
    await bay.activate(ctx);
    expect(invoke('remote')).toEqual([]);
    await bay.deactivate?.();
  });

  it('exports a ready bay', () => {
    expect(typeof bayDefault.activate).toBe('function');
  });

  it('wires every UI channel to the session manager', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const spawn = fakeSpawn();
    const bay = createAgentsBay(spawn);
    const { ctx, invoke, settingValues } = fakeContext();
    await bay.activate(ctx);

    expect(await invoke('project.add')).toBeUndefined();
    const repo = createTempRepo();
    ctx.pickFolder.mockResolvedValueOnce(repo);
    const project = (await invoke('project.add')) as Project;
    expect(project.path).toBe(repo);

    // ADR 0023: new sessions copy on select as the app's setting says.
    settingValues.copyOnSelect = false;
    // ADR 0022: a new session from the UI always starts in the project folder.
    const session = (await invoke('session.create', project.id, 'worktree')) as SessionRecord;
    expect(session).toMatchObject({ place: 'project', worktreePath: repo, copyOnSelect: false });
    const pty = spawn.all[0]!;
    invoke('session.input', session.id, 'ls\r');
    invoke('session.resize', session.id, 90, 20);
    expect(pty.written).toEqual(['ls\r']);
    expect(pty.size).toEqual([90, 20]);
    pty.emitData('out');
    expect(invoke('session.buffer', session.id)).toBe('out');
    expect(invoke('session.snapshot', session.id)).toEqual({ data: 'out', end: 3 });
    expect(ctx.ui.send).toHaveBeenCalledWith('session.data', {
      id: session.id,
      data: 'out',
      end: 3,
    });

    const label = ctx.labelSessions.mock.calls[0]![0];
    // Without description and branch the short id names the session.
    expect(label(session.id)).toBe(session.id.slice(0, 8));
    expect(label('unknown')).toBeUndefined();
    invoke('session.update', session.id, { description: 'Neu' });
    expect(label(session.id)).toBe('Neu');
    invoke('session.restart', session.id);
    expect(spawn.all).toHaveLength(2);
    expect((invoke('state') as StateView).sessions[0]!.description).toBe('Neu');
    bay.manager!.setStatus(session.id, 'waiting');
    expect(ctx.notify).toHaveBeenCalledWith({
      title: 'Session wartet auf Eingabe',
      body: expect.stringContaining('Neu'),
    });
    expect(ctx.setBadge).toHaveBeenCalledWith(1);

    invoke('project.setEnv', project.id, { DB: 'dev' });
    expect((invoke('state') as StateView).projects[0]!.env).toEqual({ DB: 'dev' });
    expect(await invoke('project.details', project.id)).toEqual({
      worktrees: [{ sessionId: session.id, changes: 0, ahead: null }],
      orphans: [],
    });
    await expect(invoke('project.deleteBranch', project.id, 'main')).rejects.toThrow(
      'Kein verwaister Hangar-Branch: main',
    );

    ctx.pickFolder.mockResolvedValueOnce(createTempRepo());
    const second = (await invoke('project.add')) as Project;
    invoke('project.move', second.id, 0);
    expect((invoke('state') as StateView).projects.map((p) => p.id)).toEqual([
      second.id,
      project.id,
    ]);
    invoke('session.move', session.id, 0);
    await invoke('project.remove', second.id);

    vi.advanceTimersByTime(35_000);
    await invoke('session.close', session.id);
    await invoke('project.remove', project.id);
    expect(invoke('state')).toEqual({ projects: [], sessions: [] });

    await bay.deactivate!();
  });

  it('takes passwords from the secrets bay for shells and lists them for the form (ADR 0021)', async () => {
    const spawn = fakeSpawn();
    const bay = createAgentsBay(spawn);
    const { ctx, invoke } = fakeContext();
    await bay.activate(ctx);
    ctx.call.mockImplementation(async (target: string, args: unknown) =>
      target === 'dev.hangar.secrets/secret.list'
        ? [{ name: 'TOKEN', description: 'CI', updatedAt: 'x' }]
        : { TOKEN: `wert für ${JSON.stringify(args)}` },
    );
    expect(await invoke('secrets')).toEqual([{ name: 'TOKEN', description: 'CI', updatedAt: 'x' }]);
    const repo = createTempRepo();
    ctx.pickFolder.mockResolvedValueOnce(repo);
    const project = (await invoke('project.add')) as Project;
    invoke('project.setEnv', project.id, { GH: { secret: 'TOKEN' } });
    await invoke('session.create', project.id);
    await vi.waitFor(() => expect(spawn.all).toHaveLength(1));
    expect(ctx.call).toHaveBeenCalledWith('dev.hangar.secrets/secret.resolve', {
      names: ['TOKEN'],
    });
    expect(spawn.all[0]!.options.env.GH).toBe('wert für {"names":["TOKEN"]}');
    // Without the secrets bay the form shows no list, not an error.
    ctx.call.mockRejectedValueOnce(new Error('Unknown function'));
    expect(await invoke('secrets')).toBeNull();
    await bay.deactivate!();
  });

  it('speaks the app language: folder picker title and errors shown in the UI', async () => {
    const bay = createAgentsBay(fakeSpawn());
    const { ctx, invoke } = fakeContext('en');
    try {
      await bay.activate(ctx);
      await invoke('project.add');
      expect(ctx.pickFolder).toHaveBeenCalledWith({ title: 'Add project' });
      // Without a folder dialog (server, ADR 0018) the UI passes a path the host checks.
      await invoke('project.add', '/srv/repos/app');
      expect(ctx.pickFolder).toHaveBeenLastCalledWith({
        title: 'Add project',
        path: '/srv/repos/app',
      });
      await expect(invoke('session.close', 'nope')).rejects.toThrow('Unknown session: nope');
      // On a server the language follows the desktop that connected last (ADR 0019).
      for (const listener of ctx.onLocaleChange.mock.calls.map(([l]) => l)) listener('de');
      await expect(invoke('session.close', 'nope')).rejects.toThrow('Unbekannte Session: nope');
    } finally {
      await bay.deactivate!();
      setLocale('de');
    }
  });

  it('reads the Codex limit at start and every minute (ADR 0024)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const home = mkdtempSync(join(tmpdir(), 'hangar-codex-'));
    const bay = createAgentsBay(fakeSpawn(), undefined, home);
    const { ctx, invoke } = fakeContext();
    await bay.activate(ctx);
    expect(invoke('quota')).toEqual({});
    const day = join(home, 'sessions', '2026', '10', '30');
    mkdirSync(day, { recursive: true });
    const primary = { used_percent: 9, window_minutes: 300, resets_at: 1000 };
    writeFileSync(
      join(day, 'a.jsonl'),
      JSON.stringify({ payload: { rate_limits: { primary } } }) + '\n',
    );
    vi.advanceTimersByTime(59_000);
    expect(invoke('quota')).toEqual({});
    vi.advanceTimersByTime(1_000);
    expect(invoke('quota')).toEqual({ codex: { usedPercent: 9, resetsAt: 1000 } });
    await bay.deactivate!();
    vi.useRealTimers();
  });

  it('deactivates safely before activation', async () => {
    await createAgentsBay(fakeSpawn()).deactivate!();
  });
});
