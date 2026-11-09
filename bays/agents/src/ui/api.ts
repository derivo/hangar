import type { HangarUiApi } from '@hangar/sdk';
import type {
  EnvValue,
  Project,
  ProjectDetails,
  Quotas,
  SessionRecord,
  StateView,
  TabColor,
} from '../main/types';
import type { RemoteProject } from '../main/share';

/** Typed wrapper around `window.hangar` for the agent bay's channels. */
/** Scrollback of a session; `end` is its position in the stream of `session.data`. */
export interface Snapshot {
  data: string;
  end?: number;
}

export function agentsApi(hangar: HangarUiApi) {
  return {
    state: () => hangar.invoke<StateView>('state'),
    /** On a server: the path to add, there is no folder dialog. */
    addProject: (path?: string) =>
      hangar.invoke<Project | undefined>('project.add', ...(path === undefined ? [] : [path])),
    /** Name of the server this bay runs on; `undefined` when it runs here. */
    server: hangar.server,
    removeProject: (id: string) => hangar.invoke<void>('project.remove', id),
    moveProject: (id: string, index: number) => hangar.invoke<void>('project.move', id, index),
    moveSession: (id: string, index: number) => hangar.invoke<void>('session.move', id, index),
    projectDetails: (id: string) => hangar.invoke<ProjectDetails>('project.details', id),
    deleteBranch: (id: string, branch: string) =>
      hangar.invoke<void>('project.deleteBranch', id, branch),
    setProjectEnv: (id: string, env: Record<string, EnvValue>) =>
      hangar.invoke<void>('project.setEnv', id, env),
    /** Passwords a variable can refer to; `null` without the secrets bay (ADR 0021). */
    secrets: () => hangar.invoke<{ name: string; description: string }[] | null>('secrets'),
    setProjectShared: (id: string, shared: boolean) =>
      hangar.invoke<void>('project.setShared', id, shared),
    /** Projects other instances share (ADR 0030). */
    remote: () => hangar.invoke<RemoteProject[]>('remote'),
    onRemote: (l: (p: RemoteProject[]) => void) =>
      hangar.on('remote', (p) => l(p as RemoteProject[])),
    createSession: (projectId: string) => hangar.invoke<SessionRecord>('session.create', projectId),
    closeSession: (id: string) => hangar.invoke<{ worktreeRemoved: boolean }>('session.close', id),
    restart: (id: string) => hangar.invoke<void>('session.restart', id),
    update: (
      id: string,
      patch: {
        description?: string;
        env?: Record<string, EnvValue>;
        color?: TabColor | null;
        copyOnSelect?: boolean;
      },
    ) => hangar.invoke<void>('session.update', id, patch),
    input: (id: string, data: string) => hangar.invoke<void>('session.input', id, data),
    resize: (id: string, cols: number, rows: number) =>
      hangar.invoke<void>('session.resize', id, cols, rows),
    /** Scrollback; a server of an older version knows only `session.buffer` and gives no `end`. */
    snapshot: (id: string) =>
      hangar
        .invoke<Snapshot>('session.snapshot', id)
        .catch(() =>
          hangar.invoke<string>('session.buffer', id).then((data): Snapshot => ({ data })),
        ),
    addJob: (id: string, command: string, schedule: string) =>
      hangar.invoke<void>('job.add', id, command, schedule),
    quota: () => hangar.invoke<Quotas>('quota'),
    onQuota: (l: (q: Quotas) => void) => hangar.on('quota', (p) => l(p as Quotas)),
    onState: (l: (s: StateView) => void) => hangar.on('state', (p) => l(p as StateView)),
    onData: (l: (e: { id: string; data: string; end?: number }) => void) =>
      hangar.on('session.data', (p) => l(p as { id: string; data: string; end?: number })),
    onExit: (l: (e: { id: string; exitCode: number }) => void) =>
      hangar.on('session.exit', (p) => l(p as { id: string; exitCode: number })),
    /** Own windows for undocked sessions, keyed by session id (ADR 0010). */
    windows: hangar.windows,
  };
}

export type AgentsApi = ReturnType<typeof agentsApi>;

/** Strips Electron's IPC wrapper from error messages raised in the main process. */
export function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
