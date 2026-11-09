import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { RemoteProject } from '../main/share';
import type { AgentsApi } from './api';
import type { Project, SessionView, StateView } from '../main/types';

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const session: SessionView = {
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
};
const withProject: StateView = {
  projects: [{ id: 'p1', name: 'shop', path: '/shop' }],
  sessions: [],
};

function setup(
  initial: StateView = withProject,
  current?: string,
  server?: string,
  over: Partial<Record<'state' | 'remote' | 'quota', () => Promise<never>>> = {},
) {
  let pushState: (s: StateView) => void = () => {};
  let pushWindows: (keys: string[]) => void = () => {};
  let pushData: (e: { id: string; data: string; end?: number }) => void = () => {};
  let pushRemote: (p: RemoteProject[]) => void = () => {};
  const api = {
    state: vi.fn(async () => initial),
    addProject: vi.fn(async () => {
      throw new Error("Error invoking remote method 'bay:invoke': Error: Kein Git-Repository: /x");
    }),
    removeProject: vi.fn(async () => {}),
    moveProject: vi.fn(async () => {}),
    moveSession: vi.fn(async () => {}),
    projectDetails: vi.fn(async () => ({ worktrees: [], orphans: [] })),
    deleteBranch: vi.fn(async () => {}),
    setProjectEnv: vi.fn(async () => {}),
    secrets: vi.fn(async () => []),
    createSession: vi.fn(async () => session),
    closeSession: vi.fn(),
    restart: vi.fn(),
    update: vi.fn(),
    input: vi.fn(),
    resize: vi.fn(),
    snapshot: vi.fn(),
    onState: (l: (s: StateView) => void) => ((pushState = l), () => {}),
    onData: (l: (e: { id: string; data: string; end?: number }) => void) => (
      (pushData = l),
      () => {}
    ),
    onExit: () => () => {},
    quota: vi.fn(async () => ({ claude: { usedPercent: 6 } })),
    remote: vi.fn(async (): Promise<RemoteProject[]> => []),
    onRemote: (l: (p: RemoteProject[]) => void) => ((pushRemote = l), () => {}),
    onQuota: () => () => {},
    server,
    windows: {
      current,
      open: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      list: vi.fn(async () => []),
      onChange: (l: (keys: string[]) => void) => ((pushWindows = l), () => {}),
    },
  } as unknown as AgentsApi;
  const terminals = {
    attach: vi.fn(),
    focus: vi.fn(),
    fit: vi.fn(),
    write: vi.fn(),
    dispose: vi.fn(),
    has: vi.fn(),
    setCopyOnSelect: vi.fn(),
  };
  Object.assign(api, over);
  render(<App api={api} terminals={terminals} />);
  return {
    api,
    terminals,
    push: (s: StateView) => act(() => pushState(s)),
    data: (e: { id: string; data: string; end?: number }) => act(() => pushData(e)),
    windows: (keys: string[]) => act(() => pushWindows(keys)),
    remote: (p: RemoteProject[]) => act(() => pushRemote(p)),
  };
}

afterEach(() => localStorage.clear());

