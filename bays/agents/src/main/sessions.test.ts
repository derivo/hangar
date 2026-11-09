import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  restoreMarker,
  restoreSuffix,
  SCROLLBACK_LIMIT,
  SessionManager,
  trimScrollback,
  validateEnv,
  withCliPath,
  type ManagerDeps,
} from './sessions';
import { gitEnv } from './git';
import { createTempRepo, PLAIN_SHELL, WIN } from './test-repo';
import { fakeSpawn } from './test-pty';
import type { EnvValue } from './types';

let deps: ManagerDeps & {
  spawn: ReturnType<typeof fakeSpawn>;
  emit: Mock<ManagerDeps['emit']>;
  allocatePort: Mock<ManagerDeps['allocatePort']>;
  notify: Mock<ManagerDeps['notify']>;
  setBadge: Mock<ManagerDeps['setBadge']>;
  setRunning: Mock<ManagerDeps['setRunning']>;
};
let clock: number;
let repo: string;

beforeEach(() => {
  clock = 1_000_000;
  repo = createTempRepo('my-app');
  let port = 40_000;
  deps = {
    dataDir: mkdtempSync(join(tmpdir(), 'hangar-agents-')),
    spawn: fakeSpawn(),
    shell: { file: '/bin/zsh', args: ['-l'] },
    emit: vi.fn(),
    allocatePort: vi.fn(async () => (port += 10)),
    now: () => clock,
    registerAgent: vi.fn((id: string) => ({
      token: `token-${id}`,
      mcpUrl: 'http://127.0.0.1:9/mcp',
      cliDir: '/hangar/bin',
    })),
    unregisterAgent: vi.fn(),
    notify: vi.fn(),
    setBadge: vi.fn(),
    setRunning: vi.fn(),
  };
});

async function withSession(env: Record<string, EnvValue> = {}) {
  const manager = new SessionManager(deps);
  const project = await manager.addProject(repo);
  const session = await manager.createSession(project.id, env);
  return { manager, project, session, pty: deps.spawn.all.at(-1)! };
}

describe('projects', () => {
  it('adds a repository by any folder inside it and persists it', async () => {
    const manager = new SessionManager(deps);
    const project = await manager.addProject(repo);
    expect(project).toMatchObject({ name: 'my-app', path: repo });
    expect(new SessionManager(deps).view().projects).toEqual([project]);
    expect(deps.emit).toHaveBeenCalledWith('state', { projects: [project], sessions: [] });
  });

  it('rejects duplicates and folders that are not repositories', async () => {
    const manager = new SessionManager(deps);
    await manager.addProject(repo);
    await expect(manager.addProject(repo)).rejects.toThrow('Projekt ist bereits hinzugefügt');
    await expect(manager.addProject(mkdtempSync(join(tmpdir(), 'x-')))).rejects.toThrow(
      'Kein Git-Repository',
    );
  });

  it('rejects a duplicate whose stored path is spelled differently (C:/… before repoRoot resolved)', async () => {
    writeFileSync(
      join(deps.dataDir, 'state.json'),
      JSON.stringify({ projects: [{ id: 'p', name: 'my-app', path: `${repo}/` }], sessions: [] }),
    );
    await expect(new SessionManager(deps).addProject(repo)).rejects.toThrow(
      'Projekt ist bereits hinzugefügt',
    );
  });

  it('moves a session within its project and persists it', async () => {
    const manager = new SessionManager(deps);
    const project = await manager.addProject(repo);
    const other = await manager.addProject(createTempRepo('other'));
    const [a, b] = [
      await manager.createSession(project.id),
      await manager.createSession(project.id),
    ];
    const x = await manager.createSession(other.id);
    const c = await manager.createSession(project.id);
    const order = (m: SessionManager) => m.view().sessions.map((s) => s.id);
    manager.moveSession(c.id, 0);
    // Only the sessions of the project change places; the index counts within it.
    expect(order(new SessionManager(deps))).toEqual([c.id, a.id, x.id, b.id]);
    expect(deps.emit).toHaveBeenLastCalledWith('state', expect.anything());
    manager.moveSession(c.id, 9);
    expect(order(manager)).toEqual([a.id, b.id, x.id, c.id]);
    manager.moveSession(x.id, 0);
    expect(order(manager)).toEqual([a.id, b.id, x.id, c.id]);
    expect(() => manager.moveSession('nope', 0)).toThrow('Unbekannte Session');
    for (const index of [-1, 1.5, Number.NaN, '1', undefined]) {
      expect(() => manager.moveSession(a.id, index as number)).toThrow('Ungültige Position');
    }
    expect(order(manager)).toEqual([a.id, b.id, x.id, c.id]);
    for (const s of [a, b, c, x]) await manager.closeSession(s.id);
  });

  it('moves a project to another place in the order and persists it', async () => {
    const manager = new SessionManager(deps);
    const [a, b, c] = [
      await manager.addProject(repo),
      await manager.addProject(createTempRepo('b')),
      await manager.addProject(createTempRepo('c')),
    ];
    const order = (m: SessionManager) => m.view().projects.map((p) => p.id);
    manager.moveProject(c.id, 0);
    expect(order(new SessionManager(deps))).toEqual([c.id, a.id, b.id]);
    expect(deps.emit).toHaveBeenLastCalledWith('state', expect.anything());
    // Past the end lands at the end.
    manager.moveProject(c.id, 9);
    expect(order(manager)).toEqual([a.id, b.id, c.id]);
    expect(() => manager.moveProject('nope', 0)).toThrow('Unbekanntes Projekt');
    // The index comes over IPC: anything but a whole number from 0 changes nothing.
    for (const index of [-1, 1.5, Number.NaN, '1', undefined]) {
      expect(() => manager.moveProject(a.id, index as number)).toThrow('Ungültige Position');
    }
    expect(order(manager)).toEqual([a.id, b.id, c.id]);
  });

  it('removing a project closes its sessions', async () => {
    const { manager, project, session, pty } = await withSession();
    await manager.removeProject(project.id);
    expect(pty.killed).toBe(true);
    expect(existsSync(session.worktreePath)).toBe(false);
    expect(manager.view()).toEqual({ projects: [], sessions: [] });
  });

  it('throws for unknown projects', async () => {
    await expect(new SessionManager(deps).createSession('nope')).rejects.toThrow(
      'Unbekanntes Projekt',
    );
  });
});

