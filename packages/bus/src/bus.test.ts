import { describe, expect, it, vi } from 'vitest';
import { Bus, PermissionDeniedError, subjectOf } from './bus';
import { MemoryPermissionStore } from './permissions';
import type { Caller, Decision, Prompter } from './types';

const agents = 'dev.hangar.agents';
const vault = 'dev.hangar.vault';
const session: Caller = { kind: 'session', bayId: agents, sessionId: 's1' };
const otherSession: Caller = { kind: 'session', bayId: agents, sessionId: 's2' };
const browser: Caller = { kind: 'bay', bayId: 'dev.hangar.browser' };

function setup(answers: Decision[] = []) {
  const prompter: Prompter & { ask: ReturnType<typeof vi.fn> } = {
    ask: vi.fn(async () => answers.shift() ?? 'deny'),
  };
  const permissions = new MemoryPermissionStore();
  const bus = new Bus({ permissions, prompter });
  const setStatus = vi.fn((args: unknown) => ({ ok: args }));
  bus.register(agents, { name: 'session.setStatus', sensitive: false }, setStatus);
  bus.register(vault, { name: 'secret.read', sensitive: true }, () => 'geheim');
  bus.register(vault, { name: 'entry.count', sensitive: false }, () => 3);
  return { bus, prompter, permissions, setStatus };
}

