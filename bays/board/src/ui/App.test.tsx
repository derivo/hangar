import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { BoardApi, ProjectRef } from './api';
import type { Task } from '../main/board';

const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id,
  projectId: 'p1',
  title: `Aufgabe ${id}`,
  description: '',
  status: 'open',
  createdBy: null,
  notes: [],
  createdAt: '2026-11-04T10:00:00.000Z',
  updatedAt: '2026-11-04T10:00:00.000Z',
  ...patch,
});
const PROJECTS: ProjectRef[] = [
  { id: 'p1', name: 'shop' },
  { id: 'p2', name: 'blog' },
];

beforeEach(() => localStorage.clear());

async function setup(tasks: Task[] = [], projects: ProjectRef[] | null = PROJECTS) {
  let push: (s: Task[]) => void = () => {};
  const api = {
    state: vi.fn(async () => tasks),
    projects: vi.fn(async () => projects),
    add: vi.fn(async (projectId: string, x: { title: string; description: string }) =>
      task('new', { projectId, ...x }),
    ),
    reopen: vi.fn(async (id: string) => task(id)),
    done: vi.fn(async (id: string) => task(id)),
    remove: vi.fn(async () => {}),
    onState: (l: (s: Task[]) => void) => ((push = l), () => {}),
  } satisfies BoardApi;
  render(<App api={api} />);
  await vi.waitFor(() => expect(api.projects).toHaveBeenCalled());
  if (projects?.length) {
    // The composer opens like a card at the end of the column Offen (ADR 0037).
    fireEvent.click(await screen.findByRole('button', { name: 'Aufgabe hinzufügen' }));
  }
  return { api, push: (s: Task[]) => act(() => push(s)) };
}

const form = () => screen.getByRole('form', { name: 'Neue Aufgabe' });
const column = (name: string) => screen.getByRole('region', { name });

