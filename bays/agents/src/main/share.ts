import type { RemoteBayState } from '@hangar/sdk';
import { isSessionStatus, type SessionStatus } from './status';
import type { Project, SessionRecord } from './types';

/** One session as other instances see it (ADR 0030). */
export interface SharedSession {
  branch: string;
  description: string;
  status: SessionStatus;
}

/** What this bay publishes to the workspaces: only projects shared by the person. */
export interface SharedState {
  projects: { name: string; sessions: SharedSession[] }[];
}

/** A shared project of another instance, with where it comes from. */
export interface RemoteProject {
  workspace: string;
  instance: string;
  name: string;
  project: string;
  sessions: SharedSession[];
}

/** Longest text taken from another instance. */
const MAX_TEXT = 200;

export function sharedState(projects: Project[], sessions: SessionRecord[]): SharedState {
  return {
    projects: projects
      .filter((p) => p.shared === true)
      .map((p) => ({
        name: p.name,
        sessions: sessions
          .filter((s) => s.projectId === p.id)
          .map(({ branch, description, status }) => ({ branch, description, status })),
      })),
  };
}

const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : undefined);

/** States of other instances as projects; whatever does not fit is dropped. */
export function remoteProjects(states: RemoteBayState[]): RemoteProject[] {
  return states.flatMap(({ workspace, instance, name, state }) => {
    const projects = (state as { projects?: unknown } | null)?.projects;
    if (!Array.isArray(projects)) return [];
    return projects.flatMap((p: { name?: unknown; sessions?: unknown } | null) => {
      const project = text(p?.name);
      if (project === undefined) return [];
      const sessions = (Array.isArray(p!.sessions) ? p!.sessions : []).flatMap(
        (s: Record<string, unknown> | null) => {
          const branch = text(s?.branch);
          const description = text(s?.description);
          if (branch === undefined || description === undefined || !isSessionStatus(s!.status))
            return [];
          return [{ branch, description, status: s!.status }];
        },
      );
      return [{ workspace, instance, name, project, sessions }];
    });
  });
}
