import { useCallback, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { TAB_COLORS, type SessionView, type StateView, type TabColor } from '../main/types';
import { Menu, type MenuEntry } from './Menu';
import { branchOf, sessionName, t } from './messages';
import { tabColorStyle } from './SessionPane';
import { RemoteList } from './RemoteList';
import type { RemoteProject } from '../main/share';

/** What the context menu of a session asks the app to do; moving it the tree does itself. */
export type SessionAction =
  | 'describe'
  | 'window'
  | 'job'
  | 'env'
  | 'copyPath'
  | 'restart'
  | 'close'
  | { color: TabColor | null };

const COLLAPSED = 'treeCollapsed';
const COLLAPSED_PROJECTS = 'collapsedProjects';

interface Props {
  state: StateView;
  selectedId?: string;
  selectedProjectId?: string;
  onSelect(sessionId: string): void;
  onSelectProject(projectId: string): void;
  onAddProject(): void;
  onCreateSession(projectId: string): void;
  /** Puts the project at `index` in the order (drag and drop). */
  onMoveProject(projectId: string, index: number): void;
  /** Puts the session at `index` among the sessions of its project (drag and drop). */
  onMoveSession(sessionId: string, index: number): void;
  /** An action from the context menu of a session. */
  onSessionAction(sessionId: string, action: SessionAction): void;
  /** Sessions in a window of their own: the menu offers to dock them. */
  undocked?: string[];
  /** Projects other instances share (ADR 0030); not shown while collapsed. */
  remote?: RemoteProject[];
}

export function ProjectTree(props: Props) {
  const { state, selectedId } = props;
  // Kept in the bay's storage like the grid, so the bar stays collapsed after a restart.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED) === '1');
  const toggle = () => {
    if (collapsed) localStorage.removeItem(COLLAPSED);
    else localStorage.setItem(COLLAPSED, '1');
    setCollapsed(!collapsed);
  };
  const toggleButton = (
    <button
      type="button"
      className="icon-button"
      aria-expanded={!collapsed}
      aria-label={collapsed ? t.expandTree : t.collapseTree}
      title={collapsed ? t.expandTree : t.collapseTree}
      onClick={toggle}
    >
      {collapsed ? '›' : '‹'}
    </button>
  );
  // Projects showing only their name; kept like the bar's own state.
  const [hidden, setHidden] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(COLLAPSED_PROJECTS) ?? '[]');
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  });
  const toggleProject = (id: string) => {
    const next = hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id];
    localStorage.setItem(COLLAPSED_PROJECTS, JSON.stringify(next));
    setHidden(next);
  };
  // The dragged project; a ref, as the native drag events carry no React state.
  const dragged = useRef<string | undefined>(undefined);
  // Where the dragged project would land: above the target, or below when dragged down.
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean }>();
  const endDrag = () => {
    dragged.current = undefined;
    setDropTarget(undefined);
  };
  const drop = (target: string, index: number) => {
    if (dragged.current && dragged.current !== target) props.onMoveProject(dragged.current, index);
    endDrag();
  };
  // The dragged session: it moves only among the sessions of its own project.
  const draggedSession = useRef<{ id: string; projectId: string; index: number } | undefined>(
    undefined,
  );
  const [sessionTarget, setSessionTarget] = useState<{ id: string; after: boolean }>();
  const endSessionDrag = () => {
    draggedSession.current = undefined;
    setSessionTarget(undefined);
  };
  /** The dragged session, if `target` of `projectId` can take its place. */
  const sessionFor = (target: string, projectId: string) => {
    const d = draggedSession.current;
    return d && d.projectId === projectId && d.id !== target ? d : undefined;
  };
  // The open context menu: its session, where it opens and what gets the focus back.
  const [menu, setMenu] = useState<{
    id: string;
    at: { x: number; y: number };
    from: HTMLElement;
  }>();
  // Synchronous, so a Tab still in progress moves on from the session (Menu.tsx).
  const closeMenu = useCallback(() => {
    menu?.from.focus();
    setMenu(undefined);
  }, [menu]);
  const show = (id: string, from: HTMLElement, at?: { x: number; y: number }) => {
    const r = from.getBoundingClientRect();
    setMenu({ id, at: at ?? { x: r.left, y: r.bottom }, from });
  };
  const menuProps = (id: string) => ({
    onContextMenu: (e: MouseEvent<HTMLElement>) => {
      e.preventDefault();
      // The context menu key (Windows, Linux) reports no point: open at the session instead.
      const keyboard = e.clientX === 0 && e.clientY === 0;
      show(id, e.currentTarget, keyboard ? undefined : { x: e.clientX, y: e.clientY });
    },
    // macOS turns no key into contextmenu: Shift+F10 and the context menu key open it here.
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
      e.preventDefault();
      show(id, e.currentTarget);
    },
  });
  const menuFor = (s: SessionView): MenuEntry[] => {
    const own = state.sessions.filter((x) => x.projectId === s.projectId);
    const index = own.indexOf(s);
    const act = (action: SessionAction) => () => props.onSessionAction(s.id, action);
    const item = (label: string, onSelect: () => void, more: Partial<MenuEntry> = {}) =>
      ({ kind: 'item', label, onSelect, ...more }) as MenuEntry;
    // A session in its own window has these forms there; this window cannot reach them.
    const away = { disabled: props.undocked?.includes(s.id) };
    return [
      item(t.menu.describe, act('describe'), away),
      {
        kind: 'swatches',
        label: t.tabColor,
        options: [null, ...TAB_COLORS].map((color) => ({
          label: t.colors[color ?? 'none'],
          color: color ? `var(--hangar-color-tab-${color})` : undefined,
          checked: (s.color ?? null) === color,
          onSelect: act({ color }),
        })),
      },
      item(t.menu.up, () => props.onMoveSession(s.id, index - 1), { disabled: index === 0 }),
      item(t.menu.down, () => props.onMoveSession(s.id, index + 1), {
        disabled: index === own.length - 1,
      }),
      { kind: 'separator' },
      item(props.undocked?.includes(s.id) ? t.dock : t.menu.window, act('window')),
      item(t.menu.job, act('job'), away),
      item(t.menu.env, act('env'), away),
      item(t.menu.copyPath, act('copyPath')),
      { kind: 'separator' },
      item(t.menu.restart, act('restart')),
      item(t.menu.close, act('close'), { danger: true }),
    ];
  };
  const opened = menu && state.sessions.find((s) => s.id === menu.id);
  const menuElement = opened && (
    <Menu
      label={`${t.session} ${sessionName(opened)}`}
      at={menu.at}
      entries={menuFor(opened)}
      onClose={closeMenu}
    />
  );
  const count = (status: keyof typeof t.status) =>
    state.sessions.filter((s) => s.status === status).length;

  if (collapsed) {
    // As narrow as the bay bar: one status light per session, in project order.
    return (
      <nav className="tree chamfer" aria-label={t.tree} data-collapsed="">
        <div className="tree-header">{toggleButton}</div>
        <ul className="tree-lights">
          {state.projects.flatMap((project) =>
            state.sessions
              .filter((s) => s.projectId === project.id)
              .map((s) => {
                // No second line here: the short id tells sessions with one description apart.
                const id = s.description ? ` (${s.id.slice(0, 8)})` : '';
                const name = `${sessionName(s)}${id} – ${project.name}`;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      className={`tree-light status-${s.status}`}
                      aria-current={s.id === selectedId ? 'true' : undefined}
                      aria-label={`${name}, ${t.status[s.status]}`}
                      title={name}
                      data-testid={`session-${s.id}`}
                      data-color={s.color}
                      style={tabColorStyle(s.color)}
                      onClick={() => props.onSelect(s.id)}
                      {...menuProps(s.id)}
                    >
                      <span className="light" role="img" aria-hidden="true" />
                    </button>
                  </li>
                );
              }),
          )}
        </ul>
        {menuElement}
      </nav>
    );
  }

  return (
    <nav className="tree chamfer" aria-label={t.tree}>
      <div className="tree-header">
        {toggleButton}
        <h1>{t.projects}</h1>
        <button
          type="button"
          className="icon-button"
          aria-label={t.addProject}
          title={t.addProject}
          onClick={props.onAddProject}
        >
          +
        </button>
      </div>
      {state.projects.length === 0 && <p className="muted tree-empty">{t.noProject}</p>}
      <ul className="tree-list">
        {state.projects.map((project, index) => {
          const sessions = state.sessions.filter((s) => s.projectId === project.id);
          const closed = sessions.length > 0 && hidden.includes(project.id);
          return (
            <li
              key={project.id}
              className={
                project.id !== dropTarget?.id
                  ? 'tree-project-item'
                  : dropTarget.after
                    ? 'tree-project-item drop-target drop-after'
                    : 'tree-project-item drop-target'
              }
              onDragOver={(e) => {
                if (!dragged.current) return;
                e.preventDefault();
                const from = state.projects.findIndex((p) => p.id === dragged.current);
                setDropTarget({ id: project.id, after: from < index });
              }}
              onDragLeave={() => setDropTarget(undefined)}
              onDrop={() => drop(project.id, index)}
            >
              <div
                className="tree-project"
                draggable
                onDragStart={() => (dragged.current = project.id)}
                onDragEnd={endDrag}
              >
                {sessions.length > 0 && (
                  <button
                    type="button"
                    className="icon-button tree-project-toggle"
                    aria-expanded={!closed}
                    aria-label={
                      closed ? t.showSessions(project.name) : t.hideSessions(project.name)
                    }
                    title={closed ? t.showSessions(project.name) : t.hideSessions(project.name)}
                    onClick={() => toggleProject(project.id)}
                  >
                    {closed ? '▸' : '▾'}
                  </button>
                )}
                <button
                  type="button"
                  className="tree-project-open"
                  // Collapsed, the path still tells projects of the same name apart.
                  title={closed ? project.path : undefined}
                  aria-current={project.id === props.selectedProjectId ? 'true' : undefined}
                  onClick={() => props.onSelectProject(project.id)}
                >
                  <span className="tree-project-name">{project.name}</span>
                  {!closed && (
                    <span className="tree-project-path" title={project.path}>
                      {project.path}
                    </span>
                  )}
                </button>
                {closed && sessions.some((s) => s.status === 'waiting') && (
                  // Hidden sessions waiting for input must not go unnoticed.
                  <span className="status-waiting">
                    <span
                      className="light"
                      role="img"
                      aria-label={t.status.waiting}
                      title={t.status.waiting}
                    />
                  </span>
                )}
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t.newSessionIn(project.name)}
                  title={t.newSession}
                  // The further clicks of a double click (detail 2, 3 …) do not repeat it.
                  onClick={(e) => e.detail <= 1 && props.onCreateSession(project.id)}
                >
                  +
                </button>
              </div>
              {!closed && (
                <ul className="tree-sessions">
                  {sessions.map((s, index) => (
                    <li
                      key={s.id}
                      className={
                        sessionTarget?.id !== s.id
                          ? undefined
                          : sessionTarget.after
                            ? 'drop-target drop-after'
                            : 'drop-target'
                      }
                      onDragStart={() =>
                        (draggedSession.current = { id: s.id, projectId: project.id, index })
                      }
                      onDragEnd={endSessionDrag}
                      onDragOver={(e) => {
                        const d = sessionFor(s.id, project.id);
                        if (!d) return;
                        e.preventDefault();
                        setSessionTarget({ id: s.id, after: d.index < index });
                      }}
                      onDragLeave={() => setSessionTarget(undefined)}
                      onDrop={() => {
                        const d = sessionFor(s.id, project.id);
                        if (!d) return;
                        props.onMoveSession(d.id, index);
                        endSessionDrag();
                      }}
                    >
                      <button
                        type="button"
                        draggable
                        className={`tree-session chamfer status-${s.status}`}
                        aria-current={s.id === selectedId ? 'true' : undefined}
                        data-testid={`session-${s.id}`}
                        data-color={s.color}
                        style={tabColorStyle(s.color)}
                        onClick={() => props.onSelect(s.id)}
                        {...menuProps(s.id)}
                      >
                        <span
                          className="light"
                          role="img"
                          aria-label={t.status[s.status]}
                          title={t.status[s.status]}
                        />
                        <span className="tree-session-title">{sessionName(s)}</span>
                        {s.description && (
                          <span className="tree-session-branch">{branchOf(s)}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {menuElement}
      <RemoteList projects={props.remote ?? []} />
      <ul className="tree-foot" aria-label={t.overview}>
        <li className="readout">
          <b>{state.sessions.length}</b>
          <span>{t.sessions}</span>
        </li>
        <li className="readout">
          <b>{count('working')}</b>
          <span>{t.shortStatus.working}</span>
        </li>
        <li className={count('waiting') > 0 ? 'readout readout-alert' : 'readout'}>
          <b>{count('waiting')}</b>
          <span>{t.shortStatus.waiting}</span>
        </li>
      </ul>
    </nav>
  );
}
