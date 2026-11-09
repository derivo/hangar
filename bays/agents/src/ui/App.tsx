import { useCallback, useEffect, useRef, useState } from 'react';
import type { StateView } from '../main/types';
import { errorMessage, type AgentsApi } from './api';
import { PathForm } from './PathForm';
import { QuotaBar } from './QuotaBar';
import { ProjectPane } from './ProjectPane';
import { ProjectTree, type SessionAction } from './ProjectTree';
import { SessionPane, type PaneRequest } from './SessionPane';
import { Workspace } from './Workspace';
import { addField, closeField, place, prune, type Grid } from './grid';
import { sessionName, t } from './messages';
import type { TerminalRegistry } from './terminals';
import type { RemoteProject } from '../main/share';

const GRID = 'grid';
const SELECTED_PROJECT = 'selectedProject';

/** The grid saved before the restart; a damaged entry starts with one empty field. */
function savedGrid(): Grid {
  try {
    const grid = JSON.parse(localStorage.getItem(GRID) ?? '') as Grid;
    const valid =
      Array.isArray(grid.fields) &&
      grid.fields.length > 0 &&
      grid.fields.every((id) => id === null || typeof id === 'string') &&
      Number.isInteger(grid.focus) &&
      grid.focus >= 0 &&
      grid.focus < grid.fields.length;
    if (valid) return grid;
  } catch {
    // Nothing saved yet or not JSON.
  }
  return { fields: [null], focus: 0 };
}

/** Keeps a selection in the bay's storage, or removes it once nothing is selected. */
function remember(key: string, value: string | undefined): void {
  if (value) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
}

interface Props {
  api: AgentsApi;
  terminals: Pick<
    TerminalRegistry,
    'attach' | 'fit' | 'focus' | 'write' | 'dispose' | 'has' | 'setCopyOnSelect'
  >;
}

