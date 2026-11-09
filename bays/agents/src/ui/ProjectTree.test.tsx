import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectTree } from './ProjectTree';
import { setLocale } from './messages';
import type { SessionView, StateView } from '../main/types';

const session = (over: Partial<SessionView>): SessionView => ({
  id: 's1',
  projectId: 'p1',
  worktreePath: '/wt',
  branch: 'hangar/s1',
  description: '',
  status: 'idle',
  env: {},
  portBase: 40_000,
  statusbar: [],
  createdAt: '',
  running: true,
  ...over,
});

const state: StateView = {
  projects: [
    { id: 'p1', name: 'shop', path: '/code/shop' },
    { id: 'p2', name: 'blog', path: '/code/blog' },
  ],
  sessions: [
    session({ id: 's1', description: 'Login reparieren', status: 'waiting' }),
    session({ id: 's2', branch: 'hangar/s2', status: 'working' }),
    session({ id: 's4', branch: 'hangar/s4', status: 'background' }),
    session({ id: 's3', projectId: 'p2', status: 'done' }),
  ],
};

function renderTree(over: Partial<Parameters<typeof ProjectTree>[0]> = {}) {
  const props = {
    state,
    selectedId: 's1',
    onSelect: vi.fn(),
    onAddProject: vi.fn(),
    onSelectProject: vi.fn(),
    onCreateSession: vi.fn(),
    onMoveProject: vi.fn(),
    onMoveSession: vi.fn(),
    onSessionAction: vi.fn(),
    ...over,
  };
  render(<ProjectTree {...props} />);
  return props;
}

afterEach(() => localStorage.clear());

