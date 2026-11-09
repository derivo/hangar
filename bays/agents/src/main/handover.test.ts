import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BayFunction, CallInfo, RemoteBayState } from '@hangar/sdk';
import { gitEnv } from './git';
import { createAgentsBay } from './index';
import { createTempRepo } from './test-repo';
import { fakeSpawn } from './test-pty';
import { fakeContext } from './test-ctx';
import type { SessionManager } from './sessions';
import type { Project, SessionRecord } from './types';

const anna = 'a'.repeat(64);
const remote = (workspace = 'team', instance = anna): CallInfo => ({
  caller: { kind: 'remote', instance, workspace, bayId: 'dev.hangar.agents' },
});

let fns: Map<string, BayFunction>;
let manager: SessionManager;
let project: Project;
let sender: SessionRecord;
let deactivate: () => Promise<void> | void;

beforeEach(async () => {
  const bay = createAgentsBay(fakeSpawn());
  const { ctx, functions } = fakeContext();
  const states = (): RemoteBayState[] => [
    { workspace: 'team', instance: anna, name: 'Anna', state: { projects: [] } },
  ];
  await bay.activate({ ...ctx, workspaces: { publish: vi.fn(), states, onState: vi.fn() } });
  fns = functions;
  manager = bay.manager!;
  deactivate = () => bay.deactivate!();
  project = await manager.addProject(createTempRepo('shop'));
  sender = await manager.createSession(project.id);
  manager.update(sender.id, { description: 'Login bauen' });
});
afterEach(() => deactivate());

const asSession = (id: string): CallInfo => ({
  caller: { kind: 'session', bayId: 'dev.hangar.agents', sessionId: id },
});
const call = (name: string, args: unknown, as = asSession(sender.id)) =>
  fns.get(name)!(args, as) as Promise<unknown>;
const newest = () => manager.view().sessions.at(-1)!;
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitEnv() }).trim();

