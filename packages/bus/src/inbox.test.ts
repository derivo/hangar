import { describe, expect, it, vi } from 'vitest';
import { Bus } from './bus';
import { MemoryInboxStore, previewOf } from './inbox';
import { MemoryPermissionStore } from './permissions';
import type { ActivityEvent, Caller, CallInfo, RemoteAccess } from './types';

const board = 'dev.hangar.board';
const fp = 'SHA256:ben';
const ben: Caller = { kind: 'remote', instance: fp, workspace: 'team', bayId: board };
const add = `${board}/task.add`;

function setup(options: { trusted?: boolean; inbox?: MemoryInboxStore } = {}) {
  const state = { member: true, shared: true, trusted: options.trusted ?? false };
  const access: RemoteAccess = {
    isMember: () => state.member,
    isShared: () => state.shared,
    isTrusted: () => state.trusted,
    memberName: () => 'Ben',
  };
  const prompter = { ask: vi.fn(async () => 'deny' as const) };
  const permissions = new MemoryPermissionStore();
  const activity: ActivityEvent[] = [];
  const inbox = options.inbox ?? new MemoryInboxStore();
  const bus = new Bus({
    permissions,
    prompter,
    remote: access,
    inbox,
    now: () => new Date('2026-11-16T10:00:00Z'),
    onActivity: (e) => activity.push(e),
  });
  const handler = vi.fn((args: unknown, info: CallInfo) => ({ id: 7, args, info }));
  bus.register(board, { name: 'task.add', sensitive: false, remote: true, inbox: true }, handler);
  bus.register(board, { name: 'task.list', sensitive: false, remote: true }, () => []);
  return { bus, access: state, prompter, permissions, activity, handler, inbox };
}

