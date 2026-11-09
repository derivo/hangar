import { sharedState, type SharedState } from './share';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { AgentAccess } from '@hangar/sdk';
import { AGENT_CONFIG_FILES, writeAgentConfig } from './agent-config';
import {
  addExcludes,
  addWorktree,
  changedFiles,
  commitsAhead,
  deleteBranch,
  hangarBranches,
  removeWorktree,
  repoRoot,
} from './git';
import { startJobProcess, type JobProcess } from './job-process';
import { promptEnv } from './zsh-prompt';
import type { PtyProcess, SpawnPty } from './pty';
import { loadState, saveState, writeFileAtomic } from './store';
import { afterOutput, afterQuiet, type SessionStatus } from './status';
import {
  TAB_COLORS,
  type BayState,
  type Handover,
  type OrphanBranch,
  type Project,
  type EnvValue,
  type ProjectDetails,
  type SessionPlace,
  type SessionRecord,
  type StateView,
  type StatusbarSegment,
  type TabColor,
} from './types';
import { t } from './messages';

/**
 * Set by a Claude Code session that started Hangar (e.g. `pnpm dev` in its terminal).
 * Inherited, they would turn an agent in a session into that session's child. The
 * login shell still restores values from the user's profile; the session env is kept.
 */
/** Open sessions other instances may hand work over to (ADR 0031). */
const MAX_REMOTE_HANDOVERS = 5;
/** Time limit of one job run (ADR 0014). */
const JOB_TIMEOUT_MS = 60 * 60_000;

const PARENT_AGENT_VAR = /^(CLAUDECODE$|CLAUDE_|ANTHROPIC_|MCP_)/;

/** Printed between the restored scrollback and the new shell after a restart. */
export const restoreMarker = () => `\r\n\x1b[0m\x1b[2m— ${t.restarted} —\x1b[0m\r\n`;

/** Mouse reports (1000–1016) and focus events (1004) a killed program may have left on. */
const INPUT_MODES_OFF = ['1000', '1002', '1003', '1004', '1005', '1006', '1015', '1016']
  .map((mode) => `\x1b[?${mode}l`)
  .join('');

/**
 * Text appended to restored scrollback before the new shell starts. If the old output
 * ended inside a full-screen program (alternate screen), leave it first; modes that make
 * the terminal send input on its own are switched off.
 */
export function restoreSuffix(previous: string): string {
  const enter = previous.lastIndexOf('\x1b[?1049h');
  const leave = previous.lastIndexOf('\x1b[?1049l');
  return (enter > leave ? '\x1b[?1049l' : '') + INPUT_MODES_OFF + restoreMarker();
}

/** Scrollback kept per session (characters). Older output is dropped. */
export const SCROLLBACK_LIMIT = 500_000;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ManagerDeps {
  dataDir: string;
  spawn: SpawnPty;
  shell: { file: string; args: string[] };
  /** Copy on select for new sessions, from the app's settings (ADR 0023); on if unset. */
  copyOnSelect?: () => boolean;
  /** Prompt of a zsh session shell, from the app's settings (ADR 0025); empty or unset keeps the user's. */
  prompt?: () => string;
  /** Time limit of one job run; 60 minutes unless set (tests). */
  jobTimeoutMs?: number;
  /** Sends an event to the bay UI. */
  emit(channel: string, payload: unknown): void;
  /** Publishes the shared projects to the workspaces (ADR 0030); only when they changed. */
  share?(state: SharedState): void;
  allocatePort(used: Set<number>): Promise<number>;
  now(): number;
  /** Issues MCP access (token, URL, CLI folder) for a session's shell. */
  registerAgent(sessionId: string): AgentAccess;
  unregisterAgent(sessionId: string): void;
  /** Shows a system notification. */
  notify(notification: { title: string; body?: string }): void;
  /** Sets the bay's badge (number of waiting sessions). */
  setBadge(count: number): void;
  /** Number of running shells (tray of the local server, ADR 0036). */
  setRunning(count: number): void;
  /**
   * Values of passwords of the secrets bay (ADR 0021); throws if one is missing or the bay
   * cannot be reached. Unset: shells with references do not start.
   */
  resolveSecrets?(names: string[]): Promise<Record<string, string>>;
  /** A session was closed (its jobs go with it). */
  sessionClosed?(sessionId: string): void;
}