describe('board UI', () => {
  it('shows the tasks of the chosen project in three columns and remembers the project', async () => {
    const { push } = await setup([
      task('a'),
      task('b', { status: 'doing', sessionId: 's1', sessionName: 'Login', createdBy: 'Suche' }),
      task('c', { status: 'done', notes: [{ at: 'x', text: 'grün', by: 'Login' }] }),
      task('d', { projectId: 'p2' }),
    ]);
    expect(await within(column('Offen')).findByText('Aufgabe a')).toBeTruthy();
    expect(within(column('In Arbeit')).getByText('in Arbeit bei Login')).toBeTruthy();
    expect(within(column('In Arbeit')).getByText('von Agent Suche')).toBeTruthy();
    expect(within(column('Erledigt')).getByText('grün')).toBeTruthy();
    expect(screen.queryByText('Aufgabe d')).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Projekt'), 'p2');
    expect(within(column('Offen')).getByText('Aufgabe d')).toBeTruthy();
    expect(within(column('In Arbeit')).getByText('Keine Aufgaben.')).toBeTruthy();
    expect(localStorage.getItem('project')).toBe('p2');
    push([task('e', { projectId: 'p2' })]);
    expect(within(column('Offen')).getByText('Aufgabe e')).toBeTruthy();
  });

  it('says when the agent bay or a project is missing', async () => {
    await setup([], null);
    expect(await screen.findByText(/Die Agent-Bay fehlt/)).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('follows new projects of the agent bay without a reload, one question at a time', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { api } = await setup([], []);
      await screen.findByText('Noch kein Projekt. Lege in der Agent-Bay ein Projekt an.');
      let answer: (p: ProjectRef[]) => void = () => {};
      api.projects.mockImplementation(() => new Promise((r) => (answer = r)));
      act(() => vi.advanceTimersByTime(3000));
      act(() => vi.advanceTimersByTime(3000));
      expect(api.projects).toHaveBeenCalledTimes(2);
      await act(async () => answer(PROJECTS));
      expect(await screen.findByRole('button', { name: 'Aufgabe hinzufügen' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says when there is no project yet', async () => {
    await setup([], []);
    expect(
      await screen.findByText('Noch kein Projekt. Lege in der Agent-Bay ein Projekt an.'),
    ).toBeTruthy();
  });

  // Form matrix: one field wrong at a time.
  it('says the title is missing, also on Enter', async () => {
    const { api } = await setup();
    const user = userEvent.setup();
    await user.type(await within(form()).findByLabelText('Beschreibung'), 'Details');
    await user.click(within(form()).getByRole('button', { name: 'Aufgabe anlegen' }));
    expect(within(form()).getByRole('alert').textContent).toBe('Titel fehlt');
    await user.type(within(form()).getByLabelText('Titel'), '   {Enter}');
    expect(within(form()).getByRole('alert').textContent).toBe('Titel fehlt');
    expect(api.add).not.toHaveBeenCalled();
  });

  it('shows the error of the bay for a too long description', async () => {
    const { api } = await setup();
    api.add.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'bay:invoke': Error: Beschreibung zu lang (höchstens 4000 Zeichen)",
      ),
    );
    const user = userEvent.setup();
    await user.type(await within(form()).findByLabelText('Titel'), 'A');
    await user.type(within(form()).getByLabelText('Beschreibung'), 'lang');
    await user.click(within(form()).getByRole('button', { name: 'Aufgabe anlegen' }));
    expect(within(form()).getByRole('alert').textContent).toBe(
      'Beschreibung zu lang (höchstens 4000 Zeichen)',
    );
    expect((within(form()).getByLabelText('Titel') as HTMLInputElement).value).toBe('A');
  });

  it('opens the composer at the end of the column Offen and closes it with Esc or Abbrechen', async () => {
    await setup([task('a')]);
    const open = column('Offen');
    expect(open.lastElementChild).toBe(form());
    expect(document.activeElement).toBe(within(form()).getByLabelText('Titel'));
    expect(within(form()).getByRole('button', { name: 'Aufgabe anlegen' }).className).toBe(
      'button button-primary',
    );
    const user = userEvent.setup();
    await user.type(within(form()).getByLabelText('Titel'), 'Halb{Escape}');
    expect(screen.queryByRole('form', { name: 'Neue Aufgabe' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Aufgabe hinzufügen' }));
    await user.click(screen.getByRole('button', { name: 'Aufgabe hinzufügen' }));
    // A closed composer forgets what was typed.
    expect((within(form()).getByLabelText('Titel') as HTMLInputElement).value).toBe('');
    await user.click(within(form()).getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('form', { name: 'Neue Aufgabe' })).toBeNull();
  });

  it('keeps a new draft when the answer for a cancelled one comes late', async () => {
    const { api } = await setup();
    let answer: () => void = () => {};
    api.add.mockImplementationOnce(() => new Promise((r) => (answer = () => r(task('x')))));
    const user = userEvent.setup();
    await user.type(within(form()).getByLabelText('Titel'), 'Alt{Enter}');
    await user.click(within(form()).getByRole('button', { name: 'Abbrechen' }));
    await user.click(screen.getByRole('button', { name: 'Aufgabe hinzufügen' }));
    await user.type(within(form()).getByLabelText('Titel'), 'Neu');
    await act(async () => answer());
    expect((within(form()).getByLabelText('Titel') as HTMLInputElement).value).toBe('Neu');
  });

  it('limits the title to 200 characters', async () => {
    await setup();
    expect((await within(form()).findByLabelText('Titel')).getAttribute('maxlength')).toBe('200');
  });

  it('adds a task to the chosen project with Enter and clears the form', async () => {
    const { api } = await setup();
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('Projekt'), 'p2');
    await user.type(within(form()).getByLabelText('Beschreibung'), 'mit Tests');
    await user.type(within(form()).getByLabelText('Titel'), ' Feed bauen {Enter}');
    expect(api.add).toHaveBeenCalledWith('p2', { title: 'Feed bauen', description: 'mit Tests' });
    expect((within(form()).getByLabelText('Titel') as HTMLInputElement).value).toBe('');
    expect((within(form()).getByLabelText('Beschreibung') as HTMLTextAreaElement).value).toBe('');
    expect(within(form()).getByRole('alert').textContent).toBe('');
    // Stays open for the next task.
    expect(document.activeElement).toBe(within(form()).getByLabelText('Titel'));
  });

  it('finishes, releases, reopens and deletes (after confirming)', async () => {
    const { api } = await setup([
      task('a'),
      task('b', { status: 'doing', sessionId: 's1', sessionName: 'Login' }),
      task('c', { status: 'done' }),
    ]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Aufgabe a erledigt' }));
    expect(api.done).toHaveBeenCalledWith('a');
    await user.click(screen.getByRole('button', { name: 'Aufgabe b zurück auf Offen' }));
    expect(api.reopen).toHaveBeenCalledWith('b');
    await user.click(screen.getByRole('button', { name: 'Aufgabe c wieder öffnen' }));
    expect(api.reopen).toHaveBeenCalledWith('c');
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    await user.click(screen.getByRole('button', { name: 'Aufgabe c löschen' }));
    expect(api.remove).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Aufgabe c löschen' }));
    expect(confirm).toHaveBeenLastCalledWith('Aufgabe „Aufgabe c“ löschen?');
    expect(api.remove).toHaveBeenCalledWith('c');
  });
  it('acts once for a double click on every button (ADR 0028)', async () => {
    const { api } = await setup([task('a'), task('c', { status: 'done' })]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.type(within(form()).getByLabelText('Titel'), 'Neu');
    const twice = (name: string) => {
      const button = screen.getByRole('button', { name });
      // The second click of a double click, after the first answer already came.
      fireEvent.click(button, { detail: 1 });
      fireEvent.click(button, { detail: 2 });
    };
    twice('Aufgabe anlegen');
    twice('Aufgabe a erledigt');
    twice('Aufgabe c wieder öffnen');
    twice('Aufgabe c löschen');
    expect(api.add).toHaveBeenCalledTimes(1);
    expect(api.done).toHaveBeenCalledTimes(1);
    expect(api.reopen).toHaveBeenCalledTimes(1);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(api.remove).toHaveBeenCalledTimes(1);
  });
  it('survives failed calls: asks again for projects and says why an action failed', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { api } = await setup([task('a')]);
      const lost = () => Promise.reject(new Error('Connection closed'));
      // Plain functions: vi.fn handles the promises it returns itself.
      Object.assign(api, { projects: lost, done: lost });
      act(() => vi.advanceTimersByTime(3000));
      await act(() => new Promise((r) => setTimeout(r, 10)));
      let asked = 0;
      Object.assign(api, { projects: async () => (asked++, PROJECTS) });
      act(() => vi.advanceTimersByTime(3000));
      await act(() => new Promise((r) => setTimeout(r, 10)));
      expect(asked).toBe(1);
      await userEvent.click(screen.getByRole('button', { name: 'Aufgabe a erledigt' }));
      expect(await screen.findByText('Connection closed')).toBeTruthy();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      process.off('unhandledRejection', unhandled);
    }
  });
});