describe('Bus routing', () => {
  it('lets a bay call what its manifest declares in `uses` without asking (ADR 0032)', async () => {
    const { bus, prompter, permissions } = setup(['deny']);
    const declared = [
      { kind: 'bay', bayId: agents, declared: true },
      { kind: 'local-server', bayId: agents, declared: true },
    ] as const;
    for (const caller of declared)
      expect(await bus.call(caller, `${vault}/entry.count`, {})).toBe(3);
    expect(prompter.ask).not.toHaveBeenCalled();
    // Sensitive still asks; a denial from the settings still holds.
    await expect(bus.call(declared[0], `${vault}/secret.read`, {})).rejects.toThrow(
      'Access denied',
    );
    expect(prompter.ask).toHaveBeenCalledTimes(1);
    bus.setMode(agents, `${vault}/entry.count`, 'deny');
    await expect(bus.call(declared[0], `${vault}/entry.count`, {})).rejects.toThrow(
      'Access denied',
    );
    expect(permissions.get(agents, `${vault}/entry.count`)?.mode).toBe('deny');
  });

  it('lets only bays call functions for bays, never an agent (ADR 0021)', async () => {
    // The local server is a subject of its own: asked once more.
    const { bus, prompter } = setup(['allow', 'allow']);
    const resolve = vi.fn(() => ({ TOKEN: 'geheim' }));
    bus.register(vault, { name: 'secret.resolve', sensitive: true, bayOnly: true }, resolve);
    const target = `${vault}/secret.resolve`;
    const agentsBay: Caller = { kind: 'bay', bayId: agents };
    const callers: Caller[] = [
      session,
      { kind: 'session', bayId: vault, sessionId: 's9' },
      { kind: 'local-server', bayId: agents, sessionId: 's1' },
      { kind: 'remote', bayId: agents, instance: 'SHA256:x', workspace: 'w' },
    ];
    for (const caller of callers)
      await expect(bus.call(caller, target, {})).rejects.toThrow(PermissionDeniedError);
    expect(prompter.ask).not.toHaveBeenCalled();
    expect(await bus.call(agentsBay, target, {})).toEqual({ TOKEN: 'geheim' });
    expect(await bus.call({ kind: 'local-server', bayId: agents }, target, {})).toEqual({
      TOKEN: 'geheim',
    });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('lists registered functions with their full id', () => {
    const { bus } = setup();
    expect(bus.list().map((f) => f.id)).toEqual([
      'dev.hangar.agents/session.setStatus',
      'dev.hangar.vault/secret.read',
      'dev.hangar.vault/entry.count',
    ]);
  });

  it('passes args and caller to the handler and returns its result', async () => {
    const { bus, setStatus } = setup();
    expect(await bus.call(session, `${agents}/session.setStatus`, { status: 'done' })).toEqual({
      ok: { status: 'done' },
    });
    expect(setStatus).toHaveBeenCalledWith({ status: 'done' }, { caller: session });
  });

  it('runs nothing whose signal aborted during the dialog (the caller went away)', async () => {
    const { bus, prompter } = setup(['allow']);
    const vaultRead = vi.fn(() => 'geheim');
    bus.unregisterBay(vault);
    bus.register(vault, { name: 'secret.read', sensitive: true }, vaultRead);
    const gone = new AbortController();
    prompter.ask.mockImplementationOnce(async () => (gone.abort(), 'allow'));
    await expect(bus.call(session, `${vault}/secret.read`, {}, gone.signal)).rejects.toThrow(
      'aborted',
    );
    expect(vaultRead).not.toHaveBeenCalled();
  });

  it('rejects unknown and malformed targets', async () => {
    const { bus } = setup();
    await expect(bus.call(session, `${agents}/nope`, {})).rejects.toThrow(
      'Unknown function: dev.hangar.agents/nope',
    );
    await expect(bus.call(session, 'nope', {})).rejects.toThrow('Unknown function: nope');
  });

  it('refuses duplicate registrations and forgets unregistered bays', async () => {
    const { bus } = setup();
    expect(() => bus.register(vault, { name: 'entry.count', sensitive: false }, () => 1)).toThrow(
      'Function is already registered: dev.hangar.vault/entry.count',
    );
    bus.unregisterBay(vault);
    expect(bus.list()).toHaveLength(1);
  });

  it('routes through a custom transport', async () => {
    const { bus } = setup();
    const invoke = vi.fn(async () => 'remote');
    bus.registerTransport('dev.remote.bay', { name: 'x.y', sensitive: false }, { invoke });
    expect(await bus.call({ kind: 'bay', bayId: 'dev.remote.bay' }, 'dev.remote.bay/x.y', 1)).toBe(
      'remote',
    );
    expect(invoke).toHaveBeenCalledWith('dev.remote.bay/x.y', 1, {
      caller: { kind: 'bay', bayId: 'dev.remote.bay' },
    });
  });

  it('leaves the check to a transport that authorizes itself (ADR 0036, Nachtrag)', async () => {
    const { bus, prompter } = setup();
    const invoke = vi.fn(async () => 'app');
    bus.registerTransport(
      'dev.hangar.secrets',
      { name: 'secret.resolve', sensitive: true, bayOnly: true },
      { invoke, authorizes: true },
    );
    const bay: Caller = { kind: 'bay', bayId: agents };
    expect(await bus.call(bay, 'dev.hangar.secrets/secret.resolve', {})).toBe('app');
    expect(prompter.ask).not.toHaveBeenCalled();
    // `bayOnly` still holds here, before the far side.
    await expect(bus.call(session, 'dev.hangar.secrets/secret.resolve', {})).rejects.toThrow(
      PermissionDeniedError,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('Bus permissions', () => {
  it('always allows non-sensitive functions of the own bay, for bays and their sessions', async () => {
    const { bus, prompter } = setup();
    await bus.call(session, `${agents}/session.setStatus`, {});
    await bus.call({ kind: 'bay', bayId: agents }, `${agents}/session.setStatus`, {});
    await bus.call({ kind: 'bay', bayId: vault }, `${vault}/secret.read`, {});
    expect(prompter.ask).not.toHaveBeenCalled();
  });

  it('asks on first cross-bay access and stores the answer', async () => {
    const { bus, prompter, permissions } = setup(['allow']);
    expect(await bus.call(browser, `${vault}/entry.count`, {})).toBe(3);
    expect(await bus.call(browser, `${vault}/entry.count`, {})).toBe(3);
    expect(prompter.ask).toHaveBeenCalledTimes(1);
    expect(prompter.ask).toHaveBeenCalledWith({
      caller: browser,
      target: `${vault}/entry.count`,
      sensitive: false,
      kind: 'grant',
    });
    expect(permissions.list()).toEqual([
      {
        subject: 'dev.hangar.browser',
        target: `${vault}/entry.count`,
        mode: 'allow',
        grantedAt: expect.any(String),
      },
    ]);
  });

  it('stores a denial and rejects later calls without asking', async () => {
    const { bus, prompter } = setup(['deny']);
    await expect(bus.call(browser, `${vault}/entry.count`, {})).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await expect(bus.call(browser, `${vault}/entry.count`, {})).rejects.toThrow(
      'Access denied: dev.hangar.browser → dev.hangar.vault/entry.count',
    );
    expect(prompter.ask).toHaveBeenCalledTimes(1);
  });

  it('lets agents of any bay call functions open to agents without asking (ADR 0016)', async () => {
    const { bus, prompter, permissions } = setup();
    bus.register(vault, { name: 'tab.open', sensitive: false, openToAgents: true }, () => 'tab');

    expect(await bus.call(session, `${vault}/tab.open`, {})).toBe('tab');
    expect(prompter.ask).not.toHaveBeenCalled();
    expect(permissions.list()).toEqual([]);
  });

  it('keeps asking bays and honours a denial for functions open to agents', async () => {
    const { bus, prompter } = setup(['deny']);
    bus.register(vault, { name: 'tab.open', sensitive: false, openToAgents: true }, () => 'tab');

    await expect(bus.call(browser, `${vault}/tab.open`, {})).rejects.toThrow('Access denied');
    expect(prompter.ask).toHaveBeenCalledTimes(1);
    bus.setMode(agents, `${vault}/tab.open`, 'deny');
    await expect(bus.call(session, `${vault}/tab.open`, {})).rejects.toThrow('Access denied');
  });

  it('treats non-sensitive answers other than allow as deny', async () => {
    const { bus, permissions } = setup(['session']);
    await expect(bus.call(browser, `${vault}/entry.count`, {})).rejects.toThrow('Access denied');
    expect(permissions.get('dev.hangar.browser', `${vault}/entry.count`)?.mode).toBe('deny');
  });

  it('agents of a bay share its cross-bay grants', async () => {
    const { bus, prompter } = setup(['allow']);
    await bus.call(session, `${vault}/entry.count`, {});
    await bus.call(otherSession, `${vault}/entry.count`, {});
    expect(prompter.ask).toHaveBeenCalledTimes(1);
  });

  it('never auto-grants sensitive functions to agents, even of the own bay', async () => {
    const { bus, prompter } = setup(['deny']);
    bus.register(agents, { name: 'secret.peek', sensitive: true }, () => 'x');
    await expect(bus.call(session, `${agents}/secret.peek`, {})).rejects.toThrow('Access denied');
    expect(prompter.ask).toHaveBeenCalledWith(expect.objectContaining({ sensitive: true }));
  });

  it('sensitive grant "session" is valid for that agent session only and not stored', async () => {
    const { bus, prompter, permissions } = setup(['session', 'deny']);
    expect(await bus.call(session, `${vault}/secret.read`, {})).toBe('geheim');
    expect(await bus.call(session, `${vault}/secret.read`, {})).toBe('geheim');
    await expect(bus.call(otherSession, `${vault}/secret.read`, {})).rejects.toThrow(
      'Access denied',
    );
    expect(prompter.ask).toHaveBeenCalledTimes(2);
    expect(permissions.list()).toEqual([
      {
        subject: agents,
        target: `${vault}/secret.read`,
        mode: 'deny',
        grantedAt: expect.any(String),
      },
    ]);
    expect(bus.grants()).toContainEqual(
      expect.objectContaining({
        subject: agents,
        target: `${vault}/secret.read`,
        mode: 'session',
        sessionId: 's1',
      }),
    );
  });

  it('a session grant asked by a bay (no session) applies to this call only', async () => {
    const { bus, prompter } = setup(['session', 'deny']);
    expect(await bus.call(browser, `${vault}/secret.read`, {})).toBe('geheim');
    await expect(bus.call(browser, `${vault}/secret.read`, {})).rejects.toThrow('Access denied');
    expect(prompter.ask).toHaveBeenCalledTimes(2);
  });

  it('sensitive grant "ask" confirms every access', async () => {
    const { bus, prompter } = setup(['ask', 'allow', 'deny']);
    expect(await bus.call(browser, `${vault}/secret.read`, {})).toBe('geheim');
    expect(await bus.call(browser, `${vault}/secret.read`, {})).toBe('geheim');
    await expect(bus.call(browser, `${vault}/secret.read`, {})).rejects.toThrow('Access denied');
    expect(prompter.ask.mock.calls.map((c) => c[0].kind)).toEqual(['grant', 'confirm', 'confirm']);
  });

  it('sensitive grant "allow" is permanent', async () => {
    const { bus, prompter } = setup(['allow']);
    await bus.call(browser, `${vault}/secret.read`, {});
    await bus.call(browser, `${vault}/secret.read`, {});
    expect(prompter.ask).toHaveBeenCalledTimes(1);
  });

  it('revokes stored and session grants', async () => {
    const { bus, prompter } = setup(['allow', 'session', 'deny', 'deny']);
    await bus.call(browser, `${vault}/entry.count`, {});
    await bus.call(session, `${vault}/secret.read`, {});
    bus.revoke('dev.hangar.browser', `${vault}/entry.count`);
    bus.revoke(agents, `${vault}/secret.read`, 's1');
    expect(bus.grants()).toEqual([]);
    await expect(bus.call(browser, `${vault}/entry.count`, {})).rejects.toThrow();
    await expect(bus.call(session, `${vault}/secret.read`, {})).rejects.toThrow();
    expect(prompter.ask).toHaveBeenCalledTimes(4);
  });

  it('lets a denial from the settings beat a session grant', async () => {
    const { bus } = setup(['session']);
    await bus.call(session, `${vault}/secret.read`, {});
    bus.setMode(agents, `${vault}/secret.read`, 'deny');
    await expect(bus.call(session, `${vault}/secret.read`, {})).rejects.toThrow('Access denied');
  });

  it('forgets session grants when a session ends', async () => {
    const { bus } = setup(['session']);
    await bus.call(session, `${vault}/secret.read`, {});
    bus.endSession('s1');
    expect(bus.grants()).toEqual([]);
  });

  it('rejects a call whose session ended while the dialog was open', async () => {
    const { bus, prompter } = setup();
    prompter.ask.mockImplementation(async () => {
      bus.endSession('s1');
      return 'session';
    });
    await expect(bus.call(session, `${vault}/secret.read`, {})).rejects.toThrow(
      PermissionDeniedError,
    );
    expect(bus.grants()).toEqual([]);
  });

  it('asks again for a session that started anew after it ended', async () => {
    const { bus } = setup(['session']);
    bus.endSession('s1');
    bus.startSession('s1');
    expect(await bus.call(session, `${vault}/secret.read`, {})).toBe('geheim');
  });

  it('keeps a denial set while the dialog was open', async () => {
    const { bus, prompter } = setup();
    prompter.ask.mockImplementation(async () => {
      bus.setMode(agents, `${vault}/secret.read`, 'deny');
      return 'allow';
    });
    await expect(bus.call(session, `${vault}/secret.read`, {})).rejects.toThrow(
      PermissionDeniedError,
    );
    expect(bus.grants()).toEqual([expect.objectContaining({ mode: 'deny' })]);
  });

  it('refuses rules for non-sensitive functions of the own bay, which are always allowed', () => {
    const { bus } = setup();
    expect(() => bus.setMode(agents, `${agents}/session.setStatus`, 'deny')).toThrow(
      'A bay may always use its own non-sensitive functions',
    );
  });
});

describe('Bus permission management', () => {
  const at = new Date('2026-10-28T10:00:00Z');
  function managed(answers: Decision[] = []) {
    const prompter = { ask: vi.fn(async () => answers.shift() ?? 'deny') };
    let now = at;
    const bus = new Bus({ prompter, now: () => now });
    bus.register(vault, { name: 'secret.read', sensitive: true }, () => 'geheim');
    bus.register(vault, { name: 'entry.count', sensitive: false }, () => 3);
    return { bus, prompter, later: (ms: number) => (now = new Date(at.getTime() + ms)) };
  }

  it('records when a grant was given and when it was last used', async () => {
    const { bus, later } = managed(['allow', 'session']);
    await bus.call(browser, `${vault}/entry.count`, {});
    expect(bus.grants()).toEqual([
      expect.objectContaining({
        subject: 'dev.hangar.browser',
        mode: 'allow',
        grantedAt: at.toISOString(),
        lastUsed: at.toISOString(),
      }),
    ]);
    later(60_000);
    await bus.call(browser, `${vault}/entry.count`, {});
    expect(bus.grants()[0]!.lastUsed).toBe('2026-10-28T10:01:00.000Z');
    expect(bus.grants()[0]!.grantedAt).toBe(at.toISOString());

    await bus.call(session, `${vault}/secret.read`, {});
    const sessionGrant = bus.grants().find((g) => g.sessionId === 's1')!;
    expect(sessionGrant).toMatchObject({ mode: 'session', lastUsed: sessionGrant.grantedAt });
  });

  it('does not record a use for denied calls', async () => {
    const { bus } = managed(['deny']);
    await expect(bus.call(browser, `${vault}/entry.count`, {})).rejects.toThrow(
      PermissionDeniedError,
    );
    expect(bus.grants()[0]).not.toHaveProperty('lastUsed');
  });

  it('changes or sets a grant in advance, and the next call follows it at once', async () => {
    const { bus, prompter } = managed();
    bus.setMode('dev.hangar.browser', `${vault}/entry.count`, 'deny');
    await expect(bus.call(browser, `${vault}/entry.count`, {})).rejects.toThrow(
      PermissionDeniedError,
    );
    bus.setMode('dev.hangar.browser', `${vault}/entry.count`, 'allow');
    expect(await bus.call(browser, `${vault}/entry.count`, {})).toBe(3);
    bus.setMode(agents, `${vault}/secret.read`, 'ask');
    prompter.ask.mockResolvedValueOnce('allow');
    expect(await bus.call(session, `${vault}/secret.read`, {})).toBe('geheim');
    expect(prompter.ask).toHaveBeenCalledWith(expect.objectContaining({ kind: 'confirm' }));
    expect(bus.grants().find((g) => g.target === `${vault}/secret.read`)).toMatchObject({
      mode: 'ask',
      grantedAt: at.toISOString(),
    });
  });

  it('only offers the modes ADR 0006 allows', () => {
    const { bus } = managed();
    expect(() => bus.setMode(agents, `${vault}/entry.count`, 'ask')).toThrow(
      'Mode "ask" is only for sensitive functions',
    );
    expect(() => bus.setMode(agents, `${vault}/secret.read`, 'session')).toThrow(
      'Session grants are only given in the dialog',
    );
    expect(() => bus.setMode(agents, `${vault}/nope`, 'allow')).toThrow(
      'Unknown function: dev.hangar.vault/nope',
    );
  });
});

describe('Remote callers (ADR 0011)', () => {
  const fp = 'a'.repeat(64);
  const remote: Caller = { kind: 'remote', instance: fp, workspace: 'team', bayId: vault };
  const subject = `remote:${fp}/${vault}`;

  function remoteSetup(answers: Decision[] = [], shared = [`${vault}/entry.count`]) {
    const prompter: Prompter & { ask: ReturnType<typeof vi.fn> } = {
      ask: vi.fn(async () => answers.shift() ?? 'deny'),
    };
    const permissions = new MemoryPermissionStore();
    const access = {
      members: new Set([`team\n${fp}`]),
      shared: new Set(shared.map((t) => `team\n${t}`)),
      isMember(workspace: string, instance: string) {
        return this.members.has(`${workspace}\n${instance}`);
      },
      isShared(workspace: string, target: string) {
        return this.shared.has(`${workspace}\n${target}`);
      },
    };
    const bus = new Bus({ permissions, prompter, remote: access });
    const count = vi.fn(() => 3);
    bus.register(vault, { name: 'entry.count', sensitive: false, remote: true }, count);
    bus.register(vault, { name: 'secret.read', sensitive: true, remote: true }, () => 'geheim');
    bus.register(vault, { name: 'entry.list', sensitive: false }, () => []);
    return { bus, prompter, permissions, access, count };
  }

  it('never treats a remote caller with the same bay id as the own bay', async () => {
    const { bus, prompter } = remoteSetup(['deny']);
    await expect(bus.call(remote, `${vault}/entry.count`, {})).rejects.toThrow(
      `Access denied: ${subject} → ${vault}/entry.count`,
    );
    expect(prompter.ask).toHaveBeenCalledWith(
      expect.objectContaining({ caller: remote, kind: 'grant' }),
    );
  });

  it('stores the answer for the instance fingerprint, not for the bay', async () => {
    const { bus, count } = remoteSetup(['allow']);
    expect(await bus.call(remote, `${vault}/entry.count`, {})).toBe(3);
    expect(bus.grants()).toEqual([
      expect.objectContaining({ subject, target: `${vault}/entry.count`, mode: 'allow' }),
    ]);
    expect(count).toHaveBeenCalledWith({}, { caller: remote });
  });

  it('refuses an allow without the function on the share list, without asking', async () => {
    const { bus, prompter, access } = remoteSetup();
    bus.setMode(subject, `${vault}/entry.count`, 'allow');
    access.shared.clear();
    await expect(bus.call(remote, `${vault}/entry.count`, {})).rejects.toThrow(
      `Access denied: ${subject} → ${vault}/entry.count`,
    );
    expect(prompter.ask).not.toHaveBeenCalled();
  });

  it('refuses an allow once the instance left the workspace', async () => {
    const { bus, access } = remoteSetup();
    bus.setMode(subject, `${vault}/entry.count`, 'allow');
    expect(await bus.call(remote, `${vault}/entry.count`, {})).toBe(3);
    access.members.clear();
    await expect(bus.call(remote, `${vault}/entry.count`, {})).rejects.toThrow('Access denied');
  });

  it('checks membership in the workspace of the call, not in any workspace', async () => {
    const { bus } = remoteSetup();
    bus.setMode(subject, `${vault}/entry.count`, 'allow');
    await expect(
      bus.call({ ...remote, workspace: 'other' }, `${vault}/entry.count`, {}),
    ).rejects.toThrow('Access denied');
  });

  it('never runs sensitive functions remotely, even shared and allowed', async () => {
    const { bus, prompter } = remoteSetup(['allow'], [`${vault}/secret.read`]);
    bus.setMode(subject, `${vault}/secret.read`, 'allow');
    await expect(bus.call(remote, `${vault}/secret.read`, {})).rejects.toThrow('Access denied');
    expect(prompter.ask).not.toHaveBeenCalled();
  });

  it('never runs functions without remote: true, even shared and allowed', async () => {
    const { bus } = remoteSetup([], [`${vault}/entry.list`]);
    bus.setMode(subject, `${vault}/entry.list`, 'allow');
    await expect(bus.call(remote, `${vault}/entry.list`, {})).rejects.toThrow('Access denied');
  });

  it('refuses every remote call when the bus knows no workspaces', async () => {
    const bus = new Bus({ prompter: { ask: async () => 'allow' } });
    bus.register(vault, { name: 'entry.count', sensitive: false, remote: true }, () => 3);
    bus.setMode(subject, `${vault}/entry.count`, 'allow');
    await expect(bus.call(remote, `${vault}/entry.count`, {})).rejects.toThrow('Access denied');
  });

  it('keeps no session grant for a remote session id', async () => {
    const { bus, prompter } = remoteSetup(['allow']);
    await bus.call({ ...remote, sessionId: 's1' }, `${vault}/entry.count`, {});
    expect(bus.grants()).toEqual([expect.objectContaining({ subject, mode: 'allow' })]);
    expect(prompter.ask).toHaveBeenCalledTimes(1);
  });

  it('refuses and stores nothing when access ends while the dialog is open (Codex)', async () => {
    for (const end of ['members', 'shared'] as const) {
      const { bus, prompter, access, count } = remoteSetup();
      prompter.ask.mockImplementation(async () => {
        access[end].clear();
        return 'allow';
      });
      await expect(bus.call(remote, `${vault}/entry.count`, {})).rejects.toThrow('Access denied');
      expect(count).not.toHaveBeenCalled();
      expect(bus.grants()).toEqual([]);
    }
  });

  it('a stored deny still holds for a shared function', async () => {
    const { bus, prompter } = remoteSetup();
    bus.setMode(subject, `${vault}/entry.count`, 'deny');
    await expect(bus.call(remote, `${vault}/entry.count`, {})).rejects.toThrow('Access denied');
    expect(prompter.ask).not.toHaveBeenCalled();
  });
});

describe('Callers of the local server (ADR 0036)', () => {
  const local: Caller = { kind: 'local-server', bayId: agents, sessionId: 's1' };
  const open = (bus: Bus) =>
    bus.register(
      'dev.hangar.browser',
      { name: 'tab.open', sensitive: false, openToAgents: true },
      () => 'tab',
    );

  it('has a subject of its own, apart from the bays of this app', () => {
    expect(subjectOf(local)).toBe('local-server:dev.hangar.agents');
  });

  it('lets its agents call functions open to agents; a denial for its subject still holds', async () => {
    const { bus, prompter } = setup(['allow']);
    open(bus);
    await expect(bus.call(local, 'dev.hangar.browser/tab.open', {})).resolves.toBe('tab');
    expect(prompter.ask).not.toHaveBeenCalled();
    // A denial for the app's own agents is another subject.
    bus.setMode(agents, `${vault}/entry.count`, 'deny');
    await expect(bus.call(local, `${vault}/entry.count`, {})).resolves.toBe(3);
    bus.setMode('local-server:dev.hangar.agents', 'dev.hangar.browser/tab.open', 'deny');
    await expect(bus.call(local, 'dev.hangar.browser/tab.open', {})).rejects.toThrow(
      'Access denied: local-server:dev.hangar.agents → dev.hangar.browser/tab.open',
    );
  });

  it('never treats it as the own bay and asks without a session for open functions', async () => {
    const { bus, prompter } = setup();
    await expect(bus.call(local, `${agents}/session.setStatus`, {})).rejects.toThrow(
      'Access denied',
    );
    open(bus);
    const bay: Caller = { kind: 'local-server', bayId: 'dev.other' };
    await expect(bus.call(bay, 'dev.hangar.browser/tab.open', {})).rejects.toThrow(
      'Access denied: local-server:dev.other',
    );
    expect(prompter.ask).toHaveBeenCalledTimes(2);
  });

  it('keeps a session grant for its session only', async () => {
    const { bus, prompter } = setup(['session']);
    await bus.call(local, `${vault}/secret.read`, {});
    await bus.call(local, `${vault}/secret.read`, {});
    expect(prompter.ask).toHaveBeenCalledTimes(1);
    expect(bus.grants()).toMatchObject([
      { subject: 'local-server:dev.hangar.agents', mode: 'session', sessionId: 's1' },
    ]);
  });
});