describe('sessions', () => {
  it('creates a worktree on its own branch and starts the shell inside it', async () => {
    const { session, pty } = await withSession({ FOO: 'bar' });
    expect(session.branch).toBe(`hangar/${session.id.slice(0, 8)}`);
    expect(session.worktreePath).toBe(
      join(deps.dataDir, 'worktrees', `my-app-${session.id.slice(0, 8)}`),
    );
    expect(readFileSync(join(session.worktreePath, 'README.md'), 'utf8')).toBe('# test\n');
    expect(pty.options).toMatchObject({
      file: '/bin/zsh',
      args: ['-l'],
      cwd: session.worktreePath,
    });
    expect(pty.options.env).toMatchObject({
      FOO: 'bar',
      TERM: 'xterm-256color',
      HANGAR_SESSION_ID: session.id,
      HANGAR_PROJECT: 'my-app',
      HANGAR_PORT_BASE: '40010',
      HANGAR_TOKEN: `token-${session.id}`,
      HANGAR_MCP_URL: 'http://127.0.0.1:9/mcp',
    });
    expect(pty.options.env.PATH!.startsWith(`/hangar/bin${delimiter}`)).toBe(true);
    expect(session).toMatchObject({ status: 'idle', description: '', statusbar: [] });
    expect(existsSync(join(session.worktreePath, '.mcp.json'))).toBe(true);
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain(
      '.claude/settings.local.json',
    );
  });

  it('starts a session in the project folder without a worktree, also after a restart (ADR 0022)', async () => {
    const manager = new SessionManager(deps);
    const project = await manager.addProject(repo);
    const worktrees = await manager.createSession(project.id);
    const first = await manager.createSession(project.id, {}, 'project');
    const second = await manager.createSession(project.id, {}, 'project');
    expect(first).toMatchObject({ place: 'project', worktreePath: project.path, branch: '' });
    expect(deps.spawn.all.at(-1)!.options.cwd).toBe(project.path);
    expect(existsSync(join(project.path, '.mcp.json'))).toBe(true);
    expect(worktrees.place).toBeUndefined();
    const details = await manager.projectDetails(project.id);
    expect(details.worktrees.find((w) => w.sessionId === first.id)).toMatchObject({ ahead: null });

    manager.shutdown();
    const next = new SessionManager(deps);
    next.restore();
    expect(deps.spawn.all.at(-1)!.options.cwd).toBe(project.path);

    // Closing leaves the project folder and Hangar's files there alone.
    expect(await next.closeSession(first.id)).toEqual({ worktreeRemoved: false });
    expect(existsSync(project.path)).toBe(true);
    expect(existsSync(join(project.path, '.mcp.json'))).toBe(true);
    expect(next.view().sessions.map((s) => s.id)).toEqual([worktrees.id, second.id]);
  });

  it('gives every session its own port block', async () => {
    const { manager, project } = await withSession();
    await manager.createSession(project.id);
    expect(deps.allocatePort).toHaveBeenLastCalledWith(new Set([40_010]));
    expect(manager.view().sessions.map((s) => s.portBase)).toEqual([40_010, 40_020]);
  });

  it('streams output to the UI, keeps scrollback and passes input/resizes through', async () => {
    const { manager, session, pty } = await withSession();
    pty.emitData('hello ');
    pty.emitData('world');
    // `end` counts all output so far: the UI keeps what is newer than its snapshot.
    expect(deps.emit).toHaveBeenCalledWith('session.data', {
      id: session.id,
      data: 'world',
      end: 11,
    });
    expect(manager.buffer(session.id)).toBe('hello world');
    expect(manager.snapshot(session.id)).toEqual({ data: 'hello world', end: 11 });
    manager.input(session.id, ' \x1b[A');
    expect(pty.written).toEqual([' \x1b[A']);
    manager.resize(session.id, 120, 0);
    expect(pty.size).toEqual([120, 1]);
    expect(manager.buffer('unknown')).toBe('');
  });

  it('applies the status heuristic: output → working, 30 s quiet → idle', async () => {
    const { manager, session, pty } = await withSession();
    pty.emitData('x');
    expect(manager.view().sessions[0]!.status).toBe('working');
    clock += 29_000;
    manager.tick();
    expect(manager.view().sessions[0]!.status).toBe('working');
    clock += 1_000;
    manager.tick();
    expect(manager.view().sessions[0]!.status).toBe('idle');
    manager.setStatus(session.id, 'waiting');
    pty.emitData('spinner');
    clock += 60_000;
    manager.tick();
    expect(manager.view().sessions[0]!.status).toBe('waiting');
  });

  it('notifies when a session starts waiting and badges the number of waiting sessions', async () => {
    const { manager, session } = await withSession();
    await manager.update(session.id, { description: 'Login reparieren' });
    const second = await manager.createSession(manager.view().projects[0]!.id);
    expect(deps.setBadge).not.toHaveBeenCalled();

    manager.setStatus(session.id, 'waiting');
    expect(deps.notify).toHaveBeenCalledWith({
      title: 'Session wartet auf Eingabe',
      body: 'my-app: Login reparieren',
    });
    expect(deps.setBadge).toHaveBeenLastCalledWith(1);

    manager.setStatus(second.id, 'waiting');
    expect(deps.notify).toHaveBeenLastCalledWith({
      title: 'Session wartet auf Eingabe',
      body: `my-app: ${second.branch}`,
    });
    expect(deps.setBadge).toHaveBeenLastCalledWith(2);

    manager.setStatus(session.id, 'working');
    await manager.closeSession(second.id);
    expect(deps.setBadge).toHaveBeenLastCalledWith(0);
    expect(deps.notify).toHaveBeenCalledTimes(2);
    expect(deps.setBadge).toHaveBeenCalledTimes(4);
  });

  it('marks exited shells and restarts them on request', async () => {
    const { manager, session, pty } = await withSession();
    pty.emitExit(1);
    expect(deps.emit).toHaveBeenCalledWith('session.exit', { id: session.id, exitCode: 1 });
    expect(manager.view().sessions[0]!.running).toBe(false);
    manager.input(session.id, 'ignored');
    manager.restart(session.id);
    expect(deps.spawn.all).toHaveLength(2);
    expect(manager.view().sessions[0]!.running).toBe(true);
  });

  it('reports how many shells run, not how many sessions exist', async () => {
    const { manager, session, pty } = await withSession();
    expect(deps.setRunning).toHaveBeenLastCalledWith(1);
    pty.emitExit(0);
    expect(deps.setRunning).toHaveBeenLastCalledWith(0);
    manager.restart(session.id);
    expect(deps.setRunning).toHaveBeenLastCalledWith(1);
    const calls = deps.setRunning.mock.calls.length;
    await manager.update(session.id, { description: 'x' });
    // Only on a change.
    expect(deps.setRunning).toHaveBeenCalledTimes(calls);
    await manager.closeSession(session.id);
    expect(deps.setRunning).toHaveBeenLastCalledWith(0);
  });

  it('reports the stopped shell also when its restart fails (Codex)', async () => {
    const { manager, session } = await withSession();
    deps.spawn.fail = new Error('spawn failed');
    expect(() => manager.restart(session.id)).toThrow('spawn failed');
    expect(deps.setRunning).toHaveBeenLastCalledWith(0);
  });

  it('ignores the exit of a replaced shell', async () => {
    const { manager, session, pty } = await withSession();
    manager.restart(session.id);
    pty.emitExit(0);
    expect(manager.view().sessions[0]!.running).toBe(true);
  });

  it('drops output of a replaced or closed shell', async () => {
    const { manager, session, pty } = await withSession();
    manager.restart(session.id);
    pty.emitData('old output');
    expect(manager.buffer(session.id)).not.toContain('old output');
    expect(deps.emit).not.toHaveBeenCalledWith('session.data', {
      id: session.id,
      data: 'old output',
      end: expect.any(Number),
    });
    const current = deps.spawn.all.at(-1)!;
    await manager.closeSession(session.id);
    expect(() => current.emitData('late')).not.toThrow();
  });

  it('rolls back a session whose shell cannot start', async () => {
    const manager = new SessionManager(deps);
    const project = await manager.addProject(repo);
    deps.spawn.fail = new Error('spawn failed');
    await expect(manager.createSession(project.id)).rejects.toThrow('spawn failed');
    expect(manager.view().sessions).toEqual([]);
    expect(deps.unregisterAgent).toHaveBeenCalledTimes(1);
    const worktrees = join(deps.dataDir, 'worktrees');
    expect(existsSync(worktrees) ? readdirSync(worktrees) : []).toEqual([]);
    expect(new SessionManager(deps).view().sessions).toEqual([]);
  });

  it('gives concurrently created sessions different port blocks', async () => {
    deps.allocatePort.mockImplementation(async (used) => {
      await new Promise((r) => setTimeout(r, 5));
      let port = 40_000;
      while (used.has(port)) port += 10;
      return port;
    });
    const manager = new SessionManager(deps);
    const project = await manager.addProject(repo);
    const [a, b] = await Promise.all([
      manager.createSession(project.id),
      manager.createSession(project.id),
    ]);
    expect(a.portBase).not.toBe(b.portBase);
  });

  it('removing a project while a session is being created leaves nothing behind', async () => {
    const manager = new SessionManager(deps);
    const project = await manager.addProject(repo);
    const creating = manager.createSession(project.id);
    await manager.removeProject(project.id);
    await creating;
    expect(manager.view()).toEqual({ projects: [], sessions: [] });
  });

  describe('passwords from the secrets bay (ADR 0021)', () => {
    it('starts the shell with the values, keeps only the reference and gives jobs the values', async () => {
      deps.shell = PLAIN_SHELL; // the job runs for real; zsh is missing on Linux runners
      deps.resolveSecrets = vi.fn(async (names: string[]) =>
        Object.fromEntries(names.map((n) => [n, `wert-${n}`])),
      );
      const { manager, session } = await withSession({
        TOKEN: { secret: 'GITHUB_TOKEN' },
        PLAIN: 'x',
      });
      expect(deps.resolveSecrets).toHaveBeenCalledWith(['GITHUB_TOKEN']);
      await vi.waitFor(() => expect(deps.spawn.all).toHaveLength(1));
      expect(deps.spawn.all[0]!.options.env).toMatchObject({
        TOKEN: 'wert-GITHUB_TOKEN',
        PLAIN: 'x',
      });
      expect(manager.view().sessions[0]!.env).toEqual({
        TOKEN: { secret: 'GITHUB_TOKEN' },
        PLAIN: 'x',
      });
      expect(manager.view().sessions[0]!.running).toBe(true);
      expect(deps.setRunning).toHaveBeenLastCalledWith(1);
      const state = readFileSync(join(deps.dataDir, 'state.json'), 'utf8');
      expect(state).not.toContain('wert-GITHUB_TOKEN');
      const job = await manager.runCommand(session.id, WIN ? 'echo %TOKEN%' : 'printf "$TOKEN"');
      expect(job.lastLine).toBe('wert-GITHUB_TOKEN');
    });

    it('starts no shell when a password is missing and says why in the terminal', async () => {
      deps.resolveSecrets = vi.fn(async () => {
        throw new Error('Unknown password: GONE');
      });
      const { manager, session } = await withSession({ TOKEN: { secret: 'GONE' } });
      await vi.waitFor(() =>
        expect(deps.emit).toHaveBeenCalledWith('session.exit', { id: session.id, exitCode: -1 }),
      );
      expect(deps.spawn.all).toHaveLength(0);
      expect(manager.buffer(session.id)).toContain('Shell nicht gestartet: Unknown password: GONE');
      expect(deps.emit).toHaveBeenCalledWith('session.data', {
        id: session.id,
        data: expect.stringContaining('Unknown password: GONE'),
        end: expect.any(Number),
      });
      // Back in the vault: a restart starts it.
      deps.resolveSecrets = vi.fn(async () => ({ GONE: 'da' }));
      manager.restart(session.id);
      await vi.waitFor(() => expect(deps.spawn.all).toHaveLength(1));
    });

    it('says in the terminal when the shell fails to start after the answer', async () => {
      deps.resolveSecrets = vi.fn(async () => ({ A: 'wert' }));
      deps.spawn.fail = new Error('spawn failed');
      const { manager, session } = await withSession({ TOKEN: { secret: 'A' } });
      await vi.waitFor(() =>
        expect(manager.buffer(session.id)).toContain('Shell nicht gestartet: spawn failed'),
      );
      expect(deps.emit).toHaveBeenCalledWith('session.exit', { id: session.id, exitCode: -1 });
    });

    it('drops a late answer: the session closed or restarted meanwhile', async () => {
      let answer: (v: Record<string, string>) => void = () => {};
      deps.resolveSecrets = vi.fn(() => new Promise<Record<string, string>>((r) => (answer = r)));
      const { manager, session } = await withSession({ TOKEN: { secret: 'A' } });
      const first = answer;
      manager.restart(session.id);
      const second = answer;
      first({ A: 'alt' });
      second({ A: 'neu' });
      await vi.waitFor(() => expect(deps.spawn.all).toHaveLength(1));
      expect(deps.spawn.all[0]!.options.env.TOKEN).toBe('neu');
      // A late failure says nothing either.
      let fail: (e: Error) => void = () => {};
      deps.resolveSecrets = vi.fn(() => new Promise<never>((_, r) => (fail = r)));
      manager.restart(session.id);
      const failed = fail;
      deps.resolveSecrets = vi.fn(() => new Promise<Record<string, string>>((r) => (answer = r)));
      manager.restart(session.id);
      failed(new Error('zu spät'));
      await new Promise((r) => setTimeout(r, 10));
      expect(manager.buffer(session.id)).not.toContain('zu spät');
      await manager.closeSession(session.id);
      answer({ A: 'zu spät' });
      await new Promise((r) => setTimeout(r, 10));
      expect(deps.spawn.all).toHaveLength(1);
    });

    it('refuses references without a valid name and without the secrets bay', async () => {
      const { manager, session } = await withSession();
      for (const ref of [{ secret: '' }, { secret: '1X' }, { secret: 3 }, { other: 'A' }])
        expect(() => manager.update(session.id, { env: { TOKEN: ref as never } })).toThrow(
          'Wert von TOKEN muss Text sein',
        );
      // No resolver: as if the secrets bay were missing.
      manager.update(session.id, { env: { TOKEN: { secret: 'A' } } });
      await vi.waitFor(() => expect(manager.buffer(session.id)).toContain('Shell nicht gestartet'));
    });
  });

  it('updates description and env; new env restarts the shell', async () => {
    const { manager, session, pty } = await withSession();
    manager.update(session.id, { description: '  Login reparieren ' });
    expect(manager.view().sessions[0]!.description).toBe('Login reparieren');
    expect(deps.spawn.all).toHaveLength(1);
    manager.update(session.id, { env: { API_URL: 'http://localhost' } });
    expect(pty.killed).toBe(true);
    expect(deps.spawn.all.at(-1)!.options.env.API_URL).toBe('http://localhost');
    expect(() => manager.update(session.id, { env: { HANGAR_TOKEN: 'x' } })).toThrow('reserviert');
    expect(() => manager.update('nope', {})).toThrow('Unbekannte Session');
  });

  it('copies on select as the default says, switchable per session (ADR 0023)', async () => {
    deps.copyOnSelect = () => false;
    const { manager, session } = await withSession();
    expect(session.copyOnSelect).toBe(false);
    manager.update(session.id, { copyOnSelect: true });
    expect(manager.view().sessions[0]!.copyOnSelect).toBe(true);
    expect(deps.spawn.all).toHaveLength(1);
    expect(() => manager.update(session.id, { copyOnSelect: 'ja' as never })).toThrow(
      'copyOnSelect must be true or false',
    );
    deps.copyOnSelect = undefined;
    expect((await manager.createSession(session.projectId)).copyOnSelect).toBe(true);
  });

  it('sets the prompt of a zsh through its own ZDOTDIR; empty or another shell keeps it (ADR 0025)', async () => {
    deps.prompt = () => '%~ %# ';
    const { manager, session, pty } = await withSession({ ZDOTDIR: '/own/zsh' });
    const dir = join(deps.dataDir, 'zsh');
    expect(pty.options.env).toMatchObject({
      ZDOTDIR: dir,
      HANGAR_ZDOTDIR: '/own/zsh',
      HANGAR_PROMPT: '%~ %# ',
    });
    expect(readFileSync(join(dir, '.zshenv'), 'utf8')).toContain('HANGAR_PROMPT');

    deps.prompt = () => '';
    manager.restart(session.id);
    const env = deps.spawn.all.at(-1)!.options.env;
    expect(env.ZDOTDIR).toBe('/own/zsh');
    expect(env.HANGAR_PROMPT).toBeUndefined();

    deps.prompt = () => '%~ %# ';
    deps.shell = { file: '/bin/bash', args: ['-l'] };
    manager.restart(session.id);
    expect(deps.spawn.all.at(-1)!.options.env.HANGAR_PROMPT).toBeUndefined();
  });

  it('sets and clears the tab color; rejects unknown colors', async () => {
    const { manager, session } = await withSession();
    expect(manager.view().sessions[0]!.color).toBeUndefined();
    manager.update(session.id, { color: 'violet' });
    expect(manager.view().sessions[0]!.color).toBe('violet');
    expect(deps.spawn.all).toHaveLength(1);
    expect(() => manager.update(session.id, { color: 'black' as 'red' })).toThrow('Unknown color');
    manager.update(session.id, { color: null });
    expect(manager.view().sessions[0]!.color).toBeUndefined();
  });

  it('keeps an unchanged status without saving', async () => {
    const { manager, session } = await withSession();
    deps.emit.mockClear();
    manager.setStatus(session.id, 'idle');
    expect(deps.emit).not.toHaveBeenCalled();
  });

  it('puts the CLI folder before a PATH set in the session env', async () => {
    const { pty } = await withSession({ PATH: '/custom' });
    expect(pty.options.env.PATH).toBe(`/hangar/bin${delimiter}/custom`);
  });

  it("keeps a parent Claude Code session's variables out of the shell, but not the session env", async () => {
    const leaked = {
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      ANTHROPIC_BASE_URL: 'http://proxy',
      MCP_CONNECTION_NONBLOCKING: '1',
    };
    Object.assign(process.env, leaked);
    try {
      const { pty } = await withSession({ ANTHROPIC_API_KEY: 'mine' });
      for (const key of Object.keys(leaked)) expect(pty.options.env).not.toHaveProperty(key);
      expect(pty.options.env.ANTHROPIC_API_KEY).toBe('mine');
    } finally {
      for (const key of Object.keys(leaked)) delete process.env[key];
    }
  });

  it('passes API keys of the service to the shell when Hangar runs outside Claude Code', async () => {
    // A server started by systemd or Docker: the keys are meant for the agents (ADR 0029).
    const saved = process.env.CLAUDECODE;
    delete process.env.CLAUDECODE;
    process.env.ANTHROPIC_API_KEY = 'service-key';
    try {
      const { pty } = await withSession();
      expect(pty.options.env.ANTHROPIC_API_KEY).toBe('service-key');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      if (saved !== undefined) process.env.CLAUDECODE = saved;
    }
  });

  // Without PATH, Windows does not find git itself (its env is case-insensitive).
  it.skipIf(process.platform === 'win32')(
    'uses only the CLI folder when no PATH exists',
    async () => {
      const saved = process.env.PATH;
      delete process.env.PATH;
      try {
        const { pty } = await withSession();
        expect(pty.options.env.PATH).toBe('/hangar/bin');
      } finally {
        process.env.PATH = saved;
      }
    },
  );

  it('adds, replaces and removes status bar segments by key', async () => {
    const { manager, session } = await withSession();
    manager.setSegment(session.id, { key: 'tokens', value: '10', type: 'bar', max: 100 });
    manager.setSegment(session.id, { key: 'model', value: 'opus', type: 'badge' });
    manager.setSegment(session.id, { key: 'tokens', value: '20', type: 'bar', max: 100 });
    expect(manager.view().sessions[0]!.statusbar).toEqual([
      { key: 'tokens', value: '20', type: 'bar', max: 100 },
      { key: 'model', value: 'opus', type: 'badge' },
    ]);
    manager.removeSegment(session.id, 'tokens');
    expect(manager.view().sessions[0]!.statusbar.map((s) => s.key)).toEqual(['model']);
  });

  it('closes sessions and keeps worktrees with uncommitted changes', async () => {
    const { manager, project, session } = await withSession();
    expect(await manager.closeSession(session.id)).toEqual({ worktreeRemoved: true });
    expect(deps.unregisterAgent).toHaveBeenCalledWith(session.id);

    const dirty = await manager.createSession(project.id);
    writeFileSync(join(dirty.worktreePath, 'work.txt'), 'wip');
    expect(await manager.closeSession(dirty.id)).toEqual({ worktreeRemoved: false });
    expect(existsSync(join(dirty.worktreePath, 'work.txt'))).toBe(true);
    expect(manager.view().sessions).toEqual([]);
  });

  it('does not restart a session while it is closing', async () => {
    const { manager, session } = await withSession();
    const shells = deps.spawn.all.length;
    const closing = manager.closeSession(session.id);
    expect(() => manager.restart(session.id)).toThrow(`Unbekannte Session: ${session.id}`);
    await closing;
    expect(deps.spawn.all).toHaveLength(shells);
  });

  it('shutdown kills every shell', async () => {
    const { manager, pty } = await withSession();
    manager.shutdown();
    expect(pty.killed).toBe(true);
  });
});