interface Live {
  pty?: PtyProcess;
  scrollback: string;
  /** Characters sent as `session.data` so far; a snapshot names it as `end`. */
  sent: number;
  lastOutputAt: number;
  /** Scrollback changed since it was last written to disk. */
  dirty: boolean;
  /** Environment of the last shell that started; jobs run with it (ADR 0014). */
  env?: Record<string, string>;
  /** Running jobs; they outlive a shell restart, not the session. */
  jobs?: Set<JobProcess>;
  /** Counts shell starts; a password answer for an older start is dropped. */
  start?: number;
}

/** Projects, sessions and their shells. Everything the agent bay does lives here. */
export class SessionManager {
  private state: BayState;
  private readonly live = new Map<string, Live>();
  private readonly stateFile: string;
  private badge = 0;
  private running = 0;
  /** Set by `shutdown`: no new shells once the bay is deactivated. */
  private stopped = false;
  /** Creating sessions and removing projects run one at a time (ports, project lookups). */
  private queue: Promise<unknown> = Promise.resolve();
  /** Tasks in `queue` not finished yet; more than `MAX_QUEUED` are refused. */
  private queued = 0;

  constructor(private readonly deps: ManagerDeps) {
    this.stateFile = join(deps.dataDir, 'state.json');
    this.state = loadState(this.stateFile, (backup) =>
      deps.notify({
        title: t.stateCorrupt,
        body: t.backedUpAs(backup),
      }),
    );
  }

  /**
   * Restarts the shells of all persisted sessions after Hangar starts: same worktree,
   * env and description, scrollback replayed. Agents are gone, so the status is `idle`.
   */
  restore(): void {
    for (const session of this.state.sessions) {
      session.status = 'idle';
      if (!existsSync(session.worktreePath)) continue;
      const file = this.scrollbackFile(session.id);
      const previous = existsSync(file) ? readFileSync(file, 'utf8') : '';
      this.live.set(session.id, {
        scrollback: previous ? previous + restoreSuffix(previous) : '',
        sent: 0,
        lastOutputAt: this.deps.now(),
        dirty: true,
      });
      try {
        this.startShell(session);
      } catch (e) {
        // One broken session must not stop the others; the reason shows in its terminal.
        const live = this.live.get(session.id)!;
        live.scrollback += `\r\n${t.shellFailed((e as Error).message)}\r\n`;
        this.deps.unregisterAgent(session.id);
      }
    }
    this.changed();
  }

  /** Last published shared state, so an unrelated change sends nothing. */
  private lastShared?: string;

  view(): StateView {
    return {
      projects: this.state.projects,
      sessions: this.state.sessions.map((s) => ({
        ...s,
        running: this.live.get(s.id)?.pty !== undefined,
      })),
    };
  }

  // --- projects -------------------------------------------------------------

  async addProject(path: string): Promise<Project> {
    const root = await repoRoot(path);
    // Stored paths may predate repoRoot's resolve (C:/… on Windows).
    if (this.state.projects.some((p) => resolve(p.path) === root)) {
      throw new Error(t.projectExists(root));
    }
    const project = { id: randomUUID(), name: basename(root), path: root };
    this.state.projects.push(project);
    this.changed();
    return project;
  }

  /** Removes a project and closes its sessions. Worktrees with changes stay on disk. */
  removeProject(id: string): Promise<void> {
    return this.serial(() => this.removeProjectNow(id));
  }

