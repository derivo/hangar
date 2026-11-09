import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionPane } from './SessionPane';
import type { SessionView } from '../main/types';

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
  description: 'Alt',
  status: 'working',
  env: { FOO: 'bar' },
  portBase: 40_000,
  statusbar: [],
  createdAt: '',
  running: true,
};

function setup(over: Partial<SessionView> = {}) {
  const api = {
    update: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    closeSession: vi.fn(async () => ({ worktreeRemoved: true })),
    addJob: vi.fn(async () => {}),
    secrets: vi.fn(async () => [{ name: 'GITHUB_TOKEN', description: 'CI', updatedAt: 'x' }]),
  };
  const terminals = { attach: vi.fn(), fit: vi.fn(), focus: vi.fn(), setCopyOnSelect: vi.fn() };
  const run = vi.fn(async (action: () => Promise<unknown>) => {
    await action();
  });
  render(
    <SessionPane
      session={{ ...session, ...over }}
      projectName="shop"
      active
      api={api}
      terminals={terminals}
      run={run}
    />,
  );
  return { api, terminals, run };
}

describe('SessionPane', () => {
  it('attaches the session terminal and shows the status', () => {
    const { terminals } = setup();
    expect(terminals.attach).toHaveBeenCalledWith('s1', screen.getByTestId('terminal'));
    expect(terminals.focus).toHaveBeenCalledWith('s1');
    expect(screen.getAllByText('arbeitet')[0]).toBeVisible();
  });

  it('shows a handover from another session above the terminal (ADR 0031)', () => {
    setup({
      handover: {
        origin: 'local',
        from: 'Login bauen',
        task: 'Tests schreiben',
        branch: 'hangar/1a2b',
        context: 'Formular steht.',
        at: '2026-11-02T10:00:00.000Z',
      },
    });
    const handover = screen.getByRole('region', { name: 'Übergabe von Login bauen' });
    expect(handover).toHaveTextContent('AuftragTests schreiben');
    expect(handover).toHaveTextContent('Branchhangar/1a2b');
    expect(handover).toHaveTextContent('KontextFormular steht.');
    expect(handover).not.toHaveTextContent('anderen Instanz');
  });

  it('marks a handover from another instance as text to check', () => {
    setup({
      handover: {
        origin: 'remote',
        from: 'Anna (team)',
        task: 'Review',
        branch: 'feature/login',
        remote: 'git@github.com:anna/shop.git',
        at: '2026-11-02T10:00:00.000Z',
      },
    });
    const handover = screen.getByRole('region', { name: 'Übergabe von Anna (team)' });
    expect(handover).toHaveTextContent('Branchfeature/login (git@github.com:anna/shop.git)');
    expect(handover).toHaveTextContent(
      'Von einer anderen Instanz: nur Text. Prüfe Branch und Remote, bevor du etwas holst.',
    );
    expect(handover).not.toHaveTextContent('Kontext');
  });

  it('shows a Git remote without a branch', () => {
    setup({
      handover: {
        origin: 'remote',
        from: 'Anna (team)',
        task: 'Review',
        remote: 'https://example.invalid/repo.git',
        at: '2026-11-02T10:00:00.000Z',
      },
    });
    const handover = screen.getByRole('region', { name: 'Übergabe von Anna (team)' });
    expect(handover).toHaveTextContent('Remotehttps://example.invalid/repo.git');
    expect(within(handover).queryByText('Branch')).not.toBeInTheDocument();
  });

  it('shows no handover for an ordinary session', () => {
    setup();
    expect(screen.queryByRole('region', { name: /^Übergabe/ })).not.toBeInTheDocument();
  });

  it('shows project, branch and port block as telemetry', () => {
    setup();
    const telemetry = screen.getByRole('list', { name: 'Session-Daten' });
    expect(telemetry).toHaveTextContent('Projektshop');
    expect(telemetry).toHaveTextContent('Branchhangar/s1');
    expect(telemetry).toHaveTextContent('Ports40000–40099');
  });

  it('names a session in the project folder by its short id until it is described', () => {
    setup({ id: 'abcdef1234', branch: '', place: 'project', description: '' });
    expect(screen.getByRole('region', { name: 'Session abcdef12' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Beschreibung' })).toHaveAttribute(
      'placeholder',
      'abcdef12',
    );
    expect(screen.getByRole('list', { name: 'Session-Daten' })).toHaveTextContent(
      'BranchProjektordner',
    );
  });

  it('saves an edited description on Enter, but not when unchanged', async () => {
    const { api } = setup();
    const input = screen.getByRole('textbox', { name: 'Beschreibung' });
    await userEvent.click(input);
    await userEvent.tab();
    expect(api.update).not.toHaveBeenCalled();
    await userEvent.clear(input);
    await userEvent.type(input, 'Neu{Enter}');
    expect(api.update).toHaveBeenCalledWith('s1', { description: 'Neu' });
  });

  it('picks a tab color from the list and removes it again', async () => {
    const { api } = setup({ color: 'blue' });
    const select = screen.getByRole('combobox', { name: 'Farbe' });
    expect(select).toHaveValue('blue');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Keine',
      'Rot',
      'Orange',
      'Gelb',
      'Grün',
      'Türkis',
      'Blau',
      'Violett',
      'Pink',
    ]);
    expect(screen.getByRole('region').style.getPropertyValue('--tab-color')).toBe(
      'var(--hangar-color-tab-blue)',
    );
    await userEvent.selectOptions(select, 'Violett');
    expect(api.update).toHaveBeenCalledWith('s1', { color: 'violet' });
    await userEvent.selectOptions(select, 'Keine');
    expect(api.update).toHaveBeenCalledWith('s1', { color: null });
  });

  it('switches copy on select for this session in the header (ADR 0023)', async () => {
    const { api, terminals } = setup({ copyOnSelect: false });
    const toggle = screen.getByRole('checkbox', { name: 'Markieren kopiert' });
    expect(toggle).not.toBeChecked();
    expect(terminals.setCopyOnSelect).toHaveBeenLastCalledWith('s1', false);
    await userEvent.click(toggle);
    expect(api.update).toHaveBeenCalledWith('s1', { copyOnSelect: true });
  });

  it('copies on select when a session from before the setting has no value', () => {
    const { terminals } = setup();
    expect(screen.getByRole('checkbox', { name: 'Markieren kopiert' })).toBeChecked();
    expect(terminals.setCopyOnSelect).toHaveBeenLastCalledWith('s1', true);
  });

  it('has no tab color by default', () => {
    setup();
    expect(screen.getByRole('combobox', { name: 'Farbe' })).toHaveValue('');
    expect(screen.getByRole('region').style.getPropertyValue('--tab-color')).toBe('');
  });

  it('edits environment variables and restarts the shell', async () => {
    const { api } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Umgebungsvariablen' }));
    const text = screen.getByRole('textbox', { name: /Umgebungsvariablen/ });
    expect(text).toHaveValue('FOO=bar');
    await userEvent.type(text, '\nAPI=1');
    await userEvent.click(screen.getByRole('button', { name: 'Speichern und Shell neu starten' }));
    expect(api.update).toHaveBeenCalledWith('s1', { env: { FOO: 'bar', API: '1' } });
    expect(screen.queryByRole('textbox', { name: /Umgebungsvariablen/ })).toBeNull();
  });

  it('names the passwords a variable can refer to (ADR 0021)', async () => {
    const { api } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Umgebungsvariablen' }));
    const text = screen.getByRole('textbox', { name: /Umgebungsvariablen/ });
    await vi.waitFor(() =>
      expect(text).toHaveAccessibleDescription(
        'Aus Passwörtern: KEY=@secret:NAME. Gespeichert: GITHUB_TOKEN',
      ),
    );
    await userEvent.type(text, '\nGH=@secret:GITHUB_TOKEN');
    await userEvent.click(screen.getByRole('button', { name: 'Speichern und Shell neu starten' }));
    expect(api.update).toHaveBeenCalledWith('s1', {
      env: { FOO: 'bar', GH: { secret: 'GITHUB_TOKEN' } },
    });
  });

  it('cancels the environment editor', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Umgebungsvariablen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('textbox', { name: /Umgebungsvariablen/ })).toBeNull();
  });

  it('closes the session only after confirmation', async () => {
    const { api } = setup();
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole('button', { name: 'Session schließen' }));
    expect(api.closeSession).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Session schließen' }));
    expect(api.closeSession).toHaveBeenCalledWith('s1');
    confirm.mockRestore();
  });

  it('offers a restart when the shell has ended', async () => {
    const { api } = setup({ running: false });
    expect(screen.getByRole('status')).toHaveTextContent('Shell beendet.');
    await userEvent.click(screen.getByRole('button', { name: 'Neu starten' }));
    expect(api.restart).toHaveBeenCalledWith('s1');
  });

  it('schedules a job with button or Enter and confirms it', async () => {
    const { api } = setup();
    const open = screen.getByRole('button', { name: 'Job planen' });
    await userEvent.click(open);
    expect(open).toHaveAttribute('aria-expanded', 'true');
    await userEvent.type(screen.getByRole('textbox', { name: 'Befehl' }), 'pnpm test');
    const schedule = screen.getByRole('textbox', { name: 'Zeitplan (Cron)' });
    expect(schedule).toHaveAccessibleDescription(
      'Minute Stunde Tag Monat Wochentag in Ortszeit, z. B. 0 2 * * 1-5 für werktags um 2 Uhr',
    );
    await userEvent.type(schedule, '0 2 * * *');
    await userEvent.click(screen.getByRole('button', { name: 'Job anlegen' }));
    expect(api.addJob).toHaveBeenCalledWith('s1', 'pnpm test', '0 2 * * *');
    expect(screen.queryByRole('textbox', { name: 'Befehl' })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Job angelegt. Alle Jobs stehen in den Einstellungen unter „Jobs“.',
    );

    await userEvent.click(open);
    await userEvent.type(screen.getByRole('textbox', { name: 'Befehl' }), 'ls');
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Zeitplan (Cron)' }),
      '* * * * *{Enter}',
    );
    expect(api.addJob).toHaveBeenLastCalledWith('s1', 'ls', '* * * * *');
  });

  it('plans one job for a double click on Job anlegen (ADR 0028)', async () => {
    const { api } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Job planen' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Befehl' }), 'ls');
    await userEvent.type(screen.getByRole('textbox', { name: 'Zeitplan (Cron)' }), '* * * * *');
    const add = screen.getByRole('button', { name: 'Job anlegen' });
    // The second click of a double click, after the first answer already came.
    fireEvent.click(add, { detail: 1 });
    fireEvent.click(add, { detail: 2 });
    expect(api.addJob).toHaveBeenCalledTimes(1);
  });

  it('keeps the job form open when adding fails and closes it on cancel', async () => {
    const { api, run } = setup();
    api.addJob.mockRejectedValueOnce(new Error('Befehl fehlt'));
    run.mockImplementationOnce(async (action) => void (await action().catch(() => undefined)));
    await userEvent.click(screen.getByRole('button', { name: 'Job planen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Job anlegen' }));
    expect(api.addJob).toHaveBeenCalledWith('s1', '', '');
    expect(screen.getByRole('textbox', { name: 'Befehl' })).toBeVisible();
    expect(screen.queryByRole('status')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('textbox', { name: 'Befehl' })).toBeNull();
  });
});
