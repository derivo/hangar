import type { HangarUiApi } from '@hangar/sdk';
import type { Task } from '../main/board';

export interface ProjectRef {
  id: string;
  name: string;
}

/** Typed wrapper around `window.hangar` for the board's channels. */
export function boardApi(hangar: HangarUiApi) {
  return {
    state: () => hangar.invoke<Task[]>('state'),
    /** `null` without the agent bay. */
    projects: () => hangar.invoke<ProjectRef[] | null>('projects'),
    add: (projectId: string, task: { title: string; description: string }) =>
      hangar.invoke<Task>('add', projectId, task),
    reopen: (id: string) => hangar.invoke<Task>('reopen', id),
    done: (id: string) => hangar.invoke<Task>('done', id),
    remove: (id: string) => hangar.invoke<void>('remove', id),
    onState: (l: (s: Task[]) => void) => hangar.on('state', (p) => l(p as Task[])),
  };
}

export type BoardApi = ReturnType<typeof boardApi>;