describe('handovers (ADR 0031)', () => {
  it('a session hands work over to a new session that starts on its branch', async () => {
    git(
      sender.worktreePath,
      '-c',
      'user.name=Hangar Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'wip',
    );
    const result = await call('handover.create', {
      task: 'Tests für den Login schreiben',
      branch: sender.branch,
      context: 'Formular steht, Validierung fehlt.',
    });
    const target = newest();
    expect(result).toEqual({ sessionId: target.id });
    expect(target).toMatchObject({
      projectId: project.id,
      handover: {
        origin: 'local',
        from: 'Login bauen',
        task: 'Tests für den Login schreiben',
        branch: sender.branch,
        context: 'Formular steht, Validierung fehlt.',
      },
    });
    // Its own branch, starting where the sender's work stands.
    expect(target.branch).not.toBe(sender.branch);
    expect(git(target.worktreePath, 'rev-parse', 'HEAD')).toBe(
      git(sender.worktreePath, 'rev-parse', 'HEAD'),
    );
    expect(await call('handover.get', {}, asSession(target.id))).toEqual(target.handover);
    expect(await call('handover.get', {})).toBeNull();
  });

  it('without a branch the new session starts from the project; another project by name', async () => {
    const other = await manager.addProject(createTempRepo('api'));
    await call('handover.create', { task: 'API anpassen', project: 'api' });
    expect(newest()).toMatchObject({
      projectId: other.id,
      handover: { origin: 'local', from: 'Login bauen', task: 'API anpassen' },
    });
    await expect(call('handover.create', { task: 'x', project: 'web' })).rejects.toThrow(
      'No such project',
    );
  });

  it.each([
    ['an empty task', { task: '' }, 'Invalid arguments: task'],
    ['a task over 2000 characters', { task: 'x'.repeat(2001) }, 'Invalid arguments: task'],
    [
      'context over 4000 characters',
      { task: 'x', context: 'x'.repeat(4001) },
      'Invalid arguments: context',
    ],
    [
      'a branch that is an option',
      { task: 'x', branch: '--upload-pack=evil' },
      'Invalid arguments: branch',
    ],
    ['a branch with ..', { task: 'x', branch: 'a..b' }, 'Invalid arguments: branch'],
    ['a file remote', { task: 'x', remote: 'file:///etc/passwd' }, 'Invalid arguments: remote'],
    ['an ext:: remote', { task: 'x', remote: 'ext::sh -c id' }, 'Invalid arguments: remote'],
    [
      'a terminal escape in the task',
      { task: 'x\u001b]52;c;ZXZpbA==\u0007' },
      'Invalid arguments: task',
    ],
    [
      'a control character in the context',
      { task: 'x', context: 'a\u0000b' },
      'Invalid arguments: context',
    ],
  ])('refuses %s', async (_label, args, error) => {
    await expect(call('handover.create', args)).rejects.toThrow(error);
  });

  it('another instance hands over only into a shared project, as text and Git references', async () => {
    const args = {
      project: 'shop',
      task: 'Review des Login-Branches',
      branch: 'feature/login',
      remote: 'git@github.com:anna/shop.git',
    };
    await expect(call('handover.create', args, remote())).rejects.toThrow('No such shared project');
    manager.setProjectShared(project.id, true);
    expect(await call('handover.create', args, remote())).toEqual({ ok: true });
    // Nothing is fetched: the branch exists only on the other side.
    expect(newest()).toMatchObject({
      projectId: project.id,
      handover: {
        origin: 'remote',
        from: 'Anna (team)',
        task: 'Review des Login-Branches',
        branch: 'feature/login',
        remote: 'git@github.com:anna/shop.git',
      },
    });
    // An instance the workspace states do not name yet is shown by its fingerprint.
    const cara = 'c'.repeat(64);
    await call('handover.create', { project: 'shop', task: 'y' }, remote('club', cara));
    expect(newest().handover!.from).toBe(`${cara.slice(0, 16)} (club)`);
  });

  it('refuses a project name that two projects carry, unless it is the own or the one shared', async () => {
    const twin = await manager.addProject(createTempRepo('shop'));
    expect(twin.name).toBe(project.name);
    const other = await manager.createSession(twin.id);
    const remoteArgs = { project: 'shop', task: 'x' };
    // Exactly one of them shared: that one, whether it stands first or second in the tree.
    for (const shared of [project, twin]) {
      manager.setProjectShared(project.id, shared === project);
      manager.setProjectShared(twin.id, shared === twin);
      expect(await call('handover.create', remoteArgs, remote())).toEqual({ ok: true });
      expect(newest().projectId).toBe(shared.id);
    }
    manager.setProjectShared(project.id, true);
    const before = manager.view().sessions.length;
    await expect(call('handover.create', remoteArgs, remote())).rejects.toThrow(
      'Project name is ambiguous',
    );
    expect(manager.view().sessions).toHaveLength(before);
    // A session naming its own project's name, or none, means its own project.
    for (const [from, args] of [
      [sender, { project: 'shop', task: 'x' }],
      [other, { project: 'shop', task: 'x' }],
      [other, { task: 'x' }],
    ] as const) {
      const { sessionId } = (await call('handover.create', args, asSession(from.id))) as {
        sessionId: string;
      };
      expect(manager.view().sessions.find((s) => s.id === sessionId)!.projectId).toBe(
        from.projectId,
      );
    }
  });

  it('refuses a name that two other projects carry for a local session', async () => {
    const blog = await manager.addProject(createTempRepo('blog'));
    await manager.addProject(createTempRepo('blog'));
    expect(blog.name).toBe('blog');
    await expect(call('handover.create', { project: 'blog', task: 'x' })).rejects.toThrow(
      'Project name is ambiguous',
    );
  });

  it('a share withdrawn while the handover waits in line stops it', async () => {
    manager.setProjectShared(project.id, true);
    // The queue is busy with another session; the share ends before the handover's turn.
    const busy = manager.createSession(project.id);
    const handover = call('handover.create', { project: 'shop', task: 'x' }, remote());
    manager.setProjectShared(project.id, false);
    await busy;
    await expect(handover).rejects.toThrow('No such shared project');
    expect(manager.view().sessions.filter((s) => s.handover)).toEqual([]);
  });

  it('names the sender by its branch or project while it has no description', async () => {
    manager.update(sender.id, { description: '' });
    await call('handover.create', { task: 'a' });
    expect(newest().handover!.from).toBe(sender.branch);
    const inFolder = await manager.createSession(project.id, {}, 'project');
    await call('handover.create', { task: 'b' }, asSession(inFolder.id));
    expect(newest().handover!.from).toBe('shop');
  });

  it('at most five open sessions from other instances', async () => {
    manager.setProjectShared(project.id, true);
    for (let i = 0; i < 5; i++)
      await call('handover.create', { project: 'shop', task: `t${i}` }, remote());
    await expect(
      call('handover.create', { project: 'shop', task: 't5' }, remote()),
    ).rejects.toThrow('Too many open handovers');
    await manager.closeSession(newest().id);
    await call('handover.create', { project: 'shop', task: 't6' }, remote());
  });

  it('is for agent sessions and other instances only', async () => {
    const bay: CallInfo = { caller: { kind: 'bay', bayId: 'dev.hangar.notes' } };
    await expect(call('handover.create', { task: 'x' }, bay)).rejects.toThrow(
      'Only callable from an agent session or another instance',
    );
    await expect(call('handover.get', {}, bay)).rejects.toThrow(
      'Only callable from an agent session',
    );
  });
});