  private async removeProjectNow(id: string): Promise<void> {
    for (const s of this.state.sessions.filter((s) => s.projectId === id)) {
      await this.closeSession(s.id);
    }
    this.state.projects = this.state.projects.filter((p) => p.id !== id);
    this.changed();
  }

  /** Puts the project at `index` in the order of the project tree. */
  moveProject(id: string, index: number): void {
    const project = this.project(id);
    if (!Number.isInteger(index) || index < 0) throw new Error(t.invalidIndex);
    const rest = this.state.projects.filter((p) => p !== project);
    rest.splice(index, 0, project);
    this.state.projects = rest;
    this.changed();
  }

  /** Puts the session at `index` among the sessions of its project in the project tree. */
  moveSession(id: string, index: number): void {
    const session = this.session(id);
    if (!Number.isInteger(index) || index < 0) throw new Error(t.invalidIndex);
    const all = this.state.sessions;
    const mine = all.filter((s) => s.projectId === session.projectId && s !== session);
    mine.splice(index, 0, session);
    // The other projects' sessions keep their places; this project's slots take the new order.
    let next = 0;
    this.state.sessions = all.map((s) => (s.projectId === session.projectId ? mine[next++]! : s));
    this.changed();
  }

  /** Env new sessions of the project start with; existing sessions keep theirs. */
  /** Shows the project's sessions to the other instances of the workspaces, or stops it. */
  setProjectShared(id: string, shared: boolean): void {
    this.project(id).shared = shared;
    this.changed();
  }

  setProjectEnv(id: string, env: Record<string, EnvValue>): void {
    validateEnv(env);
    this.project(id).env = env;
    this.changed();
  }

  /** Git state of the project's worktrees and its orphaned `hangar/*` branches. */
  async projectDetails(id: string): Promise<ProjectDetails> {
    const project = this.project(id);
    const sessions = this.state.sessions.filter((s) => s.projectId === id);
    const worktrees = await Promise.all(
      sessions.map(async (s) => ({
        sessionId: s.id,
        changes: existsSync(s.worktreePath)
          ? await changedFiles(s.worktreePath).catch(() => null)
          : null,
        ahead: s.branch ? await commitsAhead(project.path, s.branch).catch(() => null) : null,
      })),
    );
    return { worktrees, orphans: await this.orphans(project) };
  }

  /** Deletes an orphaned `hangar/*` branch; any other branch is refused. */
  async deleteBranch(projectId: string, branch: string): Promise<void> {
    const project = this.project(projectId);
    if (!(await this.orphans(project)).some((o) => o.branch === branch)) {
      throw new Error(t.notOrphan(branch));
    }
    await deleteBranch(project.path, branch);
  }

  private async orphans(project: Project): Promise<OrphanBranch[]> {
    const used = new Set(this.state.sessions.map((s) => s.branch));
    const branches = (await hangarBranches(project.path)).filter((b) => !used.has(b));
    return Promise.all(
      branches.map(async (branch) => ({ branch, ahead: await commitsAhead(project.path, branch) })),
    );
  }

  // --- sessions -------------------------------------------------------------

  createSession(
    projectId: string,
    env: Record<string, EnvValue> = {},
    place: SessionPlace = 'worktree',
  ): Promise<SessionRecord> {
    return this.serial(() => this.createSessionNow(projectId, env, place));
  }

  /**
   * A new session for work handed over (ADR 0031). A local handover starts on `startPoint`;
   * other instances may keep at most five such sessions open.
   */
  handover(projectId: string, handover: Handover, startPoint?: string): Promise<SessionRecord> {
    return this.serial(() => {
      if (handover.origin === 'remote') {
        // Checked in line: the person may have stopped sharing while this waited.
        if (this.project(projectId).shared !== true) throw new Error('No such shared project');
        const open = this.state.sessions.filter((s) => s.handover?.origin === 'remote').length;
        if (open >= MAX_REMOTE_HANDOVERS) throw new Error('Too many open handovers');
      }
      return this.createSessionNow(projectId, {}, 'worktree', { handover, startPoint });
    });
  }