describe('Inbox (ADR 0046)', () => {
  it('queues a remote call of an inbox function instead of running it', async () => {
    const { bus, handler, prompter, activity } = setup();
    const answer = (await bus.call(ben, add, { title: 'Fix\u0007 it' })) as { queued: string };
    expect(answer).toEqual({ queued: expect.any(String) });
    expect(handler).not.toHaveBeenCalled();
    expect(prompter.ask).not.toHaveBeenCalled();
    expect(bus.inboxEntries()).toEqual([
      expect.objectContaining({ id: answer.queued, target: add, caller: ben, state: 'pending' }),
    ]);
    expect(activity).toEqual([
      {
        at: '2026-11-16T10:00:00.000Z',
        direction: 'in',
        workspace: 'team',
        instance: fp,
        name: 'Ben',
        target: add,
        outcome: 'queued',
        preview: 'Fix it',
        inboxId: answer.queued,
      },
    ]);
  });

  it('runs an accepted entry with an execution id and returns its result', async () => {
    const { bus, handler, activity } = setup();
    const { queued } = (await bus.call(ben, add, { title: 'x' })) as { queued: string };
    const result = (await bus.acceptInbox(queued)) as { info: CallInfo };
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.info).toEqual({ caller: ben, executionId: expect.any(String) });
    expect(bus.inboxEntries()).toEqual([]);
    expect(activity.map((e) => e.outcome)).toEqual(['queued', 'accepted']);
    await expect(bus.acceptInbox(queued)).rejects.toThrow('No open inbox entry');
  });

  it('drops a rejected entry without running it', async () => {
    const { bus, handler, activity } = setup();
    const { queued } = (await bus.call(ben, add, { title: 'x' })) as { queued: string };
    bus.rejectInbox(queued);
    expect(handler).not.toHaveBeenCalled();
    expect(bus.inboxEntries()).toEqual([]);
    expect(activity.map((e) => e.outcome)).toEqual(['queued', 'rejected']);
    expect(() => bus.rejectInbox(queued)).toThrow('No open inbox entry');
  });

  it('blocks an accept after the caller left the workspace or the share was withdrawn', async () => {
    const { bus, access, handler, activity } = setup();
    const first = (await bus.call(ben, add, {})) as { queued: string };
    const second = (await bus.call(ben, add, {})) as { queued: string };
    access.member = false;
    await expect(bus.acceptInbox(first.queued)).rejects.toThrow('Access denied');
    access.member = true;
    access.shared = false;
    await expect(bus.acceptInbox(second.queued)).rejects.toThrow('Access denied');
    expect(handler).not.toHaveBeenCalled();
    expect(bus.inboxEntries()).toEqual([]);
    expect(activity.map((e) => e.outcome)).toEqual(['queued', 'queued', 'denied', 'denied']);
  });

  it('logs a failing accepted call as failed', async () => {
    const { bus, handler, activity } = setup();
    handler.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const { queued } = (await bus.call(ben, add, {})) as { queued: string };
    await expect(bus.acceptInbox(queued)).rejects.toThrow('boom');
    expect(activity.map((e) => e.outcome)).toEqual(['queued', 'failed']);
    expect(bus.inboxEntries()).toEqual([]);
  });

  it('runs at once and returns the real result for a trusted member', async () => {
    const { bus, handler, activity } = setup({ trusted: true });
    expect(await bus.call(ben, add, { title: 'x' })).toEqual(
      expect.objectContaining({ id: 7, info: { caller: ben } }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(bus.inboxEntries()).toEqual([]);
    expect(activity.map((e) => [e.outcome, e.preview])).toEqual([['ran', 'x']]);
  });

  it('applies a stored denial before the inbox', async () => {
    const { bus, permissions, activity } = setup({ trusted: true });
    permissions.set({ subject: `remote:${fp}/${board}`, target: add, mode: 'deny' });
    await expect(bus.call(ben, add, {})).rejects.toThrow('Access denied');
    expect(bus.inboxEntries()).toEqual([]);
    expect(activity.map((e) => e.outcome)).toEqual(['denied']);
  });

  it('leaves local callers alone and logs nothing for them', async () => {
    const { bus, handler, activity } = setup();
    await bus.call({ kind: 'bay', bayId: board }, add, {});
    await bus.call({ kind: 'session', bayId: board, sessionId: 's' }, add, {});
    expect(handler).toHaveBeenCalledTimes(2);
    expect(activity).toEqual([]);
  });

  it('logs other remote calls as ran or denied, without a preview', async () => {
    const { bus, permissions, activity } = setup();
    permissions.set({
      subject: `remote:${fp}/${board}`,
      target: `${board}/task.list`,
      mode: 'allow',
    });
    await bus.call(ben, `${board}/task.list`, { title: 'secret' });
    permissions.set({
      subject: `remote:${fp}/${board}`,
      target: `${board}/task.list`,
      mode: 'deny',
    });
    await expect(bus.call(ben, `${board}/task.list`, {})).rejects.toThrow('Access denied');
    expect(activity.map((e) => [e.outcome, e.preview])).toEqual([
      ['ran', undefined],
      ['denied', undefined],
    ]);
  });

  it('keeps at most 200 open entries and rejects the oldest', async () => {
    const { bus, activity } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 201; i++)
      ids.push(((await bus.call(ben, add, { n: String(i) })) as { queued: string }).queued);
    const open = bus.inboxEntries();
    expect(open).toHaveLength(200);
    expect(open.map((e) => e.id)).not.toContain(ids[0]);
    expect(activity.filter((e) => e.outcome === 'rejected')).toEqual([
      expect.objectContaining({ inboxId: ids[0] }),
    ]);
  });

  it('reserves an entry once: a second accept while the first runs fails', async () => {
    const { bus, handler } = setup();
    let release!: () => void;
    handler.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ id: 1 }))) as never,
    );
    const { queued } = (await bus.call(ben, add, {})) as { queued: string };
    const running = bus.acceptInbox(queued);
    await expect(bus.acceptInbox(queued)).rejects.toThrow('No open inbox entry');
    expect(() => bus.rejectInbox(queued)).toThrow('No open inbox entry');
    release();
    await running;
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('runs an entry left in "accepting" again with the same execution id', async () => {
    const inbox = new MemoryInboxStore();
    inbox.save([
      {
        id: 'i1',
        at: '2026-11-16T09:00:00.000Z',
        caller: ben,
        target: add,
        args: { title: 'x' },
        preview: 'x',
        state: 'accepting',
        executionId: 'e1',
      },
    ]);
    const { bus, handler, activity } = setup({ inbox });
    await bus.resumeInbox();
    expect(handler).toHaveBeenCalledWith({ title: 'x' }, { caller: ben, executionId: 'e1' });
    expect(bus.inboxEntries()).toEqual([]);
    expect(activity.map((e) => e.outcome)).toEqual(['accepted']);
  });
});

describe('Inbox, Codex review of step 1-3', () => {
  it('puts an entry back to pending when a resume cannot check it yet (not connected)', async () => {
    const inbox = new MemoryInboxStore();
    const entry = {
      id: 'i1',
      at: '2026-11-16T09:00:00.000Z',
      caller: ben,
      target: add,
      args: { title: 'x' },
      preview: 'x',
      state: 'accepting' as const,
      executionId: 'e1',
    };
    inbox.save([entry]);
    const { bus, access, handler, activity } = setup({ inbox });
    access.member = false;
    await bus.resumeInbox();
    expect(bus.inboxEntries()).toEqual([{ ...entry, state: 'pending' }]);
    expect(activity).toEqual([]);
    // Accepted again later, it keeps its execution id: a run before the crash is not repeated.
    access.member = true;
    await bus.acceptInbox('i1');
    expect(handler).toHaveBeenCalledWith({ title: 'x' }, { caller: ben, executionId: 'e1' });
  });
});

describe('previewOf', () => {
  it('takes only text fields, never a Git remote or a token (Codex)', () => {
    expect(
      previewOf({
        title: 'Fix',
        remote: 'https://user:SECRET@git.example/repo',
        token: 'TOKEN',
        task: 'do',
      }),
    ).toBe('Fix · do');
  });

  it('joins the string arguments, removes control characters, cuts at 200', () => {
    expect(previewOf({ title: 'a\nb', note: 'c‮d', n: 3 })).toBe('a b · c d');
    expect(previewOf({ title: 'x'.repeat(300) })).toHaveLength(200);
    expect(previewOf('plain')).toBe('plain');
    expect(previewOf(null)).toBe('');
  });
});