describe('ProjectTree', () => {
  it('nests sessions under their project with description (or branch) and status', () => {
    renderTree();
    const shop = screen.getByText('shop').closest('li')!;
    const s1 = within(shop).getByTestId('session-s1');
    expect(s1).toHaveTextContent('Login reparieren');
    expect(within(s1).getByRole('img', { name: 'wartet auf Eingabe' })).toBeInTheDocument();
    expect(within(shop).getByTestId('session-s2')).toHaveTextContent('hangar/s2');
    expect(within(shop).getByRole('img', { name: 'arbeitet' })).toBeInTheDocument();
    // Waits on CI or a watch in the background: not counted as waiting for input.
    expect(within(shop).getByRole('img', { name: 'wartet auf Hintergrund' })).toBeInTheDocument();
    expect(within(shop).queryByTestId('session-s3')).toBeNull();
    expect(s1).toHaveAttribute('aria-current', 'true');
  });

  it('marks a session with its tab color', () => {
    renderTree({
      state: { ...state, sessions: [session({ id: 's1', color: 'pink' }), session({ id: 's2' })] },
    });
    expect(screen.getByTestId('session-s1').style.getPropertyValue('--tab-color')).toBe(
      'var(--hangar-color-tab-pink)',
    );
    expect(screen.getByTestId('session-s2').style.getPropertyValue('--tab-color')).toBe('');
  });

  it('shows the status only as the light, with its name as tooltip', () => {
    renderTree();
    const s1 = screen.getByTestId('session-s1');
    expect(s1).not.toHaveTextContent('wartet');
    expect(within(s1).getByRole('img', { name: 'wartet auf Eingabe' })).toHaveAttribute(
      'title',
      'wartet auf Eingabe',
    );
  });

  it('adds a project with a "+" icon button like a new session', () => {
    renderTree();
    const add = screen.getByRole('button', { name: 'Projekt hinzufügen' });
    expect(add).toHaveTextContent(/^\+$/);
    expect(add).toHaveClass('icon-button');
    expect(add).toHaveAttribute('title', 'Projekt hinzufügen');
  });

  it('keeps every "+" in the right-hand column: last in the header and in each project row', () => {
    renderTree();
    const header = screen.getByRole('heading', { name: 'Projekte' }).parentElement!;
    expect(within(header).getAllByRole('button').at(-1)).toHaveAccessibleName('Projekt hinzufügen');
    const row = screen.getByRole('button', { name: 'Neue Session in blog' }).parentElement!;
    expect(within(row).getAllByRole('button').at(-1)).toHaveTextContent(/^\+$/);
    expect(screen.queryByRole('button', { name: /entfernen/ })).toBeNull();
  });

  it('triggers project and session actions', async () => {
    const props = renderTree();
    await userEvent.click(screen.getByRole('button', { name: 'Projekt hinzufügen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Neue Session in blog' }));
    await userEvent.click(screen.getByRole('button', { name: /^shop/ }));
    await userEvent.click(screen.getByTestId('session-s3'));
    expect(props.onAddProject).toHaveBeenCalled();
    expect(props.onCreateSession).toHaveBeenCalledWith('p2');
    expect(props.onSelectProject).toHaveBeenCalledWith('p1');
    expect(props.onSelect).toHaveBeenCalledWith('s3');
  });

  it('offers one way to start a session and names one in the project folder so (ADR 0022)', async () => {
    renderTree();
    expect(screen.queryByRole('button', { name: /im Projektordner/ })).toBeNull();
    cleanup();
    renderTree({
      state: {
        projects: [{ id: 'p1', name: 'shop', path: '/code/shop' }],
        sessions: [session({ id: 's9', branch: '', place: 'project' })],
      },
    });
    // Sessions in one folder share it; the short id tells them apart until described.
    expect(screen.getByTestId('session-s9')).toHaveTextContent('s9');
    expect(screen.getByTestId('session-s9')).not.toHaveTextContent('Projektordner');
  });

  it('marks the project whose overview is open', () => {
    renderTree({ selectedId: undefined, selectedProjectId: 'p2' });
    expect(screen.getByRole('button', { name: /^blog/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: /^shop/ })).not.toHaveAttribute('aria-current');
  });

  it('shows project paths and session counts in the footer', () => {
    renderTree();
    expect(screen.getByText('/code/shop')).toBeVisible();
    const foot = screen.getByRole('list', { name: 'Übersicht' });
    expect(foot).toHaveTextContent('4Sessions');
    expect(foot).toHaveTextContent('1arbeitet');
    expect(foot).toHaveTextContent('1wartet');
  });

  it('shows text from agents as text, never as markup', () => {
    const markup = '<img src=x onerror="alert(1)">';
    const { container } = render(
      <ProjectTree
        state={{ projects: state.projects, sessions: [session({ description: markup })] }}
        onSelect={vi.fn()}
        onAddProject={vi.fn()}
        onSelectProject={vi.fn()}
        onCreateSession={vi.fn()}
        onMoveProject={vi.fn()}
        onMoveSession={vi.fn()}
        onSessionAction={vi.fn()}
      />,
    );
    expect(screen.getByTestId('session-s1')).toHaveTextContent(markup);
    expect(container.querySelector('img')).toBeNull();
  });

  it('explains the empty state', () => {
    renderTree({ state: { projects: [], sessions: [] } });
    expect(screen.getByText('Noch kein Projekt.')).toBeVisible();
  });

  it('collapses to a column of status lights that still select sessions, and remembers it', async () => {
    const props = renderTree();
    const toggle = screen.getByRole('button', { name: 'Projektleiste einklappen' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(toggle);
    expect(localStorage.getItem('treeCollapsed')).toBe('1');
    expect(screen.queryByText('/code/shop')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Projekt hinzufügen' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Übersicht' })).toBeNull();
    const s1 = screen.getByTestId('session-s1');
    expect(s1).toHaveAccessibleName('Login reparieren (s1) – shop, wartet auf Eingabe');
    expect(s1).toHaveAttribute('title', 'Login reparieren (s1) – shop');
    // Without the second line, the short id tells sessions with one description apart.
    expect(screen.getByTestId('session-s2')).toHaveAttribute('title', 'hangar/s2 – shop');
    expect(s1).toHaveAttribute('aria-current', 'true');
    expect(within(s1).getByRole('img', { hidden: true })).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('session-s3'));
    expect(props.onSelect).toHaveBeenCalledWith('s3');
    const expand = screen.getByRole('button', { name: 'Projektleiste ausklappen' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(expand);
    expect(localStorage.getItem('treeCollapsed')).toBeNull();
    expect(screen.getByText('/code/shop')).toBeVisible();
  });

  it('toggles by keyboard and keeps the focus on the toggle', async () => {
    renderTree();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Projektleiste einklappen' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Projektleiste ausklappen' })).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(screen.getByRole('button', { name: 'Projektleiste einklappen' })).toHaveFocus();
  });

  it('starts collapsed after a restart when it was left so', () => {
    localStorage.setItem('treeCollapsed', '1');
    renderTree();
    expect(screen.getByRole('navigation')).toHaveAttribute('data-collapsed');
    expect(screen.getByRole('button', { name: 'Projektleiste ausklappen' })).toBeVisible();
  });

  it('speaks the app language', () => {
    setLocale('en');
    try {
      renderTree();
      expect(screen.getByRole('button', { name: 'Add project' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'New session in shop' })).toBeVisible();
      expect(screen.getByRole('img', { name: 'waiting for input' })).toBeVisible();
      expect(screen.getByRole('list', { name: 'Overview' })).toHaveTextContent('4Sessions');
      expect(screen.getByRole('button', { name: 'Collapse project bar' })).toBeVisible();
    } finally {
      setLocale('de');
    }
  });

  it('collapses a project to its name, hides its sessions and remembers it', async () => {
    renderTree();
    const shop = screen.getByText('shop').closest('li')!;
    const hide = within(shop).getByRole('button', { name: 'Sessions von shop ausblenden' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(hide);
    expect(within(shop).queryByTestId('session-s1')).toBeNull();
    expect(screen.queryByText('/code/shop')).toBeNull();
    expect(screen.getByTestId('session-s3')).toBeVisible();
    // A hidden session waiting for input still shows on the project.
    expect(within(shop).getByRole('img', { name: 'wartet auf Eingabe' })).toBeVisible();
    expect(JSON.parse(localStorage.getItem('collapsedProjects')!)).toEqual(['p1']);
    cleanup();

    renderTree();
    const show = screen.getByRole('button', { name: 'Sessions von shop einblenden' });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(show);
    expect(screen.getByTestId('session-s1')).toBeVisible();
    expect(screen.getByText('/code/shop')).toBeVisible();
    expect(JSON.parse(localStorage.getItem('collapsedProjects')!)).toEqual([]);
  });

  it('offers to collapse only projects with sessions, and no waiting light without one', async () => {
    renderTree({
      state: {
        projects: state.projects,
        sessions: [session({ id: 's3', projectId: 'p2', status: 'working' })],
      },
    });
    expect(screen.queryByRole('button', { name: /von shop/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Sessions von blog ausblenden' }));
    expect(screen.queryByRole('img', { name: 'wartet auf Eingabe' })).toBeNull();
  });

  it('moves a project by dragging it onto another one', () => {
    const props = renderTree();
    const row = (name: string) => screen.getByText(name).closest('.tree-project')!;
    expect(row('blog')).toHaveAttribute('draggable', 'true');
    fireEvent.dragStart(row('blog'));
    fireEvent.dragOver(row('shop'));
    expect(row('shop').closest('li')).toHaveClass('drop-target');
    fireEvent.drop(row('shop'));
    expect(props.onMoveProject).toHaveBeenCalledWith('p2', 0);
    expect(row('shop').closest('li')).not.toHaveClass('drop-target');
    // Dropped on itself or left the tree: nothing moves.
    fireEvent.dragStart(row('shop'));
    fireEvent.dragOver(row('blog'));
    fireEvent.dragLeave(row('blog'));
    expect(row('blog').closest('li')).not.toHaveClass('drop-target');
    fireEvent.drop(row('shop'));
    // Cancelled (Esc, dropped outside): dragEnd without drop.
    fireEvent.dragStart(row('shop'));
    fireEvent.dragEnd(row('shop'));
    fireEvent.drop(row('blog'));
    expect(props.onMoveProject).toHaveBeenCalledTimes(1);
    // Dragged down, it lands below the target: the mark says so.
    fireEvent.dragStart(row('shop'));
    fireEvent.dragOver(row('blog'));
    expect(row('blog').closest('li')).toHaveClass('drop-target drop-after');
    fireEvent.drop(row('blog'));
    expect(props.onMoveProject).toHaveBeenLastCalledWith('p1', 1);
  });

  it('moves a session by dragging it onto another of its project', () => {
    const props = renderTree({ onMoveSession: vi.fn() });
    const item = (id: string) => screen.getByTestId(`session-${id}`).closest('li')!;
    expect(screen.getByTestId('session-s4')).toHaveAttribute('draggable', 'true');
    fireEvent.dragStart(item('s4'));
    fireEvent.dragOver(item('s1'));
    expect(item('s1')).toHaveClass('drop-target');
    // Not into another project, and the project rows do not take it.
    fireEvent.dragOver(item('s3'));
    expect(item('s3')).not.toHaveClass('drop-target');
    fireEvent.drop(item('s3'));
    fireEvent.drop(screen.getByText('blog').closest('.tree-project')!);
    expect(props.onMoveProject).not.toHaveBeenCalled();
    fireEvent.drop(item('s1'));
    expect(props.onMoveSession).toHaveBeenCalledWith('s4', 0);
    expect(props.onMoveSession).toHaveBeenCalledTimes(1);
    expect(item('s1')).not.toHaveClass('drop-target');
    // Down: the mark goes below the target; left or cancelled, nothing moves.
    fireEvent.dragStart(item('s1'));
    fireEvent.dragOver(item('s2'));
    expect(item('s2')).toHaveClass('drop-target drop-after');
    fireEvent.dragLeave(item('s2'));
    expect(item('s2')).not.toHaveClass('drop-target');
    fireEvent.dragEnd(item('s1'));
    fireEvent.drop(item('s2'));
    expect(props.onMoveSession).toHaveBeenCalledTimes(1);
    // A project dragged over a session is not a session.
    fireEvent.dragStart(screen.getByText('blog').closest('.tree-project')!);
    fireEvent.dragOver(item('s1'));
    expect(item('s1')).not.toHaveClass('drop-target');
    fireEvent.drop(item('s1'));
    expect(props.onMoveSession).toHaveBeenCalledTimes(1);
  });

  it('ignores a damaged list of collapsed projects', () => {
    for (const saved of ['[', 'null', '{}']) {
      localStorage.setItem('collapsedProjects', saved);
      renderTree();
      expect(screen.getByTestId('session-s1')).toBeVisible();
      cleanup();
    }
  });

  it('keeps the path of a collapsed project as its tooltip (projects of the same name)', async () => {
    renderTree();
    await userEvent.click(screen.getByRole('button', { name: 'Sessions von shop ausblenden' }));
    expect(screen.getByRole('button', { name: /^shop/ })).toHaveAttribute('title', '/code/shop');
  });

  it('creates one session for a double or triple click on the plus', async () => {
    const props = renderTree();
    const plus = screen.getByRole('button', { name: 'Neue Session in shop' });
    await userEvent.dblClick(plus);
    await userEvent.tripleClick(plus);
    expect(props.onCreateSession).toHaveBeenCalledTimes(2);
  });

  describe('context menu of a session', () => {
    const open = (id: string) =>
      fireEvent.contextMenu(screen.getByTestId(`session-${id}`), { clientX: 50, clientY: 60 });

    it('opens on a right click with the main actions, named after the session', () => {
      renderTree();
      open('s2');
      const menu = screen.getByRole('menu', { name: 'Session hangar/s2' });
      expect(menu).toHaveStyle({ left: '50px', top: '60px' });
      expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
        'Beschreibung ändern…',
        'Nach oben',
        'Nach unten',
        'In eigenem Fenster öffnen',
        'Job planen…',
        'Umgebungsvariablen…',
        'Pfad kopieren',
        'Shell neu starten',
        'Session schließen…',
      ]);
      expect(screen.getAllByRole('menuitemradio')).toHaveLength(9);
    });

    it('moves the session within its project, never past the ends', async () => {
      const props = renderTree();
      open('s2');
      await userEvent.click(screen.getByRole('menuitem', { name: 'Nach oben' }));
      expect(props.onMoveSession).toHaveBeenLastCalledWith('s2', 0);
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      open('s2');
      await userEvent.click(screen.getByRole('menuitem', { name: 'Nach unten' }));
      expect(props.onMoveSession).toHaveBeenLastCalledWith('s2', 2);
      open('s1');
      expect(screen.getByRole('menuitem', { name: 'Nach oben' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      cleanup();
      renderTree();
      open('s4');
      expect(screen.getByRole('menuitem', { name: 'Nach unten' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });

    it('hands the other actions to the app, the color checked as it is', async () => {
      const props = renderTree({
        state: {
          ...state,
          sessions: [session({ id: 's1', color: 'red' }), ...state.sessions.slice(1)],
        },
      });
      const cases = [
        ['Beschreibung ändern…', 'describe'],
        ['In eigenem Fenster öffnen', 'window'],
        ['Job planen…', 'job'],
        ['Umgebungsvariablen…', 'env'],
        ['Pfad kopieren', 'copyPath'],
        ['Shell neu starten', 'restart'],
        ['Session schließen…', 'close'],
      ] as const;
      for (const [label, action] of cases) {
        open('s1');
        await userEvent.click(screen.getByRole('menuitem', { name: label }));
        expect(props.onSessionAction).toHaveBeenLastCalledWith('s1', action);
      }
      open('s1');
      expect(screen.getByRole('menuitemradio', { name: 'Rot' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await userEvent.click(screen.getByRole('menuitemradio', { name: 'Blau' }));
      expect(props.onSessionAction).toHaveBeenLastCalledWith('s1', { color: 'blue' });
      open('s1');
      await userEvent.click(screen.getByRole('menuitemradio', { name: 'Keine' }));
      expect(props.onSessionAction).toHaveBeenLastCalledWith('s1', { color: null });
    });

    it('offers to dock a session that runs in its own window, whose forms are there', () => {
      renderTree({ undocked: ['s1'] });
      open('s1');
      expect(screen.getByRole('menuitem', { name: 'Andocken' })).toBeInTheDocument();
      for (const name of ['Beschreibung ändern…', 'Job planen…', 'Umgebungsvariablen…'])
        expect(screen.getByRole('menuitem', { name })).toHaveAttribute('aria-disabled', 'true');
    });

    it('closes on Tab and Shift+Tab and lets the focus move on from the session', async () => {
      renderTree();
      const [s1, s2] = [screen.getByTestId('session-s1'), screen.getByTestId('session-s2')];
      s1.focus();
      await userEvent.keyboard('{Shift>}{F10}{/Shift}{Tab}');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(s2).toHaveFocus();
      await userEvent.keyboard('{Shift>}{F10}{Tab}{/Shift}');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(s1).toHaveFocus();
    });

    it('opens by keyboard too and gives the focus back on Escape', async () => {
      renderTree();
      const s1 = screen.getByTestId('session-s1');
      s1.focus();
      // The context menu key or Shift+F10 fire contextmenu on the focused element, at 0/0.
      fireEvent.contextMenu(s1, { clientX: 0, clientY: 0 });
      expect(screen.getByRole('menuitem', { name: 'Beschreibung ändern…' })).toHaveFocus();
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(s1).toHaveFocus();
    });

    it('opens with Shift+F10 or the context menu key, which macOS does not turn into contextmenu', async () => {
      renderTree();
      const s1 = screen.getByTestId('session-s1');
      s1.focus();
      await userEvent.keyboard('{Shift>}{F10}{/Shift}');
      expect(screen.getByRole('menuitem', { name: 'Beschreibung ändern…' })).toHaveFocus();
      await userEvent.keyboard('{Escape}');
      fireEvent.keyDown(s1, { key: 'ContextMenu' });
      expect(screen.getByRole('menu')).toBeInTheDocument();
      await userEvent.keyboard('{Escape}');
      // F10 alone opens nothing.
      await userEvent.keyboard('{F10}');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('opens on the status lights of the collapsed bar as well', async () => {
      renderTree();
      await userEvent.click(screen.getByRole('button', { name: 'Projektleiste einklappen' }));
      open('s3');
      expect(screen.getByRole('menu', { name: /^Session / })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Nach oben' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });
  });
});