describe('withCliPath', () => {
  it('prepends the CLI folder to PATH', () => {
    expect(withCliPath({ PATH: `/usr/bin` }, '/hangar/bin', 'darwin')).toEqual({
      PATH: '/hangar/bin:/usr/bin',
    });
  });

  it('on Windows merges PATH regardless of case into exactly one entry', () => {
    const env = withCliPath({ Path: 'C:\\Windows', HOME: 'h' }, 'C:\\Hangar\\bin', 'win32');
    expect(env).toEqual({ HOME: 'h', PATH: 'C:\\Hangar\\bin;C:\\Windows' });
  });
});

describe('validateEnv', () => {
  it.each([
    [{ '1ABC': 'x' }, 'Ungültiger Variablenname: 1ABC'],
    [{ 'A-B': 'x' }, 'Ungültiger Variablenname: A-B'],
    [{ HANGAR_PORT_BASE: '1' }, 'Variable ist reserviert: HANGAR_PORT_BASE'],
    [{ A: 3 as unknown as string }, 'Wert von A muss Text sein'],
  ])('rejects %o', (env, message) => {
    expect(() => validateEnv(env)).toThrow(message);
  });

  it('accepts valid names', () => {
    expect(() => validateEnv({ _A1: '', NODE_ENV: 'dev' })).not.toThrow();
  });
});

