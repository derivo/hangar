import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import bay from './index';
import { fakeContext } from './test-ctx';
import type { Task } from './board';

async function started(dataDir?: string) {
  const fake = fakeContext(dataDir);
  await bay.activate(fake.ctx);
  return fake;
}

describe('dev.hangar.board – agents', () => {
  it('adds, lists, claims, notes and finishes tasks of the own project', async () => {
    const { call, agent } = await started();
    const task = (await call(
      'task.add',
      { title: ' Login testen ', description: 'E2E' },
      agent('s1'),
    )) as Task;
    expect(task).toMatchObject({
      projectId: 'p1',
      title: 'Login testen',
      description: 'E2E',
      status: 'open',
      createdBy: 'Login',
      notes: [],
    });
    // Another project sees nothing of it.
    expect(await call('task.list', {}, agent('s3'))).toEqual([]);
    expect(await call('task.list', {}, agent('s2'))).toEqual([task]);
    const claimed = (await call('task.claim', { id: task.id }, agent('s2'))) as Task;
    expect(claimed).toMatchObject({ status: 'doing', sessionId: 's2', sessionName: 'Suche' });
    // Claiming again is fine for the same session.
    await call('task.claim', { id: task.id }, agent('s2'));
    await call('task.note', { id: task.id, text: 'halb fertig' }, agent('s2'));
    const done = (await call('task.done', { id: task.id, note: 'fertig' }, agent('s2'))) as Task;
    expect(done.status).toBe('done');
    expect(done.notes.map((n) => [n.text, n.by])).toEqual([
      ['halb fertig', 'Suche'],
      ['fertig', 'Suche'],
    ]);
    expect(await call('task.list', { status: 'open' }, agent('s1'))).toEqual([]);
    expect(await call('task.list', { status: 'done' }, agent('s1'))).toEqual([done]);
  });

  it('keeps other sessions off a task one took, and off a done task', async () => {
    const { call, agent } = await started();
    const { id } = (await call('task.add', { title: 'A' }, agent('s1'))) as Task;
    await call('task.claim', { id }, agent('s1'));
    for (const [name, args] of [
      ['task.claim', { id }],
      ['task.note', { id, text: 'x' }],
      ['task.done', { id }],
    ] as const)
      await expect(call(name, args, agent('s2'))).rejects.toThrow('Task is taken by session Login');
    await call('task.done', { id }, agent('s1'));
    await expect(call('task.claim', { id }, agent('s2'))).rejects.toThrow('Task is done');
    // Done, it still belongs to the session that took it.
    for (const [name, args] of [
      ['task.note', { id, text: 'x' }],
      ['task.done', { id, note: 'auch' }],
    ] as const)
      await expect(call(name, args, agent('s2'))).rejects.toThrow('Task is taken by session Login');
  });

  it('frees a task whose session ended while the board was not running', async () => {
    const { call, agent, dataDir } = await started();
    const { id } = (await call('task.add', { title: 'A' }, agent('s1'))) as Task;
    await call('task.claim', { id }, agent('s1'));
    const file = join(dataDir, 'board.json');
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll('"s1"', '"gone"'));
    const again = await started(dataDir);
    const taken = (await again.call('task.claim', { id }, agent('s2'))) as Task;
    expect(taken).toMatchObject({ status: 'doing', sessionId: 's2' });
  });

  it('hides tasks of other projects and refuses callers that are no agent session', async () => {
    const { call, agent } = await started();
    const { id } = (await call('task.add', { title: 'A' }, agent('s1'))) as Task;
    await expect(call('task.claim', { id }, agent('s3'))).rejects.toThrow('Unknown task');
    await expect(call('task.claim', { id: 'nope' }, agent('s1'))).rejects.toThrow('Unknown task');
    const bay = { caller: { kind: 'bay' as const, bayId: 'dev.hangar.agents' } };
    await expect(call('task.list', {}, bay)).rejects.toThrow(
      'Only callable from an agent session or another instance',
    );
    const other = { caller: { kind: 'session' as const, bayId: 'dev.other', sessionId: 's1' } };
    await expect(call('task.list', {}, other)).rejects.toThrow(
      'Only callable from an agent session',
    );
    await expect(call('task.list', {}, agent('gone'))).rejects.toThrow('Unknown session');
  });

  it('validates the arguments', async () => {
    const { call, agent } = await started();
    // No arguments at all: as an empty object.
    expect(await call('task.list', undefined, agent('s1'))).toEqual([]);
    for (const [name, args] of [
      ['task.add', { title: '' }],
      ['task.add', { title: 'x'.repeat(201) }],
      ['task.add', { title: 'A', description: 'x'.repeat(4001) }],
      ['task.add', { title: 'A\u001b[31m' }],
      ['task.note', { id: 'x', text: '' }],
      ['task.list', { status: 'later' }],
      ['task.claim', {}],
      ['task.claim', 'x'],
    ] as const)
      await expect(call(name, args, agent('s1'))).rejects.toThrow('Invalid arguments');
  });

  it('opens the tasks of a session again when it ends', async () => {
    const { call, agent, endSession } = await started();
    const { id } = (await call('task.add', { title: 'A' }, agent('s1'))) as Task;
    await call('task.claim', { id }, agent('s1'));
    const other = (await call('task.add', { title: 'B' }, agent('s2'))) as Task;
    await call('task.claim', { id: other.id }, agent('s2'));
    endSession('s1', 'dev.other');
    expect(((await call('task.list', {}, agent('s1'))) as Task[])[0]!.status).toBe('doing');
    endSession('s1');
    const [task, kept] = (await call('task.list', {}, agent('s2'))) as Task[];
    expect(task).toMatchObject({ status: 'open' });
    expect(task!.sessionId).toBeUndefined();
    expect(kept).toMatchObject({ status: 'doing', sessionId: 's2' });
  });
});