  private async createSessionNow(
    projectId: string,
    env: Record<string, EnvValue>,
    place: SessionPlace,
    from?: { handover: Handover; startPoint?: string },
  ): Promise<SessionRecord> {
    if (this.stopped) throw new Error(t.shuttingDown);
    const project = this.project(projectId);
    env = { ...project.env, ...env };
    validateEnv(env);
    const id = randomUUID();
    const short = id.slice(0, 8);
    const inProject = place === 'project';
    const worktreePath = inProject
      ? project.path
      : join(this.deps.dataDir, 'worktrees', `${project.name}-${short}`);
    const branch = inProject ? '' : `hangar/${short}`;
    if (!inProject) await addWorktree(project.path, worktreePath, branch, from?.startPoint);
    try {
      await addExcludes(worktreePath, AGENT_CONFIG_FILES);
      const portBase = await this.deps.allocatePort(
        new Set(this.state.sessions.map((s) => s.portBase)),
      );
      // Shut down while git and the port search ran: no shell after deactivate.
      if (this.stopped) throw new Error(t.shuttingDown);
      const session: SessionRecord = {
        id,
        projectId,
        worktreePath,
        branch,
        description: '',
        status: 'idle',
        env,
        portBase,
        statusbar: [],
        createdAt: new Date(this.deps.now()).toISOString(),
        ...(inProject && { place: 'project' as const }),
        copyOnSelect: this.deps.copyOnSelect?.() ?? true,
        ...(from && { handover: from.handover }),
      };
      this.state.sessions.push(session);
      this.startShell(session);
      this.changed();
      return session;
    } catch (e) {
      // Leave nothing behind: no session entry, shell, token or worktree.
      this.stopShell(id);
      this.live.delete(id);
      this.deps.unregisterAgent(id);
      this.state.sessions = this.state.sessions.filter((s) => s.id !== id);
      if (!inProject) await removeWorktree(project.path, worktreePath);
      throw e;
    }
  }

  /** Ends the shell and removes the session; the worktree is removed only if clean. */
  async closeSession(id: string): Promise<{ worktreeRemoved: boolean }> {
    const session = this.session(id);
    this.stopShell(id);
    for (const job of this.live.get(id)?.jobs ?? []) job.kill();
    this.live.delete(id);
    this.deps.unregisterAgent(id);
    this.deps.sessionClosed?.(id);
    rmSync(this.scrollbackFile(id), { force: true });
    // Gone before the worktree is removed, so nothing restarts it meanwhile.
    this.state.sessions = this.state.sessions.filter((s) => s.id !== id);
    this.changed();
    const project = this.state.projects.find((p) => p.id === session.projectId);
    // The project folder is the person's: nothing in it is removed (ADR 0022).
    const worktreeRemoved =
      project && session.place !== 'project'
        ? await removeWorktree(project.path, session.worktreePath)
        : false;
    return { worktreeRemoved };
  }

  /**
   * Changes description, env and/or tab color (`null` removes it). New env restarts the
   * shell so it takes effect.
   */
  update(
    id: string,
    patch: {
      description?: string;
      env?: Record<string, EnvValue>;
      color?: TabColor | null;
      copyOnSelect?: boolean;
    },
  ): void {
    const session = this.session(id);
    if (patch.copyOnSelect !== undefined && typeof patch.copyOnSelect !== 'boolean') {
      throw new Error('copyOnSelect must be true or false');
    }
    if (patch.copyOnSelect !== undefined) session.copyOnSelect = patch.copyOnSelect;
    if (patch.color !== undefined && patch.color !== null && !TAB_COLORS.includes(patch.color)) {
      throw new Error(`Unknown color: ${String(patch.color)}`);
    }
    if (patch.description !== undefined) session.description = patch.description.trim();
    if (patch.color === null) delete session.color;
    else if (patch.color !== undefined) session.color = patch.color;
    if (patch.env !== undefined) {
      validateEnv(patch.env);
      session.env = patch.env;
      this.restart(id);
    }
    this.changed();
  }