describe('trimScrollback', () => {
  it('keeps short text and cuts long text at a line start', () => {
    expect(trimScrollback('abc', 10)).toBe('abc');
    expect(trimScrollback('line1\nline2\nline3', 10)).toBe('line3');
    expect(trimScrollback('x'.repeat(20), 10)).toBe('x'.repeat(10));
    // A line start far beyond the cut is not worth losing everything before it.
    expect(trimScrollback('x'.repeat(10_000) + '\nend', 9_000)).toBe('x'.repeat(8_996) + '\nend');
  });
});

describe('restore after restart', () => {
  it('restarts shells in their worktree with env, description and scrollback', async () => {
    const { manager, session, pty } = await withSession({ FOO: 'bar' });
    manager.update(session.id, { description: 'Checkout bauen', color: 'teal' });
    manager.setStatus(session.id, 'waiting');
    const restarted = deps.spawn.all.at(-1)!;
    restarted.emitData('$ npm test\r\nok\r\n');
    manager.shutdown();
    expect(pty.killed).toBe(true);

    const next = new SessionManager(deps);
    next.restore();
    const shell = deps.spawn.all.at(-1)!;
    expect(shell).not.toBe(restarted);
    expect(shell.options.cwd).toBe(session.worktreePath);
    expect(shell.options.env).toMatchObject({ FOO: 'bar', HANGAR_SESSION_ID: session.id });
    const [restored] = next.view().sessions;
    expect(restored).toMatchObject({
      description: 'Checkout bauen',
      color: 'teal',
      status: 'idle',
      running: true,
    });
    expect(next.buffer(session.id)).toMatch(/^\$ npm test\r\nok\r\n.*Hangar neu gestartet/s);
  });

  it('keeps the scrollback of a full-screen program without line breaks after a restart', async () => {
    // Claude Code draws on the alternate screen with cursor moves: hardly any "\n".
    const { manager, session } = await withSession();
    const tui = '\x1b[?1049h' + '\x1b[2;1Hantwort'.repeat(Math.ceil(SCROLLBACK_LIMIT / 13));
    deps.spawn.all.at(-1)!.emitData(tui);
    manager.shutdown();
    const next = new SessionManager(deps);
    next.restore();
    deps.spawn.all.at(-1)!.emitData('$ ');
    expect(next.buffer(session.id)).toContain('\x1b[2;1Hantwort\x1b[2;1Hantwort');
    expect(next.buffer(session.id).length).toBeLessThanOrEqual(SCROLLBACK_LIMIT);
  });

  it('flushes changed scrollback periodically', async () => {
    const { manager, session } = await withSession();
    deps.spawn.all.at(-1)!.emitData('progress');
    manager.tick();
    expect(readFileSync(join(deps.dataDir, 'scrollback', `${session.id}.log`), 'utf8')).toBe(
      'progress',
    );
  });

  it('keeps restoring when one shell cannot start and shows why', async () => {
    const { manager, project, session } = await withSession();
    const second = await manager.createSession(project.id);
    manager.shutdown();
    const next = new SessionManager(deps);
    deps.spawn.fail = new Error('kein PTY');
    deps.spawn.failOnce = true;
    expect(() => next.restore()).not.toThrow();
    const [first, other] = next.view().sessions;
    expect(first).toMatchObject({ id: session.id, running: false });
    expect(next.buffer(session.id)).toContain('Shell konnte nicht starten: kein PTY');
    expect(other).toMatchObject({ id: second.id, running: true });
  });

  it('reports a corrupt state file instead of silently starting empty', () => {
    writeFileSync(join(deps.dataDir, 'state.json'), '{broken');
    new SessionManager(deps);
    expect(deps.notify).toHaveBeenCalledWith({
      title: 'Zustand der Agent-Bay war beschädigt',
      body: expect.stringContaining('state.json.corrupt-'),
    });
  });

  it('starts no shell for a session still being created when the bay shuts down', async () => {
    const manager = new SessionManager(deps);
    const project = await manager.addProject(repo);
    let release: (port: number) => void = () => {};
    deps.allocatePort.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const creating = manager.createSession(project.id);
    await vi.waitFor(() => expect(deps.allocatePort).toHaveBeenCalled());
    manager.shutdown();
    release(40_100);
    await expect(creating).rejects.toThrow('Agent-Bay wird beendet');
    expect(deps.spawn.all).toHaveLength(0);
    expect(manager.view().sessions).toEqual([]);
    await expect(manager.createSession(project.id)).rejects.toThrow('Agent-Bay wird beendet');
  });

  it('refuses new work once 100 tasks wait, instead of letting the queue grow', async () => {
    const manager = new SessionManager(deps);
    const project = await manager.addProject(repo);
    let release: (port: number) => void = () => {};
    deps.allocatePort.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const first = manager.createSession(project.id);
    await vi.waitFor(() => expect(deps.allocatePort).toHaveBeenCalled());
    const waiting = Array.from({ length: 99 }, () =>
      manager.removeProject('nope').catch(() => undefined),
    );
    await expect(manager.removeProject('nope')).rejects.toThrow('Agent-Bay ist ausgelastet');
    release(40_100);
    await first;
    await Promise.all(waiting);
    // Room again once the queue drained.
    await expect(manager.removeProject('nope')).resolves.toBeUndefined();
  });

  it('does not start sessions whose worktree is gone', async () => {
    const { manager, session } = await withSession();
    manager.shutdown();
    const { rmSync } = await import('node:fs');
    rmSync(session.worktreePath, { recursive: true, force: true });
    const spawned = deps.spawn.all.length;
    const next = new SessionManager(deps);
    next.restore();
    expect(deps.spawn.all).toHaveLength(spawned);
    expect(next.view().sessions[0]!.running).toBe(false);
    expect(next.buffer(session.id)).toBe('');
  });
});