describe('agents App', () => {
  it('leaves no rejection unhandled when the first loads fail (server bay without connection)', async () => {
    // Plain functions: vi.fn handles the promises it returns itself.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const gone = () => Promise.reject(new Error('Not connected: 02084b5b'));
      setup(withProject, undefined, undefined, { state: gone, remote: gone, quota: gone });
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('shows what other instances share below the own projects, and its changes (ADR 0030)', async () => {
    const ctx = setup();
    await screen.findByText('shop');
    expect(ctx.api.remote).toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Andere Instanzen' })).toBeNull();
    ctx.remote([
      { workspace: 'team', instance: 'f'.repeat(64), name: 'anna', project: 'web', sessions: [] },
    ]);
    const region = screen.getByRole('region', { name: 'Andere Instanzen' });
    expect(within(region).getByRole('listitem', { name: 'web – anna (team)' })).toBeVisible();
  });

  it('shows the usage limits as footer of the main view, not in a session window', async () => {
    setup();
    expect(await screen.findByRole('group', { name: 'Kontingente' })).toBeVisible();
    cleanup();
    setup({ ...withProject, sessions: [session] }, session.id);
    await screen.findByRole('region', { name: /^Session/ });
    expect(screen.queryByRole('group', { name: 'Kontingente' })).toBeNull();
  });

  it('reopens the session selected before the restart', async () => {
    setup({ ...withProject, sessions: [{ ...session, description: 'Login' }] });
    await userEvent.click(await screen.findByTestId('session-s1'));
    cleanup();
    setup({ ...withProject, sessions: [{ ...session, description: 'Login' }] });
    expect(await screen.findByRole('textbox', { name: 'Beschreibung' })).toHaveValue('Login');
  });

  it('points to the button that exists: add a project first, then start a session', async () => {
    setup({ projects: [], sessions: [] });
    expect(
      await screen.findByText('Füge mit „+“ neben „Projekte“ ein Git-Repository hinzu.'),
    ).toBeVisible();
  });

  it('names the new-session button in the placeholder once a project exists', async () => {
    setup();
    expect(
      await screen.findByText(
        'Wähle links eine Session oder starte eine mit „+“ neben einem Projekt.',
      ),
    ).toBeVisible();
  });

  it('starts a session and shows it', async () => {
    const { api, push, data, terminals } = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Neue Session in shop' }));
    expect(api.createSession).toHaveBeenCalledWith('p1');
    push({ ...withProject, sessions: [session] });
    expect(screen.getByRole('region', { name: /^Session/ })).toBeVisible();
    data({ id: 's1', data: 'hi', end: 2 });
    expect(terminals.write).toHaveBeenCalledWith('s1', 'hi', 2);

    push(withProject);
    expect(terminals.dispose).toHaveBeenCalledWith('s1');
    expect(screen.queryByRole('region', { name: /^Session/ })).toBeNull();
  });

  it('shows main-process errors without the IPC prefix and dismisses them', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Projekt hinzufügen' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Kein Git-Repository: /x');
    await userEvent.click(screen.getByRole('button', { name: 'Meldung schließen' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('opens the project overview from the tree and removes the project there after confirmation', async () => {
    const { api } = setup({ ...withProject, sessions: [session] });
    await userEvent.click(await screen.findByTestId('session-s1'));
    await userEvent.click(screen.getByRole('button', { name: /^shop/ }));
    expect(screen.queryByRole('region', { name: /^Session/ })).toBeNull();
    expect(await screen.findByRole('heading', { level: 1, name: 'shop' })).toBeVisible();
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole('button', { name: 'Projekt entfernen' }));
    expect(api.removeProject).toHaveBeenCalledWith('p1');
  });

  it('moves projects from the overview and by dragging in the tree', async () => {
    const { api } = setup({
      projects: [...withProject.projects, { id: 'p2', name: 'blog', path: '/blog' }],
      sessions: [],
    });
    await userEvent.click(await screen.findByRole('button', { name: /^blog/ }));
    expect(screen.getByRole('button', { name: 'Projekt nach unten' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Projekt nach oben' }));
    expect(api.moveProject).toHaveBeenLastCalledWith('p2', 0);
    await userEvent.click(screen.getByRole('button', { name: /^shop/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Projekt nach unten' }));
    expect(api.moveProject).toHaveBeenLastCalledWith('p1', 1);
    const row = (name: string) => screen.getAllByText(name)[0]!.closest('.tree-project')!;
    fireEvent.dragStart(row('shop'));
    fireEvent.drop(row('blog'));
    await waitFor(() => expect(api.moveProject).toHaveBeenCalledTimes(3));
  });

  it('reopens the project overview selected before the restart', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: /^shop/ }));
    cleanup();
    setup();
    expect(await screen.findByRole('heading', { level: 1, name: 'shop' })).toBeVisible();
  });

  it('opens a session from the project overview', async () => {
    setup({ ...withProject, sessions: [{ ...session, description: 'Login' }] });
    await userEvent.click(await screen.findByRole('button', { name: /^shop/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Login' }));
    expect(screen.getByRole('textbox', { name: 'Beschreibung' })).toHaveValue('Login');
  });

  it('asks for one project folder while the dialog is open', async () => {
    const { api } = setup();
    let finish!: () => void;
    vi.mocked(api.addProject).mockImplementation(
      () => new Promise((r) => (finish = () => r({ id: 'p2', name: 'demo', path: '/demo' }))),
    );
    const add = await screen.findByRole('button', { name: 'Projekt hinzufügen' });
    await userEvent.dblClick(add);
    await userEvent.click(add);
    expect(api.addProject).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await userEvent.click(add);
    expect(api.addProject).toHaveBeenCalledTimes(2);
  });

  it('runs the same action only once while it is still running (double click)', async () => {
    const { api, push } = setup();
    let finishCreate!: (s: SessionView) => void;
    vi.mocked(api.createSession).mockImplementation(
      () => new Promise<SessionView>((r) => (finishCreate = r)),
    );
    const plus = await screen.findByRole('button', { name: 'Neue Session in shop' });
    await userEvent.dblClick(plus);
    expect(api.createSession).toHaveBeenCalledTimes(1);
    await act(async () => finishCreate(session));
    await userEvent.click(plus);
    expect(api.createSession).toHaveBeenCalledTimes(2);

    push({ ...withProject, sessions: [session] });
    let finishClose!: () => void;
    vi.mocked(api.closeSession).mockImplementation(
      () => new Promise((r) => (finishClose = () => r({ worktreeRemoved: true }))),
    );
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.dblClick(screen.getByRole('button', { name: 'Session schließen' }));
    expect(api.closeSession).toHaveBeenCalledTimes(1);
    await act(async () => finishClose());
    expect(screen.queryByRole('alert')).toBeNull();
    confirm.mockRestore();
  });

  describe('grid', () => {
    const two: StateView = {
      ...withProject,
      sessions: [
        { ...session, description: 'Login' },
        { ...session, id: 's2', branch: 'hangar/s2', description: 'Suche' },
      ],
    };
    // A 27-inch screen: room for three fields side by side and two rows.
    const screenOf = (width: number, height: number) => {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(height);
    };
    afterEach(() => vi.restoreAllMocks());

    it('adds a field, shows the next session there and keeps both visible', async () => {
      screenOf(2200, 1350);
      const { terminals } = setup(two);
      await userEvent.click(await screen.findByTestId('session-s1'));
      await userEvent.click(screen.getByRole('button', { name: 'Feld hinzufügen' }));
      expect(screen.getByRole('group', { name: 'Feld 2' })).toHaveTextContent(
        'Wähle links eine Session',
      );
      await userEvent.click(screen.getByTestId('session-s2'));
      expect(screen.getByRole('region', { name: 'Session Login' })).toBeVisible();
      expect(screen.getByRole('region', { name: 'Session Suche' })).toBeVisible();
      expect(terminals.focus).toHaveBeenLastCalledWith('s2');
      expect(screen.getByTestId('session-s2')).toHaveAttribute('aria-current', 'true');
    });

    it('focuses the field that already shows a session instead of showing it twice', async () => {
      screenOf(2200, 1350);
      setup(two);
      await userEvent.click(await screen.findByTestId('session-s1'));
      await userEvent.click(screen.getByRole('button', { name: 'Feld hinzufügen' }));
      await userEvent.click(screen.getByTestId('session-s1'));
      expect(screen.getAllByRole('region', { name: 'Session Login' })).toHaveLength(1);
      expect(screen.getByRole('group', { name: 'Feld 1' })).toHaveAttribute('data-focused');
    });

    it('closes a field while its session keeps running', async () => {
      screenOf(2200, 1350);
      const { api } = setup(two);
      await userEvent.click(await screen.findByTestId('session-s1'));
      await userEvent.click(screen.getByRole('button', { name: 'Feld hinzufügen' }));
      await userEvent.click(screen.getByTestId('session-s2'));
      await userEvent.click(
        within(screen.getByRole('group', { name: 'Feld 1' })).getByRole('button', {
          name: 'Feld schließen',
        }),
      );
      expect(screen.queryByRole('region', { name: 'Session Login' })).toBeNull();
      expect(screen.getByRole('region', { name: 'Session Suche' })).toBeVisible();
      expect(api.closeSession).not.toHaveBeenCalled();
      // The last field cannot be closed, only emptied by closing its session.
      expect(screen.queryByRole('button', { name: 'Feld schließen' })).toBeNull();
    });

    it('restores fields and their sessions after a restart', async () => {
      screenOf(2200, 1350);
      setup(two);
      await userEvent.click(await screen.findByTestId('session-s1'));
      await userEvent.click(screen.getByRole('button', { name: 'Feld hinzufügen' }));
      await userEvent.click(screen.getByTestId('session-s2'));
      cleanup();
      setup(two);
      expect(await screen.findByRole('region', { name: 'Session Login' })).toBeVisible();
      expect(screen.getByRole('region', { name: 'Session Suche' })).toBeVisible();
    });

    it('fits two fields on a laptop and then locks "add field", naming the reason only there', async () => {
      screenOf(1100, 820);
      setup(two);
      const add = await screen.findByRole('button', { name: 'Feld hinzufügen' });
      expect(add).not.toHaveAttribute('aria-disabled', 'true');
      expect(add).not.toHaveAccessibleDescription();
      await userEvent.click(add);
      expect(screen.getAllByRole('group', { name: /^Feld/ })).toHaveLength(2);

      // Still focusable, so keyboard and screen reader users learn why.
      expect(add).toHaveAttribute('aria-disabled', 'true');
      expect(add).toHaveAccessibleDescription(
        'Kein Platz für ein weiteres Feld: Jedes Terminal braucht mindestens 60 × 16 Zeichen.',
      );
      expect(screen.queryByText(/Kein Platz/)).not.toBeVisible();
      await userEvent.click(add);
      expect(screen.getAllByRole('group', { name: /^Feld/ })).toHaveLength(2);
    });

    it('reaches the controls of every field with the keyboard', async () => {
      screenOf(2200, 1350);
      setup(two);
      await userEvent.click(await screen.findByTestId('session-s1'));
      await userEvent.click(screen.getByRole('button', { name: 'Feld hinzufügen' }));
      await userEvent.click(screen.getByTestId('session-s2'));
      const reached = new Set<Element>();
      for (let i = 0; i < 40; i++) {
        await userEvent.tab();
        if (document.activeElement) reached.add(document.activeElement);
      }
      for (const n of [1, 2]) {
        const group = screen.getByRole('group', { name: `Feld ${n}` });
        for (const name of ['Abdocken', 'Feld schließen']) {
          expect(reached).toContain(within(group).getByRole('button', { name }));
        }
      }
    });

    it('ignores a damaged saved grid', async () => {
      localStorage.setItem('grid', '{"fields":5}');
      setup(two);
      expect(await screen.findByText(/Wähle links eine Session/)).toBeVisible();
    });
  });

  describe('own windows', () => {
    const login: StateView = { ...withProject, sessions: [{ ...session, description: 'Login' }] };

    it('undocks a session into its own window and docks it back', async () => {
      const { api, windows } = setup(login);
      await userEvent.click(await screen.findByTestId('session-s1'));
      await userEvent.click(screen.getByRole('button', { name: 'Abdocken' }));
      expect(api.windows.open).toHaveBeenCalledWith('s1', 'Login – shop');
      windows(['s1']);
      expect(screen.queryByRole('region', { name: /^Session/ })).toBeNull();
      expect(
        screen.getByText('„Login“ ist abgedockt und läuft in einem eigenen Fenster.'),
      ).toBeVisible();
      await userEvent.click(screen.getByRole('button', { name: 'Zurückholen' }));
      expect(api.windows.close).toHaveBeenCalledWith('s1');
      windows([]);
      expect(screen.getByRole('region', { name: 'Session Login' })).toBeVisible();
    });

    it('puts undock and close as symbols top right, the other actions below', async () => {
      setup(login);
      await userEvent.click(await screen.findByTestId('session-s1'));
      const undock = screen.getByRole('button', { name: 'Abdocken' });
      const close = screen.getByRole('button', { name: 'Session schließen' });
      expect(undock).toHaveTextContent('↗');
      expect(undock).toHaveAttribute('title', 'Abdocken');
      expect(close).toHaveTextContent('×');
      expect(close).toHaveAttribute('title', 'Session schließen');
      // Reading order: description, then the symbols, then the remaining actions.
      const order = [
        screen.getByRole('textbox', { name: 'Beschreibung' }),
        undock,
        close,
        screen.getByRole('button', { name: 'Umgebungsvariablen' }),
      ];
      for (let i = 1; i < order.length; i++) {
        expect(order[i - 1]!.compareDocumentPosition(order[i]!)).toBe(
          Node.DOCUMENT_POSITION_FOLLOWING,
        );
      }
    });

    it('brings the window of an undocked session to the front from the tree', async () => {
      const { api, windows } = setup(login);
      await screen.findByTestId('session-s1');
      windows(['s1']);
      await userEvent.click(screen.getByTestId('session-s1'));
      expect(api.windows.open).toHaveBeenCalledWith('s1', 'Login – shop');
    });

    it('shows only its session in its own window and closes once the session ends', async () => {
      const { api, push } = setup(login, 's1');
      expect(await screen.findByRole('region', { name: 'Session Login' })).toBeVisible();
      expect(screen.queryByRole('heading', { name: 'Projekte' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Feld hinzufügen' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Andocken' })).toHaveTextContent('↙');
      await userEvent.click(screen.getByRole('button', { name: 'Andocken' }));
      expect(api.windows.close).toHaveBeenCalledWith('s1');
      push(withProject);
      expect(api.windows.close).toHaveBeenCalledTimes(2);
    });

    it('leaves the saved grid and overview of the main view alone in its own window', async () => {
      const grid = JSON.stringify({ fields: ['s1', 's2'], focus: 1 });
      localStorage.setItem('grid', grid);
      localStorage.setItem('selectedProject', 'p1');
      const { push } = setup(
        {
          ...login,
          sessions: [...login.sessions, { ...session, id: 's2', branch: 'hangar/s2' }],
        },
        's1',
      );
      expect(await screen.findByRole('region', { name: 'Session Login' })).toBeVisible();
      push(login);
      expect(localStorage.getItem('grid')).toBe(grid);
      expect(localStorage.getItem('selectedProject')).toBe('p1');
    });
  });

  describe('on a server', () => {
    const ipc = (message: string) =>
      new Error(`Error invoking remote method 'bay:invoke': Error: ${message}`);
    const open = async () => {
      const ctx = setup(withProject, undefined, 'Heimserver');
      await userEvent.click(await screen.findByRole('button', { name: 'Projekt hinzufügen' }));
      const form = screen.getByRole('form', { name: 'Projekt hinzufügen' });
      const path = within(form).getByRole('textbox', { name: 'Pfad auf Heimserver' });
      expect(path).toHaveFocus();
      return { ...ctx, form, path };
    };

    it('asks for a path instead of opening a folder dialog, and checks it is not empty', async () => {
      const { api, form, path } = await open();
      await userEvent.type(path, '   ');
      await userEvent.click(within(form).getByRole('button', { name: 'Hinzufügen' }));
      expect(within(form).getByRole('alert')).toHaveTextContent(/^Pfad eingeben$/);
      expect(path).toHaveAttribute('aria-invalid', 'true');
      expect(path).toHaveAccessibleDescription('Pfad eingeben');
      expect(api.addProject).not.toHaveBeenCalled();
    });

    it.each([
      ['outside the allowed roots', '/etc', 'Folder outside the allowed roots (--root): /etc'],
      [
        'not a Git repository',
        '/home/test/projects/plain',
        'Kein Git-Repository: /home/test/projects/plain',
      ],
      ['not found', '/home/test/projects/nope', 'Folder not found: /home/test/projects/nope'],
    ])('shows what the server says for a path %s and keeps it', async (_case, value, message) => {
      const { api, form, path } = await open();
      vi.mocked(api.addProject).mockRejectedValueOnce(ipc(message));
      await userEvent.type(path, value);
      await userEvent.click(within(form).getByRole('button', { name: 'Hinzufügen' }));
      expect(api.addProject).toHaveBeenCalledWith(value);
      expect(within(form).getByRole('alert').textContent).toBe(message);
      expect(path).toHaveValue(value);
      expect(path).toHaveAttribute('aria-invalid', 'true');
      // Editing the path takes the old message away.
      await userEvent.type(path, '2');
      expect(within(form).queryByRole('alert')).toBeNull();
      expect(path).not.toHaveAttribute('aria-invalid');
    });

    it('adds with the Enter key and checks the path there too', async () => {
      const { api, form, path } = await open();
      await userEvent.type(path, '{Enter}');
      expect(within(form).getByRole('alert')).toHaveTextContent(/^Pfad eingeben$/);
      expect(api.addProject).not.toHaveBeenCalled();
      vi.mocked(api.addProject).mockResolvedValueOnce({ id: 'p2', name: 'demo', path: '/demo' });
      await userEvent.type(path, ' /demo {Enter}');
      expect(api.addProject).toHaveBeenCalledWith('/demo');
      expect(screen.queryByRole('form', { name: 'Projekt hinzufügen' })).toBeNull();
    });

    it('closes without adding on Cancel and on Escape', async () => {
      const { api, form } = await open();
      await userEvent.click(within(form).getByRole('button', { name: 'Abbrechen' }));
      expect(screen.queryByRole('form', { name: 'Projekt hinzufügen' })).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Projekt hinzufügen' }));
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('form', { name: 'Projekt hinzufügen' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Projekt hinzufügen' })).toHaveFocus();
      expect(api.addProject).not.toHaveBeenCalled();
    });

    it('sends a path once while the server has not answered, and keeps it unchanged', async () => {
      const { api, path } = await open();
      let answer: (p: Project) => void = () => {};
      vi.mocked(api.addProject).mockReturnValueOnce(new Promise((r) => (answer = r)));
      await userEvent.type(path, '/slow{Enter}');
      await userEvent.type(path, 'er{Enter}');
      expect(api.addProject).toHaveBeenCalledTimes(1);
      expect(path).toHaveValue('/slow');
      await act(async () => answer({ id: 'p2', name: 'slow', path: '/slow' }));
      expect(screen.queryByRole('form', { name: 'Projekt hinzufügen' })).toBeNull();
    });

    it('leaves a form opened again alone when an earlier one answers late', async () => {
      const { api, form, path } = await open();
      let answer: (p: Project) => void = () => {};
      vi.mocked(api.addProject).mockReturnValueOnce(new Promise((r) => (answer = r)));
      await userEvent.type(path, '/first{Enter}');
      await userEvent.click(within(form).getByRole('button', { name: 'Abbrechen' }));
      await userEvent.click(screen.getByRole('button', { name: 'Projekt hinzufügen' }));
      await userEvent.keyboard('/new');
      await act(async () => answer({ id: 'p2', name: 'first', path: '/first' }));
      expect(screen.getByRole('textbox', { name: 'Pfad auf Heimserver' })).toHaveValue('/new');
    });

    it('adds a project at a valid path', async () => {
      const { api, form, path } = await open();
      vi.mocked(api.addProject).mockResolvedValueOnce({ id: 'p2', name: 'demo', path: '/demo' });
      await userEvent.type(path, '/home/test/projects/demo');
      await userEvent.click(within(form).getByRole('button', { name: 'Hinzufügen' }));
      expect(api.addProject).toHaveBeenCalledWith('/home/test/projects/demo');
      expect(screen.queryByRole('form', { name: 'Projekt hinzufügen' })).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  describe('context menu of a session', () => {
    const withSession = { ...withProject, sessions: [{ ...session, description: 'Login' }] };
    const choose = async (
      label: string | RegExp,
      role: 'menuitem' | 'menuitemradio' = 'menuitem',
    ) => {
      fireEvent.contextMenu(await screen.findByTestId('session-s1'), { clientX: 5, clientY: 5 });
      await userEvent.click(screen.getByRole(role, { name: label }));
    };

    it('restarts, colors, opens in a window and closes after confirmation', async () => {
      const { api } = setup(withSession);
      await choose('Shell neu starten');
      expect(api.restart).toHaveBeenCalledWith('s1');
      await choose('Blau', 'menuitemradio');
      expect(api.update).toHaveBeenCalledWith('s1', { color: 'blue' });
      await choose('In eigenem Fenster öffnen');
      expect(api.windows.open).toHaveBeenCalledWith('s1', 'Login – shop');
      const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
      await choose('Session schließen…');
      expect(api.closeSession).not.toHaveBeenCalled();
      confirm.mockReturnValueOnce(true);
      await choose('Session schließen…');
      expect(api.closeSession).toHaveBeenCalledWith('s1');
      confirm.mockRestore();
    });

    it('docks a session that runs in its own window', async () => {
      const { api, windows } = setup(withSession);
      await screen.findByTestId('session-s1');
      windows(['s1']);
      await choose('Andocken');
      expect(api.windows.close).toHaveBeenCalledWith('s1');
    });

    it('copies the path of the session and says so', async () => {
      const writeText = vi.fn(async () => {});
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      setup(withSession);
      await choose('Pfad kopieren');
      expect(writeText).toHaveBeenCalledWith('/wt');
      expect(await screen.findByRole('status')).toHaveTextContent('In die Zwischenablage kopiert');
    });

    it('opens the session and moves the focus to its description, environment or job form', async () => {
      setup(withSession);
      await choose('Beschreibung ändern…');
      expect(screen.getByRole('textbox', { name: 'Beschreibung' })).toHaveFocus();
      await choose('Umgebungsvariablen…');
      expect(screen.getByRole('textbox', { name: /^Umgebungsvariablen \(/ })).toHaveFocus();
      await choose('Job planen…');
      const form = screen.getByRole('form', { name: 'Job planen' });
      expect(within(form).getByRole('textbox', { name: 'Befehl' })).toHaveFocus();
      // Asked again, the form stays open rather than toggling shut.
      await choose('Job planen…');
      expect(screen.getByRole('form', { name: 'Job planen' })).toBeVisible();
    });

    it('does not repeat a request when the session shows again', async () => {
      const two = { ...withSession, sessions: [...withSession.sessions, { ...session, id: 's2' }] };
      setup(two);
      await choose('Job planen…');
      await userEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
      await userEvent.click(screen.getByTestId('session-s2'));
      await userEvent.click(screen.getByTestId('session-s1'));
      expect(screen.getByRole('region', { name: 'Session Login' })).toBeVisible();
      expect(screen.queryByRole('form', { name: 'Job planen' })).toBeNull();
    });
  });
});