  restart(id: string): void {
    const session = this.session(id);
    this.stopShell(id);
    try {
      this.startShell(session);
    } finally {
      // Also when it failed: the old shell is gone (Codex).
      this.changed();
    }
  }

  setStatus(id: string, status: SessionStatus): void {
    const session = this.session(id);
    if (session.status === status) return;
    session.status = status;
    if (status === 'waiting') {
      const project = this.project(session.projectId);
      this.deps.notify({
        title: t.waitingTitle,
        body: `${project.name}: ${session.description || session.branch}`,
      });
    }
    this.changed();
  }

  /** Adds or replaces (same key) a status bar segment. */
  setSegment(id: string, segment: StatusbarSegment): void {
    const session = this.session(id);
    const index = session.statusbar.findIndex((s) => s.key === segment.key);
    if (index === -1) session.statusbar.push(segment);
    else session.statusbar[index] = segment;
    this.changed();
  }

  removeSegment(id: string, key: string): void {
    const session = this.session(id);
    session.statusbar = session.statusbar.filter((s) => s.key !== key);
    this.changed();
  }

  input(id: string, data: string): void {
    this.live.get(id)?.pty?.write(data);
  }

  /** Runs `command` once in its own process: worktree and env of the session (ADR 0014). */
  runCommand(id: string, command: string): Promise<{ exitCode: number; lastLine: string }> {
    const session = this.session(id);
    const live = this.live.get(id);
    if (!live?.env) return Promise.reject(new Error(t.shellNotRunning));
    const job = startJobProcess({
      shell: this.deps.shell,
      command,
      cwd: session.worktreePath,
      env: live.env,
      timeoutMs: this.deps.jobTimeoutMs ?? JOB_TIMEOUT_MS,
    });
    const jobs = (live.jobs ??= new Set());
    jobs.add(job);
    return job.done.finally(() => jobs.delete(job));
  }

  resize(id: string, cols: number, rows: number): void {
    this.live.get(id)?.pty?.resize(Math.max(2, cols), Math.max(1, rows));
  }

  buffer(id: string): string {
    return this.live.get(id)?.scrollback ?? '';
  }

  /**
   * Scrollback and the position of its end in the output stream: live output can overtake
   * the answer on its way from a server, the UI keeps what is newer than `end`.
   */
  snapshot(id: string): { data: string; end: number } {
    return { data: this.buffer(id), end: this.live.get(id)?.sent ?? 0 };
  }

  private output(session: SessionRecord, live: Live, data: string): void {
    live.scrollback = trimScrollback(live.scrollback + data);
    live.dirty = true;
    live.sent += data.length;
    this.deps.emit('session.data', { id: session.id, data, end: live.sent });
  }

  /** Applies the idle fallback heuristic and persists scrollback; called periodically. */
  tick(): void {
    const now = this.deps.now();
    for (const s of this.state.sessions) {
      const live = this.live.get(s.id);
      if (live) this.setStatus(s.id, afterQuiet(s.status, live.lastOutputAt, now));
    }
    this.flushScrollback();
  }

  /** Persists scrollback and kills all shells (on quit). */
  shutdown(): void {
    this.stopped = true;
    this.flushScrollback();
    for (const [id, live] of this.live) {
      this.stopShell(id);
      for (const job of live.jobs ?? []) job.kill();
    }
  }

  private flushScrollback(): void {
    for (const [id, live] of this.live) {
      if (!live.dirty) continue;
      writeFileAtomic(this.scrollbackFile(id), live.scrollback);
      live.dirty = false;
    }
  }

