import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectPane } from './ProjectPane';
import { setLocale } from './messages';
import type { ProjectDetails, SessionView } from '../main/types';

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

const project = { id: 'p1', name: 'shop', path: '/code/shop', env: { DB: 'dev' } };
const details: ProjectDetails = {
  worktrees: [
    { sessionId: 's1', changes: 2, ahead: 3 },
    { sessionId: 's2', changes: null, ahead: 0 },
  ],
  orphans: [
    { branch: 'hangar/old', ahead: 1 },
    { branch: 'hangar/empty', ahead: 0 },
  ],
};

function renderPane(
  sessions?: SessionView[],
  over: { onMoveDown?: () => void; onMoveSession?: (id: string, index: number) => void } = {},
) {
  const api = {
    projectDetails: vi.fn(async () => details),
    deleteBranch: vi.fn(async () => {}),
    setProjectEnv: vi.fn(async () => {}),
    setProjectShared: vi.fn(async () => {}),
    closeSession: vi.fn(async () => ({ worktreeRemoved: true })),
    secrets: vi.fn(async () => null),
  };
  const props = {
    project,
    sessions: sessions ?? [
      session({ id: 's1', description: 'Login', status: 'working' }),
      session({ id: 's2', branch: 'hangar/s2', portBase: 40_010 }),
    ],
    api,
    run: vi.fn(async (action: () => Promise<unknown>) => {
      await action();
    }),
    onOpenSession: vi.fn(),
    onCreateSession: vi.fn(),
    onRemoveProject: vi.fn(),
    onMoveUp: vi.fn(),
    ...over,
  };
  render(<ProjectPane {...props} />);
  return props;
}

afterEach(() => vi.restoreAllMocks());