describe('restoreSuffix', () => {
  it('leaves the alternate screen only if the old output ended inside it', () => {
    expect(restoreSuffix('plain')).not.toContain('\x1b[?1049l');
    expect(restoreSuffix('\x1b[?1049hvim').startsWith('\x1b[?1049l')).toBe(true);
    expect(restoreSuffix('\x1b[?1049hvim\x1b[?1049l$ ')).not.toContain('\x1b[?1049l');
    expect(restoreSuffix('plain').endsWith(restoreMarker())).toBe(true);
  });

  it('switches off mouse reports the killed program left on', () => {
    // Otherwise every mouse move reaches the new shell as text like "35;59;19M".
    const suffix = restoreSuffix('\x1b[?1003h\x1b[?1006hclaude');
    for (const mode of ['1000', '1002', '1003', '1006', '1004']) {
      expect(suffix).toContain(`\x1b[?${mode}l`);
    }
  });
});

describe('project overview', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], {
      cwd,
      stdio: 'ignore',
      env: gitEnv(),
    });

  it('reports uncommitted changes and commits not in the main checkout per session', async () => {
    const { manager, project, session } = await withSession();
    expect(await manager.projectDetails(project.id)).toEqual({
      worktrees: [{ sessionId: session.id, changes: 0, ahead: 0 }],
      orphans: [],
    });
    writeFileSync(join(session.worktreePath, 'a.txt'), 'a');
    expect((await manager.projectDetails(project.id)).worktrees[0]).toMatchObject({ changes: 1 });
    git(session.worktreePath, 'add', 'a.txt');
    git(session.worktreePath, 'commit', '-qm', 'a');
    expect((await manager.projectDetails(project.id)).worktrees[0]).toMatchObject({
      changes: 0,
      ahead: 1,
    });
  });

  it('reports a missing worktree as unknown instead of failing', async () => {
    const { manager, project, session } = await withSession();
    rmSync(session.worktreePath, { recursive: true, force: true });
    expect((await manager.projectDetails(project.id)).worktrees[0]).toEqual({
      sessionId: session.id,
      changes: null,
      ahead: 0,
    });
  });

  it('reports a broken worktree and a deleted branch as unknown', async () => {
    const { manager, project, session } = await withSession();
    rmSync(session.worktreePath, { recursive: true, force: true });
    git(repo, 'worktree', 'prune');
    git(repo, 'branch', '-D', session.branch);
    mkdirSync(session.worktreePath);
    expect((await manager.projectDetails(project.id)).worktrees[0]).toEqual({
      sessionId: session.id,
      changes: null,
      ahead: null,
    });
  });

  it('lists hangar branches without a session as orphans and deletes only those', async () => {
    const { manager, project, session } = await withSession();
    const closed = await manager.createSession(project.id);
    git(repo, 'branch', 'feature');
    await manager.closeSession(closed.id);
    expect((await manager.projectDetails(project.id)).orphans).toEqual([
      { branch: closed.branch, ahead: 0 },
    ]);
    await expect(manager.deleteBranch(project.id, session.branch)).rejects.toThrow(
      `Kein verwaister Hangar-Branch: ${session.branch}`,
    );
    await expect(manager.deleteBranch(project.id, 'feature')).rejects.toThrow(
      'Kein verwaister Hangar-Branch: feature',
    );
    await manager.deleteBranch(project.id, closed.branch);
    expect((await manager.projectDetails(project.id)).orphans).toEqual([]);
  });

  it('starts new sessions with the project env under their own; existing ones keep theirs', async () => {
    const { manager, project, session } = await withSession({ OWN: '1' });
    expect(() => manager.setProjectEnv(project.id, { HANGAR_X: '1' })).toThrow();
    manager.setProjectEnv(project.id, { DB: 'dev', OWN: 'project' });
    expect(manager.view().projects[0]!.env).toEqual({ DB: 'dev', OWN: 'project' });
    const next = await manager.createSession(project.id, { OWN: 'session' });
    expect(next.env).toEqual({ DB: 'dev', OWN: 'session' });
    expect(manager.view().sessions.find((s) => s.id === session.id)!.env).toEqual({ OWN: '1' });
    expect(new SessionManager(deps).view().projects[0]!.env).toEqual({ DB: 'dev', OWN: 'project' });
  });
});