export function App({ api, terminals }: Props) {
  const [state, setState] = useState<StateView>({ projects: [], sessions: [] });
  // Kept in the bay's persistent storage partition, so grid and overview are restored after a
  // restart. The project overview replaces the grid while it is open.
  const [grid, setGrid] = useState(savedGrid);
  const [projectId, setProjectId] = useState(
    () => localStorage.getItem(SELECTED_PROJECT) ?? undefined,
  );
  // Sessions undocked into their own window; in such a window, its session.
  const [undocked, setUndocked] = useState<string[]>([]);
  const own = api.windows.current;
  // Only the main view saves; a session's own window shares the storage but not the grid.
  useEffect(() => {
    if (!own) localStorage.setItem(GRID, JSON.stringify(grid));
  }, [grid, own]);
  useEffect(() => {
    if (!own) remember(SELECTED_PROJECT, projectId);
  }, [projectId, own]);
  useEffect(() => {
    void api.windows.list().then(setUndocked);
    return api.windows.onChange(setUndocked);
  }, [api]);
  const openSession = useCallback((id: string) => {
    setProjectId(undefined);
    setGrid((g) => place(g, id));
  }, []);
  const openProject = useCallback((id: string) => setProjectId(id), []);
  const [error, setError] = useState<string>();
  const [remote, setRemote] = useState<RemoteProject[]>([]);
  useEffect(() => {
    // A server bay may lose its connection; the host builds the view anew after reconnecting.
    api.remote().then(setRemote, () => {});
    return api.onRemote(setRemote);
  }, [api]);
  const [pathForm, setPathForm] = useState(false);
  // What the context menu asked a pane to show; a new object each time, so it repeats.
  const [request, setRequest] = useState<PaneRequest>();
  // A short confirmation (copied), gone after a few seconds.
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    // Forget terminals of sessions that no longer exist; their fields become empty.
    const apply = (next: StateView) => {
      const ids = new Set(next.sessions.map((s) => s.id));
      setState((prev) => {
        for (const s of prev.sessions) if (!ids.has(s.id)) terminals.dispose(s.id);
        return next;
      });
      setGrid((g) => prune(g, ids));
      // A window of a session that ended has nothing left to show.
      if (own && !ids.has(own)) void api.windows.close(own);
    };
    api.state().then(apply, () => {});
    const offState = api.onState(apply);
    const offData = api.onData(({ id, data, end }) => terminals.write(id, data, end));
    return () => {
      offState();
      offData();
    };
  }, [api, terminals, own]);

  // Actions still running, by key: a double click must not create or close twice.
  const pending = useRef(new Set<string>());
  const run = useCallback(async (action: () => Promise<unknown>, key?: string) => {
    if (key && pending.current.has(key)) return;
    if (key) pending.current.add(key);
    setError(undefined);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      if (key) pending.current.delete(key);
    }
  }, []);

  const index = state.projects.findIndex((p) => p.id === projectId);
  const project = state.projects[index];
  const titleOf = (id: string) => {
    const s = state.sessions.find((x) => x.id === id)!;
    const projectName = state.projects.find((p) => p.id === s.projectId)?.name;
    return `${sessionName(s)} – ${projectName}`;
  };
  const undock = (id: string) => void run(() => api.windows.open(id, titleOf(id)));
  const select = (id: string) => (undocked.includes(id) ? undock(id) : openSession(id));
  const moveProject = (id: string, index: number) =>
    void run(() => api.moveProject(id, index), `move:${id}`);
  const moveSession = (id: string, index: number) =>
    void run(() => api.moveSession(id, index), `move:${id}`);
  const sessionAction = (id: string, action: SessionAction) => {
    if (typeof action === 'object') return void run(() => api.update(id, action));
    switch (action) {
      case 'window':
        return undocked.includes(id) ? void run(() => api.windows.close(id)) : undock(id);
      case 'restart':
        return void run(() => api.restart(id), `restart:${id}`);
      case 'close':
        if (window.confirm(t.confirmCloseSession)) {
          void run(() => api.closeSession(id), `close:${id}`);
        }
        return;
      case 'copyPath': {
        const path = state.sessions.find((s) => s.id === id)!.worktreePath;
        return void run(async () => {
          await navigator.clipboard.writeText(path);
          setNotice(t.copied);
        });
      }
      default:
        // In its own window the pane is not here: bring the window, without the request.
        select(id);
        setRequest({ id, action });
    }
  };
  const createSession = (id: string) =>
    void run(async () => openSession((await api.createSession(id)).id), `create:${id}`);

  const errorBox = error && (
    <div className="error">
      <span role="alert">{error}</span>
      <button
        type="button"
        className="icon-button"
        aria-label={t.dismiss}
        onClick={() => setError(undefined)}
      >
        ×
      </button>
    </div>
  );

  if (own) {
    const mine = state.sessions.find((s) => s.id === own);
    return (
      <main className="main own-window">
        {errorBox}
        {mine && (
          <SessionPane
            session={mine}
            projectName={state.projects.find((p) => p.id === mine.projectId)?.name ?? ''}
            active
            api={api}
            terminals={terminals}
            run={run}
            windowAction={
              <button
                type="button"
                className="icon-button"
                aria-label={t.dock}
                title={t.dock}
                onClick={() => void run(() => api.windows.close(own))}
              >
                ↙
              </button>
            }
          />
        )}
      </main>
    );
  }

  return (
    <div className="layout">
      <ProjectTree
        state={state}
        selectedId={project ? undefined : (grid.fields[grid.focus] ?? undefined)}
        selectedProjectId={project?.id}
        onSelect={select}
        onSelectProject={openProject}
        onAddProject={() =>
          api.server ? setPathForm(true) : void run(() => api.addProject(), 'addProject')
        }
        onCreateSession={createSession}
        onMoveProject={moveProject}
        onMoveSession={moveSession}
        onSessionAction={sessionAction}
        undocked={undocked}
        remote={remote}
      />
      <main className="main">
        {errorBox}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {pathForm && api.server && (
          <PathForm server={api.server} add={api.addProject} onDone={() => setPathForm(false)} />
        )}
        {project ? (
          <ProjectPane
            key={project.id}
            project={project}
            sessions={state.sessions.filter((s) => s.projectId === project.id)}
            api={api}
            run={run}
            onOpenSession={select}
            onMoveSession={moveSession}
            onCreateSession={() => createSession(project.id)}
            onMoveUp={index > 0 ? () => moveProject(project.id, index - 1) : undefined}
            onMoveDown={
              index < state.projects.length - 1
                ? () => moveProject(project.id, index + 1)
                : undefined
            }
            onRemoveProject={() => {
              if (window.confirm(t.confirmRemoveProject)) {
                void run(() => api.removeProject(project.id), `remove:${project.id}`);
              }
            }}
          />
        ) : (
          <Workspace
            state={state}
            grid={grid}
            api={api}
            terminals={terminals}
            run={run}
            onFocusField={(focus) => setGrid((g) => ({ ...g, focus }))}
            onAddField={() => setGrid(addField)}
            onCloseField={(index) => setGrid((g) => closeField(g, index))}
            undocked={undocked}
            request={request}
            onRequestDone={() => setRequest(undefined)}
            onUndock={undock}
            onBringBack={(id) => void run(() => api.windows.close(id))}
          />
        )}
      </main>
      <QuotaBar api={api} />
    </div>
  );
}