  private scrollbackFile(id: string): string {
    return join(this.deps.dataDir, 'scrollback', `${id}.log`);
  }

  // --- internals ------------------------------------------------------------

  private serial<T>(task: () => Promise<T>): Promise<T> {
    // Refused with an error, never dropped: a lost create or remove would go unnoticed.
    if (this.queued >= MAX_QUEUED) return Promise.reject(new Error(t.busy));
    this.queued++;
    const run = this.queue.then(task, task).finally(() => this.queued--);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Starts the shell; with password references only once the secrets bay answered (ADR 0021). */
  private startShell(session: SessionRecord): void {
    const live: Live = this.live.get(session.id) ?? {
      scrollback: '',
      sent: 0,
      lastOutputAt: this.deps.now(),
      dirty: false,
    };
    this.live.set(session.id, live);
    const start = (live.start = (live.start ?? 0) + 1);
    const names = [
      ...new Set(
        Object.values(session.env)
          .filter(isSecretRef)
          .map((v) => v.secret),
      ),
    ];
    if (names.length === 0) return this.spawnShell(session, live, {});
    // Still the newest start of a session that is open, and no shell started meanwhile.
    const current = () =>
      live.start === start && !this.stopped && !live.pty && this.state.sessions.includes(session);
    const resolve = this.deps.resolveSecrets ?? (() => Promise.reject(new Error(t.noSecretsBay)));
    resolve(names)
      .then((values) => {
        if (!current()) return;
        this.spawnShell(session, live, values);
        this.changed();
      })
      // Also a shell that fails to start after the answer: nobody else would catch it.
      .catch((e: Error) => {
        if (!current()) return;
        this.output(session, live, `\r\n\x1b[31m${t.shellNotStarted(e.message)}\x1b[0m\r\n`);
        this.deps.emit('session.exit', { id: session.id, exitCode: -1 });
      });
  }

  private spawnShell(session: SessionRecord, live: Live, secrets: Record<string, string>): void {
    const project = this.project(session.projectId);
    writeAgentConfig(session.worktreePath);
    const env = this.environment(session, project, secrets);
    const pty = this.deps.spawn({
      file: this.deps.shell.file,
      args: this.deps.shell.args,
      cwd: session.worktreePath,
      env,
      cols: 100,
      rows: 30,
    });
    live.pty = pty;
    live.env = env;
    pty.onData((data) => {
      if (live.pty !== pty) return; // a replaced or closed shell
      live.lastOutputAt = this.deps.now();
      this.setStatus(session.id, afterOutput(session.status));
      this.output(session, live, data);
    });
    pty.onExit((exitCode) => {
      if (live.pty !== pty) return; // an old shell after restart
      live.pty = undefined;
      this.deps.emit('session.exit', { id: session.id, exitCode });
      this.changed();
    });
  }

  private stopShell(id: string): void {
    const live = this.live.get(id);
    const pty = live?.pty;
    if (!live || !pty) return;
    live.pty = undefined;
    pty.kill();
  }

  private environment(
    session: SessionRecord,
    project: Project,
    secrets: Record<string, string>,
  ): Record<string, string> {
    // Only a Hangar started inside Claude Code drops them; a service's API keys are for the agents.
    const insideAgent = process.env.CLAUDECODE !== undefined;
    const base = Object.fromEntries(
      Object.entries(process.env).filter(
        (e): e is [string, string] =>
          e[1] !== undefined && !(insideAgent && PARENT_AGENT_VAR.test(e[0])),
      ),
    );
    const agent = this.deps.registerAgent(session.id);
    const values = Object.fromEntries(
      Object.entries(session.env).map(([k, v]) => [k, isSecretRef(v) ? secrets[v.secret]! : v]),
    );
    const env = withCliPath({ ...base, ...values }, agent.cliDir);
    return {
      ...env,
      ...promptEnv(this.deps.shell.file, this.deps.prompt?.() ?? '', this.deps.dataDir, env),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      HANGAR_SESSION_ID: session.id,
      HANGAR_TOKEN: agent.token,
      HANGAR_MCP_URL: agent.mcpUrl,
      HANGAR_PROJECT: project.name,
      HANGAR_PORT_BASE: String(session.portBase),
    };
  }

  private project(id: string): Project {
    const project = this.state.projects.find((p) => p.id === id);
    if (!project) throw new Error(t.unknownProject(id));
    return project;
  }

  private session(id: string): SessionRecord {
    const session = this.state.sessions.find((s) => s.id === id);
    if (!session) throw new Error(t.unknownSession(id));
    return session;
  }

  private changed(): void {
    saveState(this.stateFile, this.state);
    this.deps.emit('state', this.view());
    const shared = sharedState(this.state.projects, this.state.sessions);
    const text = JSON.stringify(shared);
    if (text !== this.lastShared) {
      this.lastShared = text;
      this.deps.share?.(shared);
    }
    const waiting = this.state.sessions.filter((s) => s.status === 'waiting').length;
    if (waiting !== this.badge) {
      this.badge = waiting;
      this.deps.setBadge(waiting);
    }
    const running = [...this.live.values()].filter((l) => l.pty).length;
    if (running !== this.running) {
      this.running = running;
      this.deps.setRunning(running);
    }
  }
}

/**
 * Puts the CLI folder in front of PATH. Windows env names are case-insensitive, so all
 * spellings of PATH (`Path`, …) merge into one entry; a later one (session env) wins.
 */
export function withCliPath(
  env: Record<string, string>,
  cliDir: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const result: Record<string, string> = {};
  let path: string | undefined;
  for (const [key, value] of Object.entries(env)) {
    const isPath = platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH';
    if (isPath) path = value;
    else result[key] = value;
  }
  const separator = platform === 'win32' ? ';' : ':';
  result.PATH = path ? `${cliDir}${separator}${path}` : cliDir;
  return result;
}

/** `{ secret: "<name>" }` with a name the secrets bay accepts (ADR 0021). */
export const isSecretRef = (v: unknown): v is { secret: string } =>
  typeof v === 'object' &&
  v !== null &&
  Object.keys(v).length === 1 &&
  typeof (v as { secret?: unknown }).secret === 'string' &&
  ENV_KEY.test((v as { secret: string }).secret);

/** Env keys must be valid shell names; `HANGAR_*` is reserved for Hangar itself. */
export function validateEnv(env: Record<string, EnvValue>): void {
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY.test(key)) throw new Error(t.invalidEnvName(key));
    if (key.startsWith('HANGAR_')) throw new Error(t.reservedEnvName(key));
    if (typeof value !== 'string' && !isSecretRef(value)) throw new Error(t.envValueNotText(key));
  }
}

/** Creating and removing wait for each other; past this many something is stuck or flooding. */
const MAX_QUEUED = 100;

/**
 * How far trimming looks for the next line start before cutting mid-line: 4 KiB is far more
 * than a terminal line, so ordinary output always cuts at a line start, but a full-screen
 * program without line breaks does not lose a large part of its scrollback.
 */
const SCROLLBACK_LINE_SEARCH_LIMIT = 4096;
/** Keeps the newest output, cut at a line start so no escape sequence is split mid-line. */
export function trimScrollback(text: string, limit = SCROLLBACK_LIMIT): string {
  if (text.length <= limit) return text;
  const cut = text.length - limit;
  const nextLine = text.indexOf('\n', cut);
  // Full-screen programs (Claude Code) hardly write line breaks: the next one may be far
  // away, e.g. in the restart marker; then cut where the limit is.
  return text.slice(
    nextLine === -1 || nextLine - cut > SCROLLBACK_LINE_SEARCH_LIMIT ? cut : nextLine + 1,
  );
}