describe('ProjectPane', () => {
  it('moves the project up or down without dragging (WCAG 2.5.7)', async () => {
    const props = renderPane(undefined, { onMoveDown: undefined });
    await userEvent.click(screen.getByRole('button', { name: 'Projekt nach oben' }));
    expect(props.onMoveUp).toHaveBeenCalled();
    // The last project cannot move further down.
    expect(screen.getByRole('button', { name: 'Projekt nach unten' })).toBeDisabled();
  });

  it('moves a session up or down without dragging (WCAG 2.5.7)', async () => {
    const onMoveSession = vi.fn();
    renderPane(undefined, { onMoveSession });
    expect(screen.getByRole('button', { name: 'Session Login nach oben' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Session hangar/s2 nach unten' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Session Login nach unten' }));
    expect(onMoveSession).toHaveBeenLastCalledWith('s1', 1);
    await userEvent.click(screen.getByRole('button', { name: 'Session hangar/s2 nach oben' }));
    expect(onMoveSession).toHaveBeenLastCalledWith('s2', 0);
  });

  it('shares the project with the workspaces, off by default (ADR 0030)', async () => {
    const { api } = renderPane();
    const box = screen.getByRole('checkbox', { name: 'In Workspaces teilen' });
    expect(box).not.toBeChecked();
    expect(box).toHaveAccessibleDescription(
      'Andere Instanzen deiner Workspaces sehen die Sessions dieses Projekts mit Branch, Beschreibung und Status.',
    );
    await userEvent.click(box);
    expect(api.setProjectShared).toHaveBeenCalledWith('p1', true);
  });

  it('lists the sessions with status, branch, ports and git state of their worktrees', async () => {
    renderPane();
    expect(screen.getByRole('heading', { level: 1, name: 'shop' })).toBeVisible();
    expect(screen.getByText('/code/shop')).toBeVisible();
    const table = screen.getByRole('table', { name: 'Sessions' });
    const login = within(table).getByRole('row', { name: /Login/ });
    expect(within(login).getByRole('img', { name: 'arbeitet' })).toBeVisible();
    expect(login).toHaveTextContent('hangar/s1');
    expect(login).toHaveTextContent('40000–40099');
    expect(await within(login).findByText('2 Dateien')).toBeVisible();
    expect(within(login).getByText('3')).toBeVisible();
    const second = within(table).getByRole('row', { name: /hangar\/s2/ });
    expect(within(second).getByText('unbekannt')).toBeVisible();
    expect(within(second).getByText('keine')).toBeVisible();
  });

  it('names a session in the project folder by its short id and shows the place', async () => {
    const props = renderPane([session({ id: 'abcdef1234', branch: '', place: 'project' })]);
    const row = within(screen.getByRole('table', { name: 'Sessions' })).getByRole('row', {
      name: /abcdef12/,
    });
    await userEvent.click(within(row).getByRole('button', { name: 'abcdef12' }));
    expect(props.onOpenSession).toHaveBeenCalledWith('abcdef1234');
    expect(within(row).getByText('Projektordner')).toBeVisible();
  });

  it('opens, creates and closes sessions; removes the project', async () => {
    const props = renderPane();
    await userEvent.click(screen.getByRole('button', { name: 'Login' }));
    expect(props.onOpenSession).toHaveBeenCalledWith('s1');
    await userEvent.click(screen.getByRole('button', { name: 'Neue Session' }));
    expect(props.onCreateSession).toHaveBeenCalled();
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const close = screen.getByRole('button', { name: 'Session Login schließen' });
    await userEvent.click(close);
    expect(props.api.closeSession).not.toHaveBeenCalled();
    await userEvent.click(close);
    expect(props.api.closeSession).toHaveBeenCalledWith('s1');
    await userEvent.click(screen.getByRole('button', { name: 'Projekt entfernen' }));
    expect(props.onRemoveProject).toHaveBeenCalled();
  });

  it('deletes an orphaned branch after confirmation and warns about lost commits', async () => {
    const props = renderPane();
    const list = await screen.findByRole('list', { name: 'Verwaiste Branches' });
    expect(list).toHaveTextContent('hangar/old');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.click(within(list).getByRole('button', { name: 'Branch hangar/old löschen' }));
    expect(confirm).toHaveBeenLastCalledWith(
      'Branch hangar/old löschen? 1 Commit, den der Haupt-Checkout nicht hat, geht verloren.',
    );
    expect(props.api.deleteBranch).toHaveBeenCalledWith('p1', 'hangar/old');
    expect(props.api.projectDetails).toHaveBeenCalledTimes(2);
    await userEvent.click(
      within(list).getByRole('button', { name: 'Branch hangar/empty löschen' }),
    );
    expect(confirm).toHaveBeenLastCalledWith('Branch hangar/empty löschen?');
  });

  it('says when there are no sessions and no orphaned branches', async () => {
    const api = {
      projectDetails: vi.fn(async () => ({ worktrees: [], orphans: [] })),
      deleteBranch: vi.fn(),
      setProjectEnv: vi.fn(),
      setProjectShared: vi.fn(),
      closeSession: vi.fn(),
      secrets: vi.fn(async () => []),
    };
    render(
      <ProjectPane
        project={{ id: 'p1', name: 'shop', path: '/code/shop' }}
        sessions={[]}
        api={api}
        run={async (a) => void (await a())}
        onOpenSession={vi.fn()}
        onCreateSession={vi.fn()}
        onRemoveProject={vi.fn()}
      />,
    );
    expect(screen.getByText('Noch keine Session.')).toBeVisible();
    expect(await screen.findByText('Keine verwaisten Branches.')).toBeVisible();
    expect(
      screen.getByRole('textbox', { name: 'Umgebungsvariablen für neue Sessions' }),
    ).toHaveValue('');
  });

  it('saves the env for new sessions, line by line', async () => {
    const props = renderPane();
    const field = screen.getByRole('textbox', { name: 'Umgebungsvariablen für neue Sessions' });
    expect(field).toHaveValue('DB=dev');
    await userEvent.clear(field);
    await userEvent.type(field, 'DB=test{enter}PORT=1');
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(props.api.setProjectEnv).toHaveBeenCalledWith('p1', { DB: 'test', PORT: '1' });
  });

  it('says how to get passwords when the secrets bay is missing (ADR 0021)', async () => {
    renderPane();
    const field = screen.getByRole('textbox', { name: 'Umgebungsvariablen für neue Sessions' });
    await vi.waitFor(() =>
      expect(
        field
          .getAttribute('aria-describedby')!
          .split(' ')
          .map((id) => document.getElementById(id)!.textContent),
      ).toContain('Passwörter: Bay „Passwörter“ in der Leiste hinzufügen, dann KEY=@secret:NAME.'),
    );
  });

  it('refreshes the git state on request', async () => {
    const props = renderPane();
    await screen.findByText('2 Dateien');
    await userEvent.click(screen.getByRole('button', { name: 'Aktualisieren' }));
    expect(props.api.projectDetails).toHaveBeenCalledTimes(2);
  });

  it('creates one session for a double click on Neue Session', async () => {
    const props = renderPane();
    await userEvent.dblClick(screen.getByRole('button', { name: 'Neue Session' }));
    expect(props.onCreateSession).toHaveBeenCalledTimes(1);
  });

  it('keeps the newest git state when an earlier refresh answers last', async () => {
    const props = renderPane();
    await screen.findByText('2 Dateien');
    const answers: ((d: ProjectDetails) => void)[] = [];
    props.api.projectDetails.mockImplementation(
      () => new Promise<ProjectDetails>((r) => answers.push(r)),
    );
    const refresh = screen.getByRole('button', { name: 'Aktualisieren' });
    await userEvent.click(refresh);
    await userEvent.click(refresh);
    const newer = { ...details, worktrees: [{ sessionId: 's1', changes: 7, ahead: 0 }] };
    await act(async () => answers[1]!(newer));
    await act(async () => answers[0]!(details));
    expect(screen.getByText('7 Dateien')).toBeInTheDocument();
    expect(screen.queryByText('2 Dateien')).toBeNull();
  });

  it('ignores git state that fails after the overview was left (project just removed)', async () => {
    let fail!: (e: Error) => void;
    const errors: unknown[] = [];
    const { unmount } = render(
      <ProjectPane
        project={project}
        sessions={[]}
        api={{
          projectDetails: vi.fn(() => new Promise<ProjectDetails>((_, reject) => (fail = reject))),
          deleteBranch: vi.fn(),
          setProjectEnv: vi.fn(),
          setProjectShared: vi.fn(),
          closeSession: vi.fn(),
          secrets: vi.fn(async () => []),
        }}
        run={async (action) => {
          try {
            await action();
          } catch (e) {
            errors.push(e);
          }
        }}
        onOpenSession={vi.fn()}
        onCreateSession={vi.fn()}
        onRemoveProject={vi.fn()}
      />,
    );
    unmount();
    fail(new Error('Unbekanntes Projekt: p1'));
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toEqual([]);
  });

  it('speaks the app language', async () => {
    setLocale('en');
    try {
      renderPane();
      expect(screen.getByRole('table', { name: 'Sessions' })).toBeVisible();
      expect(await screen.findByText('2 files')).toBeVisible();
      expect(screen.getByRole('list', { name: 'Orphaned branches' })).toBeVisible();
      expect(screen.getByRole('textbox', { name: 'Env vars for new sessions' })).toBeVisible();
    } finally {
      setLocale('de');
    }
  });
});
