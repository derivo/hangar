import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Jobs } from './Jobs';
import type { JobsView } from '../shared';

const base = {
  bayId: 'dev.hangar.agents',
  createdAt: 0,
  since: 0,
  paused: false,
  running: false,
  available: true,
};

const view: JobsView = {
  bays: [{ id: 'dev.hangar.agents', name: 'Agents' }],
  jobs: [
    {
      ...base,
      id: 'j1',
      label: 'pnpm test',
      schedule: '0 2 * * *',
      nextRun: Date.parse('2026-10-30T02:00:00Z'),
      lastRun: {
        at: Date.parse('2026-10-29T02:00:00Z'),
        durationMs: 4200,
        ok: true,
        output: 'Exit-Code 0: 5 passed',
      },
    },
    {
      ...base,
      id: 'j2',
      label: 'pnpm lint',
      schedule: '* * * * *',
      paused: true,
      lastRun: { at: 0, durationMs: 100, ok: false, output: 'Exit-Code 1' },
    },
    {
      ...base,
      id: 'j3',
      label: 'gone',
      schedule: '* * * * *',
      bayId: 'dev.hangar.old',
      available: false,
    },
    { ...base, id: 'j4', label: 'busy', schedule: '* * * * *', running: true },
  ],
  servers: [],
};

function setup(v: JobsView = view) {
  let notify = () => {};
  const api = {
    getJobs: vi.fn(async () => v),
    setJobPaused: vi.fn(async () => {}),
    runJob: vi.fn(async () => {}),
    removeJob: vi.fn(async () => {}),
    onJobs: vi.fn((l: () => void) => {
      notify = l;
      return () => {};
    }),
  };
  render(<Jobs api={api} />);
  return { api, notify: () => notify() };
}

const row = (name: string) => screen.getByRole('row', { name: new RegExp(name) });