describe('dev.hangar.board – person', () => {
  it('adds in a project, reopens, finishes, removes and keeps the board across a restart', async () => {
    const { invoke, ctx, dataDir } = await started();
    expect(await invoke('projects')).toEqual([
      { id: 'p1', name: 'shop', shared: true },
      { id: 'p2', name: 'blog', shared: false },
    ]);
    const task = (await invoke('add', 'p1', { title: 'Release', description: '' })) as Task;
    expect(task).toMatchObject({ projectId: 'p1', createdBy: null, status: 'open' });
    expect(ctx.ui.send).toHaveBeenLastCalledWith('state', [task]);
    await invoke('done', task.id);
    await invoke('reopen', task.id);
    const again = await started(dataDir);
    expect(await again.invoke('state')).toMatchObject([{ id: task.id, status: 'open' }]);
    await again.invoke('remove', task.id);
    expect(await again.invoke('state')).toEqual([]);
    await expect(invoke('add', 'p1', { title: ' ' })).rejects.toThrow('Titel fehlt');
    await expect(invoke('add', 'p1', { title: 'x'.repeat(201) })).rejects.toThrow(
      'Titel zu lang (höchstens 200 Zeichen)',
    );
    await expect(
      invoke('add', 'p1', { title: 'A', description: 'x'.repeat(4001) }),
    ).rejects.toThrow('Beschreibung zu lang (höchstens 4000 Zeichen)');
  });

  it('shows no projects without the agent bay', async () => {
    const { invoke, ctx } = await started();
    ctx.call.mockRejectedValueOnce(new Error('Unknown function'));
    expect(await invoke('projects')).toBeNull();
  });
});

describe('dev.hangar.board – agents of other instances (ADR 0037, Nachtrag)', () => {
  it('works on the tasks of a shared project it names, never of another', async () => {
    const { call, agent, remote } = await started();
    const mine = (await call('task.add', { title: 'Login testen' }, agent('s1'))) as Task;
    expect(await call('task.list', { project: 'shop' }, remote('r1'))).toEqual([mine]);
    // Not shared, unknown or not named: nothing.
    for (const args of [{ project: 'blog' }, { project: 'nope' }, {}])
      await expect(call('task.list', args, remote('r1'))).rejects.toThrow('No such shared project');
    const theirs = (await call(
      'task.add',
      { project: 'shop', title: 'Suche' },
      remote('r1'),
    )) as Task;
    expect(theirs).toMatchObject({ projectId: 'p1', createdBy: 'SHA256:anna01234 (team)' });
    const claimed = (await call(
      'task.claim',
      { project: 'shop', id: mine.id },
      remote('r1'),
    )) as Task;
    expect(claimed).toMatchObject({
      status: 'doing',
      sessionId: 'remote:SHA256:anna0123456789abcdef/r1',
      sessionName: 'SHA256:anna01234 (team)',
    });
    // Its session is not one of the agent bay: the board does not free the task on its own.
    await expect(call('task.claim', { id: mine.id }, agent('s2'))).rejects.toThrow(
      'Task is taken by session SHA256:anna01234 (team)',
    );
    // Another session of that instance, or another instance, does not own it either.
    for (const other of [remote('r2'), remote('r1', 'SHA256:bert'), remote()])
      await expect(
        call('task.note', { project: 'shop', id: mine.id, text: 'x' }, other),
      ).rejects.toThrow('Task is taken');
    await call('task.note', { project: 'shop', id: mine.id, text: 'halb' }, remote('r1'));
    const done = (await call('task.done', { project: 'shop', id: mine.id }, remote('r1'))) as Task;
    expect(done.status).toBe('done');
    // A task of a project that is not shared stays out of reach, by id too.
    const hidden = (await call('task.add', { title: 'Feed' }, agent('s3'))) as Task;
    await expect(
      call('task.claim', { project: 'shop', id: hidden.id }, remote('r1')),
    ).rejects.toThrow();
  });

  it('owns a task per instance when the relay carries no session', async () => {
    const { call, remote } = await started();
    const { id } = (await call('task.add', { project: 'shop', title: 'A' }, remote())) as Task;
    await call('task.claim', { project: 'shop', id }, remote());
    for (const [name, args] of [
      ['task.claim', { project: 'shop', id }],
      ['task.note', { project: 'shop', id, text: 'x' }],
      ['task.done', { project: 'shop', id }],
    ] as const)
      await expect(call(name, args, remote(undefined, 'SHA256:bert'))).rejects.toThrow(
        'Task is taken',
      );
    expect(await call('task.done', { project: 'shop', id }, remote())).toMatchObject({
      status: 'done',
    });
  });

  it('refuses a project name that two shared projects carry', async () => {
    const { call, remote, ctx } = await started();
    ctx.call.mockResolvedValueOnce([
      { id: 'p1', name: 'shop', shared: true },
      { id: 'p3', name: 'shop', shared: true },
    ] as never);
    await expect(call('task.list', { project: 'shop' }, remote())).rejects.toThrow(
      'Project name is ambiguous',
    );
  });

  it('refuses other callers', async () => {
    const { call } = await started();
    await expect(
      call('task.list', {}, { caller: { kind: 'bay', bayId: 'dev.hangar.agents' } }),
    ).rejects.toThrow('Only callable from an agent session or another instance');
  });
});
