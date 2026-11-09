import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BayContext, BayMain } from '@hangar/sdk';
import { allocatePortBase } from './ports';
import { defaultShell, spawnNodePty, type SpawnPty } from './pty';
import { SessionManager } from './sessions';
import { provideFunctions } from './functions';
import { SessionJobs } from './jobs';
import { setLocale, t } from './messages';
import { QuotaTracker, readCodexQuota } from './quota';
import { remoteProjects, sharedState } from './share';
import type { EnvValue } from './types';

const TICK_MS = 5_000;
/** Codex logs are read at most this often (ADR 0024). */
const CODEX_MS = 60_000;

/** Builds the agent bay; `spawn`, `shell` and Codex's home are replaceable for tests. */
export function createAgentsBay(
  spawn: SpawnPty = spawnNodePty,
  shell = defaultShell(),
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
): BayMain & {
  manager?: SessionManager;
} {
  let timer: ReturnType<typeof setInterval> | undefined;
  let codexTimer: ReturnType<typeof setInterval> | undefined;
  const bay: BayMain & { manager?: SessionManager } = {
    activate(ctx: BayContext) {
      setLocale(ctx.locale);
      ctx.onLocaleChange(setLocale);
      const manager = new SessionManager({
        dataDir: ctx.dataDir,
        spawn,
        shell,
        emit: (channel, payload) => ctx.ui.send(channel, payload),
        share: (state) => ctx.workspaces?.publish(state),
        allocatePort: (used) => allocatePortBase(used),
        now: Date.now,
        registerAgent: (id) => ctx.registerAgentSession(id),
        copyOnSelect: () => ctx.settings.get('copyOnSelect') === true,
        prompt: () => String(ctx.settings.get('prompt')),
        unregisterAgent: (id) => ctx.unregisterAgentSession(id),
        notify: (n) => ctx.notify(n),
        setBadge: (count) => ctx.setBadge(count),
        setRunning: (count) => ctx.setRunning(count),
        resolveSecrets: (names) =>
          ctx.call<Record<string, string>>('dev.hangar.secrets/secret.resolve', { names }),
        sessionClosed: (id) => jobs.removeAll(id),
      });
      const jobs = new SessionJobs(ctx, manager);
      bay.manager = manager;
      const quotas = new QuotaTracker({
        emit: (channel, payload) => ctx.ui.send(channel, payload),
        readCodex: () => readCodexQuota(codexHome),
      });
      provideFunctions(ctx, manager, jobs, quotas);
      manager.restore();
      const view = manager.view();
      ctx.workspaces?.publish(sharedState(view.projects, view.sessions));
      ctx.workspaces?.onState((states) => ctx.ui.send('remote', remoteProjects(states)));
      ctx.labelSessions((id) => {
        const s = manager.view().sessions.find((x) => x.id === id);
        // Same fallback as `sessionName` in the UI.
        return s && (s.description || s.branch || s.id.slice(0, 8));
      });
      const ui = ctx.ui;
      ui.handle('state', () => manager.view());
      // `path` comes from the UI where there is no folder dialog (server, ADR 0018).
      ui.handle('project.add', async (path) => {
        const folder = await ctx.pickFolder({
          title: t.addProject,
          ...(typeof path === 'string' && { path }),
        });
        return folder ? manager.addProject(folder) : undefined;
      });
      ui.handle('project.remove', (id) => manager.removeProject(id as string));
      ui.handle('project.move', (id, index) => manager.moveProject(id as string, index as number));
      ui.handle('session.move', (id, index) => manager.moveSession(id as string, index as number));
      ui.handle('project.setShared', (id, shared) =>
        manager.setProjectShared(id as string, shared === true),
      );
      ui.handle('remote', () => remoteProjects(ctx.workspaces?.states() ?? []));
      ui.handle('project.setEnv', (id, env) =>
        manager.setProjectEnv(id as string, env as Record<string, EnvValue>),
      );
      // Passwords for the env form; `null` when the secrets bay is not there (ADR 0021).
      ui.handle('secrets', () => ctx.call('dev.hangar.secrets/secret.list').catch(() => null));
      ui.handle('project.details', (id) => manager.projectDetails(id as string));
      ui.handle('project.deleteBranch', (id, branch) =>
        manager.deleteBranch(id as string, branch as string),
      );
      // ADR 0022: a new session always starts in the project folder.
      ui.handle('session.create', (projectId) =>
        manager.createSession(projectId as string, {}, 'project'),
      );
      ui.handle('session.close', (id) => manager.closeSession(id as string));
      ui.handle('session.restart', (id) => manager.restart(id as string));
      ui.handle('session.update', (id, patch) =>
        manager.update(id as string, patch as Parameters<SessionManager['update']>[1]),
      );
      ui.handle('session.input', (id, data) => manager.input(id as string, data as string));
      ui.handle('session.resize', (id, cols, rows) =>
        manager.resize(id as string, cols as number, rows as number),
      );
      // For UIs of older desktops; newer ones ask for the snapshot.
      ui.handle('session.buffer', (id) => manager.buffer(id as string));
      ui.handle('session.snapshot', (id) => manager.snapshot(id as string));
      ui.handle('job.add', (id, command, schedule) =>
        jobs.addFromUi(id as string, command as string, schedule as string),
      );
      ui.handle('quota', () => quotas.view());
      quotas.refreshCodex();
      timer = setInterval(() => manager.tick(), TICK_MS);
      timer.unref?.();
      codexTimer = setInterval(() => quotas.refreshCodex(), CODEX_MS);
      codexTimer.unref?.();
    },
    deactivate() {
      clearInterval(timer);
      clearInterval(codexTimer);
      bay.manager?.shutdown();
    },
  };
  return bay;
}

export default createAgentsBay();