describe('Jobs', () => {
  it('lists jobs with schedule, runs, result and state', async () => {
    setup();
    const table = await screen.findByRole('table', { name: 'Jobs' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Job', 'Zeitplan', 'Nächster Lauf', 'Letzter Lauf', 'Ergebnis']);
    expect(row('pnpm test')).toHaveTextContent('Agents');
    expect(row('pnpm test')).toHaveTextContent('0 2 * * *');
    expect(row('pnpm test')).toHaveTextContent('erfolgreich (4 s): Exit-Code 0: 5 passed');
    expect(row('pnpm lint')).toHaveTextContent('pausiert');
    expect(row('pnpm lint')).toHaveTextContent('fehlgeschlagen (0 s): Exit-Code 1');
    expect(row('gone')).toHaveTextContent('dev.hangar.old');
    expect(row('gone')).toHaveTextContent('Bay nicht geladen');
    expect(row('gone')).toHaveTextContent('noch nicht gelaufen');
    expect(row('busy')).toHaveTextContent('läuft');
    expect(within(row('busy')).getByRole('button', { name: 'Jetzt ausführen' })).toBeDisabled();
    expect(within(row('gone')).getByRole('button', { name: 'Jetzt ausführen' })).toBeDisabled();
  });

  it('pauses, resumes, runs and deletes jobs, then reloads', async () => {
    const { api } = setup();
    await screen.findByRole('table', { name: 'Jobs' });
    await userEvent.click(within(row('pnpm test')).getByRole('button', { name: 'Pausieren' }));
    expect(api.setJobPaused).toHaveBeenCalledWith('j1', true);
    await userEvent.click(within(row('pnpm lint')).getByRole('button', { name: 'Fortsetzen' }));
    expect(api.setJobPaused).toHaveBeenCalledWith('j2', false);
    await userEvent.click(
      within(row('pnpm test')).getByRole('button', { name: 'Jetzt ausführen' }),
    );
    expect(api.runJob).toHaveBeenCalledWith('j1');
    await userEvent.click(within(row('pnpm test')).getByRole('button', { name: 'Löschen' }));
    expect(api.removeJob).toHaveBeenCalledWith('j1');
    expect(api.getJobs).toHaveBeenCalledTimes(5);
  });

  it('shows an error of an action', async () => {
    const { api } = setup();
    api.runJob.mockRejectedValueOnce(
      new Error("Error invoking remote method 'shell:job.run': Error: Job is already running"),
    );
    await screen.findByRole('table', { name: 'Jobs' });
    await userEvent.click(
      within(row('pnpm test')).getByRole('button', { name: 'Jetzt ausführen' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Job is already running');
  });

  it('reloads when jobs change and explains an empty list', async () => {
    const { api, notify } = setup({ bays: [], jobs: [], servers: [] });
    expect(await screen.findByText(/Noch keine Jobs/)).toBeVisible();
    notify();
    expect(api.getJobs).toHaveBeenCalledTimes(2);
  });

  it('groups the jobs of connected servers by server and acts on them there (phase 11d)', async () => {
    const { api } = setup({
      ...view,
      servers: [
        {
          id: 'srv1',
          name: 'Testserver',
          jobs: [{ ...base, id: 's1', label: 'nightly backup', schedule: '0 3 * * *' }],
        },
        { id: 'srv2', name: 'Kaputt', jobs: [], error: 'Not connected: srv2' },
        { id: 'srv3', name: 'Leer', jobs: [] },
      ],
    });
    await screen.findByRole('table', { name: 'Auf diesem Rechner' });
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Auf diesem Rechner',
      'Auf dem Server „Testserver“',
      'Auf dem Server „Kaputt“',
      'Auf dem Server „Leer“',
    ]);
    const remote = screen.getByRole('table', { name: 'Auf dem Server „Testserver“' });
    const backup = within(remote).getByRole('row', { name: /nightly backup/ });
    expect(backup).toHaveTextContent('Agents');
    await userEvent.click(within(backup).getByRole('button', { name: 'Pausieren' }));
    expect(api.setJobPaused).toHaveBeenCalledWith('s1', true, 'srv1');
    await userEvent.click(within(backup).getByRole('button', { name: 'Jetzt ausführen' }));
    expect(api.runJob).toHaveBeenCalledWith('s1', 'srv1');
    await userEvent.click(within(backup).getByRole('button', { name: 'Löschen' }));
    expect(api.removeJob).toHaveBeenCalledWith('s1', 'srv1');
    expect(screen.getByText('Not connected: srv2')).toBeVisible();
    expect(screen.getByText('Keine Jobs.')).toBeVisible();
  });

  it('keeps the newest list when an older load answers last (Codex 11d)', async () => {
    let first: (v: JobsView) => void = () => {};
    const { api, notify } = setup();
    api.getJobs.mockReset();
    api.getJobs
      .mockImplementationOnce(() => new Promise((r) => (first = r)))
      .mockImplementationOnce(async () => ({ bays: [], jobs: [], servers: [] }));
    notify();
    notify();
    expect(await screen.findByText(/Noch keine Jobs/)).toBeVisible();
    first(view);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText(/Noch keine Jobs/)).toBeVisible();
  });

  it('announces a server whose jobs could not be listed (Codex 11d)', async () => {
    setup({ ...view, servers: [{ id: 'srv2', name: 'Kaputt', jobs: [], error: 'kaputt' }] });
    expect(await screen.findByRole('alert')).toHaveTextContent('kaputt');
  });

  it.each([
    ['Pausieren', 'setJobPaused'],
    ['Jetzt ausführen', 'runJob'],
    ['Löschen', 'removeJob'],
  ] as const)('sends %s once while its answer is pending', async (name, call) => {
    const { api } = setup();
    let finish!: () => void;
    api[call].mockImplementation(() => new Promise<void>((r) => (finish = r)));
    const button = within(await screen.findByRole('row', { name: /pnpm test/ })).getByRole(
      'button',
      { name },
    );
    await userEvent.dblClick(button);
    await userEvent.click(button);
    expect(api[call]).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await userEvent.click(button);
    expect(api[call]).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('runs a job once for a double click, also when it answers at once', async () => {
    const { api } = setup();
    const row = await screen.findByRole('row', { name: /pnpm test/ });
    await userEvent.dblClick(within(row).getByRole('button', { name: 'Jetzt ausführen' }));
    expect(api.runJob).toHaveBeenCalledTimes(1);
  });

  it('deletes a job once for a double click, also when it answers at once', async () => {
    const { api } = setup();
    const row = await screen.findByRole('row', { name: /pnpm test/ });
    await userEvent.dblClick(within(row).getByRole('button', { name: 'Löschen' }));
    expect(api.removeJob).toHaveBeenCalledTimes(1);
  });

  it('deletes a job while its run is still answering', async () => {
    const { api } = setup();
    api.runJob.mockImplementation(() => new Promise<void>(() => {}));
    const row = await screen.findByRole('row', { name: /pnpm test/ });
    await userEvent.click(within(row).getByRole('button', { name: 'Jetzt ausführen' }));
    await userEvent.click(within(row).getByRole('button', { name: 'Löschen' }));
    expect(api.removeJob).toHaveBeenCalledWith('j1');
  });
});
