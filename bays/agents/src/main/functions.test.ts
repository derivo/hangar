import { beforeEach, describe, expect, it } from 'vitest';
import type { BayFunction, CallInfo } from '@hangar/sdk';
import { createAgentsBay } from './index';
import { createTempRepo } from './test-repo';
import { fakeSpawn } from './test-pty';
import { fakeContext } from './test-ctx';
import type { SessionManager } from './sessions';

let fns: Map<string, BayFunction>;
let manager: SessionManager;
let info: CallInfo;

beforeEach(async () => {
  const bay = createAgentsBay(fakeSpawn());
  const { ctx, functions } = fakeContext();
  await bay.activate(ctx);
  fns = functions;
  manager = bay.manager!;
  const project = await manager.addProject(createTempRepo());
  const session = await manager.createSession(project.id);
  info = { caller: { kind: 'session', bayId: 'dev.hangar.agents', sessionId: session.id } };
  await bay.deactivate!();
});

const call = (name: string, args: unknown, as = info) => fns.get(name)!(args, as);
const session = () => manager.view().sessions[0]!;

describe('agent bay functions', () => {
  it('registers every manifest function with a JSON schema', () => {
    expect([...fns.keys()]).toEqual([
      'session.setDescription',
      'session.setStatus',
      'statusbar.set',
      'statusbar.remove',
      'job.add',
      'job.list',
      'handover.create',
      'handover.get',
      'quota.report',
      'session.info',
      'project.list',
    ]);
  });

  it('takes the 5-hour limit Claude Code reports through the statusline (ADR 0024)', async () => {
    const bay = createAgentsBay(fakeSpawn(), undefined, '/nowhere');
    const { ctx, functions, invoke } = fakeContext();
    await bay.activate(ctx);
    const report = (args: unknown, as = info) => functions.get('quota.report')!(args, as);
    expect(report({ provider: 'claude', usedPercent: 6, resetsAt: 1_793_300_000 })).toEqual({
      ok: true,
    });
    expect(invoke('quota')).toEqual({ claude: { usedPercent: 6, resetsAt: 1_793_300_000 } });
    expect(ctx.ui.send).toHaveBeenCalledWith('quota', {
      claude: { usedPercent: 6, resetsAt: 1_793_300_000 },
    });
    const week = { usedPercent: 15, resetsAt: 1_793_800_000 };
    report({ provider: 'claude', usedPercent: 6, week });
    expect(invoke('quota')).toEqual({ claude: { usedPercent: 6, week } });
    expect(() =>
      report({ provider: 'claude', usedPercent: 6, week: { usedPercent: 101 } }),
    ).toThrow('Invalid arguments: week.usedPercent');
    expect(() => report({ provider: 'codex', usedPercent: 6 })).toThrow(
      'Invalid arguments: provider',
    );
    expect(() => report({ provider: 'claude', usedPercent: 101 })).toThrow(
      'Invalid arguments: usedPercent',
    );
    expect(() =>
      report({ provider: 'claude', usedPercent: 1 }, { caller: { kind: 'bay', bayId: 'x' } }),
    ).toThrow('Only callable from an agent session');
    await bay.deactivate!();
  });

  it('sets description and status of the calling session', () => {
    expect(call('session.setDescription', { description: 'Tests reparieren' })).toEqual({
      ok: true,
    });
    expect(call('session.setStatus', { status: 'waiting' })).toEqual({ ok: true });
    expect(session()).toMatchObject({ description: 'Tests reparieren', status: 'waiting' });
    expect(call('session.setStatus', { status: 'background' })).toEqual({ ok: true });
    expect(session().status).toBe('background');
  });

  it('sets and removes status bar segments, numbers become text', () => {
    call('statusbar.set', { key: 'tokens', value: 1200, type: 'bar', max: 5000 });
    call('statusbar.set', { key: 'worktree', value: '/tmp/x', type: 'path' });
    expect(session().statusbar).toEqual([
      { key: 'tokens', value: '1200', type: 'bar', max: 5000 },
      { key: 'worktree', value: '/tmp/x', type: 'path' },
    ]);
    call('statusbar.remove', { key: 'tokens' });
    expect(session().statusbar.map((s) => s.key)).toEqual(['worktree']);
  });

  it.each([
    ['session.setStatus', { status: 'busy' }, 'Invalid arguments: status'],
    ['session.setDescription', { description: 'x'.repeat(201) }, 'Invalid arguments: description'],
    ['session.setDescription', null, 'Invalid arguments: args'],
    [
      'statusbar.set',
      { key: 'a b', value: 'x', type: 'text' },
      'Invalid arguments: key: 1–40 characters from A-Z, a-z, 0-9, _ . -',
    ],
    ['statusbar.set', { key: 'k', value: 'x', type: 'chart' }, 'Invalid arguments: type'],
    ['statusbar.set', { key: 'k', value: '5', type: 'bar' }, 'type bar needs max'],
    ['statusbar.set', { key: 'k', value: 'viel', type: 'bar', max: 9 }, 'type bar needs max'],
    ['statusbar.remove', {}, 'Invalid arguments: key'],
  ])('%s rejects %o', (name, args, message) => {
    expect(() => call(name, args)).toThrow(message);
  });

  it('tells other bays the project of a session and the projects (ADR 0037)', async () => {
    const board: CallInfo = { caller: { kind: 'bay', bayId: 'dev.hangar.board' } };
    const { id, projectId } = session();
    manager.update(id, { description: 'Login' });
    const project = manager.view().projects[0]!;
    expect(await call('session.info', { sessionId: id }, board)).toEqual({
      projectId,
      project: project.name,
      name: 'Login',
    });
    expect(await call('project.list', {}, board)).toEqual([
      { id: projectId, name: project.name, shared: false },
    ]);
    // Shared with the workspaces: the board lets agents of other instances in (ADR 0037).
    manager.setProjectShared(projectId, true);
    expect(await call('project.list', {}, board)).toEqual([
      { id: projectId, name: project.name, shared: true },
    ]);
    manager.setProjectShared(projectId, false);
    // Without description: named like `labelSessions`.
    manager.update(id, { description: '' });
    expect(await call('session.info', { sessionId: id }, board)).toMatchObject({
      name: session().branch || id.slice(0, 8),
    });
    expect(() => call('session.info', { sessionId: 'nope' }, board)).toThrow('Unknown session');
    expect(() => call('session.info', {}, board)).toThrow('Invalid arguments');
  });

  it('refuses callers that are not a session', () => {
    expect(() =>
      call('session.setStatus', { status: 'done' }, { caller: { kind: 'bay', bayId: 'x.y' } }),
    ).toThrow('Only callable from an agent session');
  });

  it('rejects unknown sessions', () => {
    const ghost: CallInfo = {
      caller: { kind: 'session', bayId: 'dev.hangar.agents', sessionId: 'g' },
    };
    expect(() => call('session.setStatus', { status: 'done' }, ghost)).toThrow(
      'Unbekannte Session',
    );
  });
});
