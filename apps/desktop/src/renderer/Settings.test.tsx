import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Settings } from './Settings';
import type { AppSettings } from '../shared';

const settings: AppSettings = {
  updateChannel: 'stable',
  language: 'system',
  theme: 'system',
  bays: [],
  baySettings: {},
  shortcuts: [],
};

describe('Settings', () => {
  const settingsApi = () => ({
    getJobs: vi.fn(async () => ({ bays: [], jobs: [], servers: [] })),
    setJobPaused: vi.fn(async () => {}),
    runJob: vi.fn(async () => {}),
    removeJob: vi.fn(async () => {}),
    onJobs: vi.fn(() => () => {}),
    getPermissions: vi.fn(async () => ({ bays: [], functions: [], grants: [] })),
    revoke: vi.fn(),
    setGrant: vi.fn(),
    getSettings: vi.fn(async () => settings),
    setUpdateChannel: vi.fn(async () => {}),
    setLanguage: vi.fn(async () => {}),
    getBaySettings: vi.fn(async () => [
      {
        bayId: 'dev.hangar.agents',
        name: 'Agents',
        settings: [
          {
            key: 'copyOnSelect',
            label: 'Markieren kopiert in die Zwischenablage',
            description: 'Gilt für neue Sessions.',
            value: true,
          },
        ],
      },
    ]),
    setBaySetting: vi.fn(async () => {}),
    getWorkspaces: vi.fn(async () => ({
      status: 'off' as const,
      name: 'anna-mac',
      fingerprint: 'a'.repeat(64),
      workspaces: [],
      functions: [],
    })),
    connectRelay: vi.fn(async () => {}),
    createWorkspace: vi.fn(async () => {}),
    inviteToWorkspace: vi.fn(async () => ({ workspace: '', token: '', fingerprint: '' })),
    joinWorkspace: vi.fn(async () => 'waiting' as const),
    acceptMember: vi.fn(async () => {}),
    rejectMember: vi.fn(async () => {}),
    removeMember: vi.fn(async () => {}),
    setWorkspaceShare: vi.fn(async () => {}),
    onWorkspaces: vi.fn(() => () => {}),
    getBayCatalog: vi.fn(async () => null),
    prepareBay: vi.fn(),
    confirmBay: vi.fn(async () => {}),
    cancelBay: vi.fn(async () => {}),
    rollbackBay: vi.fn(async () => {}),
    getLocalServer: vi.fn(
      async () => null as { enabled: boolean; active: boolean; forced?: boolean } | null,
    ),
    setLocalServer: vi.fn(async () => {}),
    relaunch: vi.fn(),
    getNotifications: vi.fn(async () => ({
      supported: true,
      platform: 'darwin',
      settings: true as const,
    })),
    testNotification: vi.fn(async () => ({ result: 'shown' as const })),
    openNotificationSettings: vi.fn(async () => {}),
    onNotifications: vi.fn(() => () => {}),
  });

  it('has a section for system notifications (ADR 0044)', async () => {
    render(<Settings api={settingsApi()} />);
    expect(await screen.findByRole('heading', { name: 'Mitteilungen' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Testmitteilung senden' })).toBeEnabled();
  });

  it('switches the local server for the next start, asking before it ends shells (ADR 0036)', async () => {
    const api = settingsApi();
    api.getLocalServer.mockResolvedValue({ enabled: true, active: true });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<Settings api={api} />);
    const box = await screen.findByRole('checkbox', { name: 'Agents im lokalen Server ausführen' });
    expect(box).toBeChecked();
    expect(box).toHaveAccessibleDescription(
      'Shells und Agents laufen weiter, wenn Hangar beendet wird, abstürzt oder sich aktualisiert. Wer Projekte in Workspaces teilt, schaltet das vorerst ab.',
    );
    expect(screen.queryByRole('button', { name: 'Hangar neu starten' })).toBeNull();
    // Cancelled: nothing changes.
    await userEvent.click(box);
    expect(confirm).toHaveBeenCalledWith(
      'Beim nächsten Start enden die Shells des lokalen Servers; die Agents ziehen mit ihren Daten zurück in Hangar. Ausschalten?',
    );
    expect(api.setLocalServer).not.toHaveBeenCalled();
    expect(box).toBeChecked();
    confirm.mockReturnValue(true);
    await userEvent.click(box);
    expect(api.setLocalServer).toHaveBeenCalledWith(false);
    expect(box).not.toBeChecked();
    expect(screen.getByText('Gilt nach dem Neustart von Hangar.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Hangar neu starten' }));
    expect(api.relaunch).toHaveBeenCalled();
    // Back on: no question, nothing pending any more.
    confirm.mockClear();
    await userEvent.click(box);
    expect(confirm).not.toHaveBeenCalled();
    expect(api.setLocalServer).toHaveBeenLastCalledWith(true);
    expect(screen.queryByRole('button', { name: 'Hangar neu starten' })).toBeNull();
    confirm.mockRestore();
  });

  it('locks the switch while HANGAR_LOCAL_SERVER decides (Codex 4b)', async () => {
    const api = settingsApi();
    api.getLocalServer.mockResolvedValue({ enabled: false, active: false, forced: true });
    render(<Settings api={api} />);
    const box = await screen.findByRole('checkbox', { name: 'Agents im lokalen Server ausführen' });
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
    expect(screen.getByText('Festgelegt durch HANGAR_LOCAL_SERVER.')).toBeVisible();
  });

  it('shows no switch where there is no local server (Windows, Linux)', async () => {
    const api = settingsApi();
    render(<Settings api={api} />);
    await vi.waitFor(() => expect(api.getLocalServer).toHaveBeenCalled());
    expect(screen.queryByRole('checkbox', { name: /lokalen Server/ })).toBeNull();
  });

  it('shows and changes the update channel', async () => {
    const api = settingsApi();
    render(<Settings api={api} />);
    const select = screen.getByRole('combobox', { name: 'Update-Kanal' });
    await vi.waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveValue('stable');
    await userEvent.selectOptions(select, 'Beta');
    expect(api.setUpdateChannel).toHaveBeenCalledWith('beta');
    expect(select).toHaveValue('beta');
    expect(screen.getByRole('combobox', { name: 'Sprache' })).toHaveValue('system');
  });

  it('reloads the bay catalog when the update channel changes (ADR 0034)', async () => {
    const api = settingsApi();
    render(<Settings api={api} />);
    const select = screen.getByRole('combobox', { name: 'Update-Kanal' });
    await vi.waitFor(() => expect(select).toBeEnabled());
    // The catalog mounts anew once the settings name the channel; let that load run first.
    await act(async () => {});
    const before = api.getBayCatalog.mock.calls.length;
    await userEvent.selectOptions(select, 'Beta');
    await vi.waitFor(() => expect(api.getBayCatalog).toHaveBeenCalledTimes(before + 1));
  });

  it('changes the language for the next start', async () => {
    const api = settingsApi();
    render(<Settings api={api} />);
    const select = screen.getByRole('combobox', { name: 'Sprache' });
    await vi.waitFor(() => expect(select).toBeEnabled());
    expect(screen.getByText('Gilt ab dem nächsten Start von Hangar.')).toBeVisible();
    await userEvent.selectOptions(select, 'English');
    expect(api.setLanguage).toHaveBeenCalledWith('en');
    expect(select).toHaveValue('en');
    expect(screen.getByRole('combobox', { name: 'Update-Kanal' })).toHaveValue('stable');
  });

  it('shows the settings bays declare and changes them (ADR 0023)', async () => {
    const api = settingsApi();
    render(<Settings api={api} />);
    expect(await screen.findByRole('heading', { name: 'Agents' })).toBeVisible();
    const box = screen.getByRole('checkbox', { name: 'Markieren kopiert in die Zwischenablage' });
    expect(box).toBeChecked();
    expect(box).toHaveAccessibleDescription('Gilt für neue Sessions.');
    await userEvent.click(box);
    expect(api.setBaySetting).toHaveBeenCalledWith('dev.hangar.agents', 'copyOnSelect', false);
    expect(box).not.toBeChecked();
  });

  it('shows a text setting as a field and stores each change (ADR 0025)', async () => {
    const api = {
      ...settingsApi(),
      getBaySettings: vi.fn(async () => [
        {
          bayId: 'dev.hangar.agents',
          name: 'Agents',
          settings: [{ key: 'prompt', label: 'Prompt', description: 'zsh', value: '%~ ' }],
        },
      ]),
    };
    render(<Settings api={api} />);
    const field = await screen.findByRole('textbox', { name: 'Prompt' });
    expect(field).toHaveValue('%~ ');
    expect(field).toHaveAccessibleDescription('zsh');
    await userEvent.clear(field);
    expect(api.setBaySetting).toHaveBeenLastCalledWith('dev.hangar.agents', 'prompt', '');
    await userEvent.type(field, '>');
    expect(api.setBaySetting).toHaveBeenLastCalledWith('dev.hangar.agents', 'prompt', '>');
    expect(field).toHaveValue('>');
  });

  it('shows no bay section when no bay declares settings', async () => {
    const api = { ...settingsApi(), getBaySettings: vi.fn(async () => []) };
    render(<Settings api={api} />);
    await vi.waitFor(() => expect(api.getBaySettings).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Einstellungen der Bays' })).toBeNull();
  });
});