describe('sharing with workspaces (ADR 0030)', () => {
  it('publishes the shared projects on every change that alters them, off by default', async () => {
    const share = vi.fn();
    deps.share = share;
    const { manager, project, session } = await withSession();
    expect(project.shared).toBeUndefined();
    expect(share).toHaveBeenLastCalledWith({ projects: [] });
    const calls = share.mock.calls.length;
    manager.setProjectShared(project.id, true);
    expect(share).toHaveBeenLastCalledWith({
      projects: [
        {
          name: project.name,
          sessions: [{ branch: session.branch, description: '', status: 'idle' }],
        },
      ],
    });
    manager.setStatus(session.id, 'waiting');
    expect(share.mock.lastCall![0].projects[0].sessions[0].status).toBe('waiting');
    const count = share.mock.calls.length;
    // A change others do not see sends nothing.
    manager.setProjectEnv(project.id, { DB: 'dev' });
    expect(share.mock.calls.length).toBe(count);
    expect(count).toBeGreaterThan(calls);
    manager.setProjectShared(project.id, false);
    expect(share).toHaveBeenLastCalledWith({ projects: [] });
    expect(new SessionManager(deps).view().projects[0]!.shared).toBe(false);
  });
});

describe('runCommand', () => {
  // A plain shell keeps the tests independent of the user's profile.
  const sh = async () => {
    deps.shell = PLAIN_SHELL;
    return withSession({ GREETING: 'hallo' });
  };
  // The commands below are POSIX; Windows runs the job through cmd.exe (own test).
  const posix = it.skipIf(WIN);

  it.runIf(WIN)('runs a job through cmd.exe on Windows', async () => {
    const { manager, session } = await sh();
    expect(
      (await manager.runCommand(session.id, 'echo %GREETING% %HANGAR_SESSION_ID%')).lastLine,
    ).toBe(`hallo ${session.id}`);
    expect(await manager.runCommand(session.id, '(echo kaputt)1>&2 & exit /b 127')).toEqual({
      exitCode: 127,
      lastLine: 'kaputt',
    });
  });

  posix('runs the command in its own process, in the worktree, with the session env', async () => {
    const { manager, session, pty } = await sh();
    const typed = pty.written.length;
    const result = await manager.runCommand(
      session.id,
      `echo "$GREETING $HANGAR_SESSION_ID"; pwd; printf '\\033[32m 5 passed\\033[0m\\nrunning 1%%\\rdone 100%%\\n'`,
    );
    expect(result).toEqual({ exitCode: 0, lastLine: 'done 100%' });
    expect(
      (await manager.runCommand(session.id, 'echo "$GREETING $HANGAR_SESSION_ID:$PWD"')).lastLine,
    ).toBe(`hallo ${session.id}:${realpathSync(session.worktreePath)}`);
    expect(pty.written).toHaveLength(typed);
  });

  posix('reports a failing command with its error output', async () => {
    const { manager, session } = await sh();
    expect(await manager.runCommand(session.id, 'echo kaputt >&2; exit 127')).toEqual({
      exitCode: 127,
      lastLine: 'kaputt',
    });
  });

  posix('gives a reading command an empty input instead of waiting', async () => {
    const { manager, session } = await sh();
    expect(await manager.runCommand(session.id, 'read x; echo "got:$x"')).toEqual({
      exitCode: 0,
      lastLine: 'got:',
    });
  });

  posix('runs two jobs of the same session at once', async () => {
    const { manager, session } = await sh();
    const runs = await Promise.all([
      manager.runCommand(session.id, 'sleep 0.2; echo eins'),
      manager.runCommand(session.id, 'sleep 0.2; echo zwei'),
    ]);
    expect(runs.map((r) => r.lastLine)).toEqual(['eins', 'zwei']);
  });

  posix('stops a job after the time limit', async () => {
    const { manager, session } = await sh();
    deps.jobTimeoutMs = 300;
    const started = Date.now();
    await expect(manager.runCommand(session.id, 'sleep 5 & sleep 5; wait')).rejects.toThrow(
      'Abgebrochen: länger als 1 min',
    );
    expect(Date.now() - started).toBeLessThan(3000);
  });

  posix('keeps running when the shell restarts and stops when the session closes', async () => {
    const { manager, session } = await sh();
    deps.sessionClosed = vi.fn();
    const run = manager.runCommand(session.id, 'sleep 0.5; echo fertig');
    manager.restart(session.id);
    expect(await run).toEqual({ exitCode: 0, lastLine: 'fertig' });

    const closed = expect(manager.runCommand(session.id, 'sleep 5')).rejects.toThrow(
      'Job abgebrochen',
    );
    await manager.closeSession(session.id);
    await closed;
    expect(deps.sessionClosed).toHaveBeenCalledWith(session.id);
  });

  it('needs a shell that started once, for its env and token', async () => {
    const { manager, session } = await sh();
    manager.shutdown();
    deps.spawn.fail = new Error('kein PTY');
    const next = new SessionManager(deps);
    next.restore();
    await expect(next.runCommand(session.id, 'ls')).rejects.toThrow(
      'Die Shell der Session läuft nicht',
    );
    expect(() => manager.runCommand('nope', 'ls')).toThrow('Unbekannte Session: nope');
  });
});
