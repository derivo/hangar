import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Scheduler } from '@hangar/scheduler';
import type { CallInfo } from '@hangar/sdk';
import { createAgentsBay } from './index';
import { createTempRepo, PLAIN_SHELL } from './test-repo';
import { fakeSpawn, type FakeSpawn } from './test-pty';
import { fakeContext } from './test-ctx';
import type { SessionManager } from './sessions';
import type { SessionRecord } from './types';

let spawn: FakeSpawn;
let bay: ReturnType<typeof createAgentsBay>;
let manager: SessionManager;
let scheduler: Scheduler;
let invoke: ReturnType<typeof fakeContext>['invoke'];
let functions: ReturnType<typeof fakeContext>['functions'];
let session: SessionRecord;
let info: CallInfo;

beforeEach(async () => {
  spawn = fakeSpawn();
  bay = createAgentsBay(spawn, PLAIN_SHELL);
  const fake = fakeContext();
  ({ invoke, functions, scheduler } = fake);
  await bay.activate(fake.ctx);
  manager = bay.manager!;
  const project = await manager.addProject(createTempRepo());
  session = await manager.createSession(project.id);
  info = { caller: { kind: 'session', bayId: 'dev.hangar.agents', sessionId: session.id } };
});
afterEach(() => bay.deactivate!());

describe('agent bay jobs', () => {
  it('adds a job for a session and runs its command in the worktree', async () => {
    const job = invoke('job.add', session.id, ' echo 5 passed ', '0 2 * * *') as { id: string };
    expect(scheduler.list()[0]).toMatchObject({
      id: job.id,
      label: 'echo 5 passed',
      schedule: '0 2 * * *',
      payload: { sessionId: session.id, command: 'echo 5 passed' },
    });
    expect(await scheduler.runNow(job.id)).toMatchObject({
      ok: true,
      output: 'Exit-Code 0: 5 passed',
    });

    const failing = invoke('job.add', session.id, 'exit 2', '0 2 * * *') as { id: string };
    expect(await scheduler.runNow(failing.id)).toMatchObject({ ok: false, output: 'Exit-Code 2' });
  });

  it.each([
    ['unknown session', 'nope', 'ls', '* * * * *', 'Unbekannte Session: nope'],
    ['empty command', undefined, '  ', '* * * * *', 'Befehl fehlt'],
    ['empty schedule', undefined, 'ls', '', 'Zeitplan fehlt'],
    ['blank schedule', undefined, 'ls', '   ', 'Zeitplan fehlt'],
    [
      'invalid schedule',
      undefined,
      'ls',
      '* * *',
      'Ungültiger Zeitplan „* * *“: fünf Felder (Minute Stunde Tag Monat Wochentag), z. B. 0 2 * * 1-5',
    ],
  ])('rejects a job with %s', (_name, id, command, schedule, message) => {
    expect(() => invoke('job.add', id ?? session.id, command, schedule)).toThrow(message);
    expect(scheduler.list()).toEqual([]);
  });

  it('deletes the jobs of a closed session', async () => {
    invoke('job.add', session.id, 'ls', '* * * * *');
    await manager.closeSession(session.id);
    expect(scheduler.list()).toEqual([]);
  });

  it('lets an agent add and list jobs of its own session', async () => {
    const added = (await functions.get('job.add')!(
      { command: 'pnpm lint', schedule: '30 6 * * 1-5' },
      info,
    )) as { id: string; nextRun: number };
    expect(added.nextRun).toBeGreaterThan(Date.now());
    const other = await manager.createSession(session.projectId);
    invoke('job.add', other.id, 'ls', '* * * * *');

    expect(functions.get('job.list')!({}, info)).toEqual([
      {
        id: added.id,
        command: 'pnpm lint',
        schedule: '30 6 * * 1-5',
        paused: false,
        nextRun: added.nextRun,
      },
    ]);
    expect(() =>
      functions.get('job.add')!({ command: 'ls', schedule: '99 * * * *' }, info),
    ).toThrow('Invalid schedule "99 * * * *": minute: 99 is outside 0-59');
    expect(() => functions.get('job.add')!({ command: '', schedule: '* * * * *' }, info)).toThrow(
      'Invalid arguments: command',
    );
  });
});
