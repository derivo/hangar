import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Permissions } from './Permissions';
import type { PermissionsView } from '../shared';

const view: PermissionsView = {
  bays: [
    { id: 'dev.hangar.agents', name: 'Agents' },
    { id: 'dev.hangar.browser', name: 'Browser' },
    { id: 'dev.hangar.vault', name: 'Tresor' },
  ],
  functions: [
    {
      id: 'dev.hangar.vault/secret.read',
      bayId: 'dev.hangar.vault',
      sensitive: true,
      description: 'Reads a secret',
    },
    { id: 'dev.hangar.vault/entry.count', bayId: 'dev.hangar.vault', sensitive: false },
  ],
  grants: [
    {
      subject: 'dev.hangar.browser',
      target: 'dev.hangar.vault/secret.read',
      mode: 'ask',
      grantedAt: '2026-10-28T10:00:00.000Z',
      lastUsed: '2026-10-28T11:30:00.000Z',
    },
    { subject: 'dev.hangar.browser', target: 'dev.hangar.vault/entry.count', mode: 'allow' },
    {
      subject: 'dev.hangar.agents',
      target: 'dev.hangar.vault/secret.read',
      mode: 'session',
      sessionId: '12345678-aaaa',
      sessionLabel: 'Login reparieren',
    },
  ],
};

function setup(initial: PermissionsView = view) {
  const api = {
    getPermissions: vi.fn(async () => initial),
    revoke: vi.fn(async () => {}),
    setGrant: vi.fn(async () => {}),
  };
  render(<Permissions api={api} />);
  return api;
}

const group = (name: string) => screen.getByRole('table', { name });
const row = (table: HTMLElement, fn: string) =>
  within(table).getByRole('row', { name: new RegExp(fn.replace('.', '\\.')) });

describe('Permissions', () => {
  it('groups grants by caller with names, function descriptions and times', async () => {
    setup();
    const browser = await screen.findByRole('table', { name: 'Browser' });
    const secret = row(browser, 'secret.read');
    expect(secret).toHaveTextContent('Reads a secret');
    expect(secret).toHaveTextContent('sensibel');
    expect(within(secret).getByRole('combobox')).toHaveValue('ask');
    expect(secret).toHaveTextContent('28.10.26');
    expect(row(browser, 'entry.count')).toHaveTextContent('unbekannt');
    expect(row(browser, 'entry.count')).toHaveTextContent('seit dem Start nicht');

    const agents = group('Agents');
    const session = row(agents, 'secret.read');
    expect(session).toHaveTextContent('nur Session „Login reparieren“');
    expect(within(session).queryByRole('combobox')).toBeNull();
    expect(screen.queryByText(/12345678/)).toBeNull();
  });

  it('offers only the modes the function allows and changes them', async () => {
    const api = setup();
    const browser = await screen.findByRole('table', { name: 'Browser' });
    const count = within(row(browser, 'entry.count')).getByRole('combobox');
    expect([...count.querySelectorAll('option')].map((o) => o.value)).toEqual(['allow', 'deny']);
    const secret = within(row(browser, 'secret.read')).getByRole('combobox');
    expect([...secret.querySelectorAll('option')].map((o) => o.value)).toEqual([
      'allow',
      'ask',
      'deny',
    ]);
    await userEvent.selectOptions(count, 'deny');
    expect(api.setGrant).toHaveBeenCalledWith(
      'dev.hangar.browser',
      'dev.hangar.vault/entry.count',
      'deny',
    );
    expect(api.getPermissions).toHaveBeenCalledTimes(2);
  });

  it('revokes a grant', async () => {
    const api = setup();
    const agents = await screen.findByRole('table', { name: 'Agents' });
    await userEvent.click(
      within(row(agents, 'secret.read')).getByRole('button', { name: 'Widerrufen' }),
    );
    expect(api.revoke).toHaveBeenCalledWith(view.grants[2]);
  });

  it('sets a rule before the first access', async () => {
    const api = setup();
    const form = await screen.findByRole('group', { name: 'Regel festlegen' });
    await userEvent.selectOptions(
      within(form).getByRole('combobox', { name: 'Aufrufer' }),
      'dev.hangar.agents',
    );
    await userEvent.selectOptions(
      within(form).getByRole('combobox', { name: 'Funktion' }),
      'dev.hangar.vault/entry.count',
    );
    const mode = within(form).getByRole('combobox', { name: 'Freigabe' });
    expect([...mode.querySelectorAll('option')].map((o) => o.value)).toEqual(['allow', 'deny']);
    await userEvent.selectOptions(mode, 'deny');
    await userEvent.click(within(form).getByRole('button', { name: 'Festlegen' }));
    expect(api.setGrant).toHaveBeenCalledWith(
      'dev.hangar.agents',
      'dev.hangar.vault/entry.count',
      'deny',
    );
  });

  it('offers no rules for non-sensitive functions of the caller itself', async () => {
    const api = setup();
    const form = await screen.findByRole('group', { name: 'Regel festlegen' });
    await userEvent.selectOptions(
      within(form).getByRole('combobox', { name: 'Funktion' }),
      'dev.hangar.vault/entry.count',
    );
    await userEvent.selectOptions(
      within(form).getByRole('combobox', { name: 'Aufrufer' }),
      'dev.hangar.vault',
    );
    const fn = within(form).getByRole('combobox', { name: 'Funktion' });
    expect([...fn.querySelectorAll('option')].map((o) => o.value)).toEqual([
      'dev.hangar.vault/secret.read',
    ]);
    await userEvent.click(within(form).getByRole('button', { name: 'Festlegen' }));
    expect(api.setGrant).toHaveBeenCalledWith(
      'dev.hangar.vault',
      'dev.hangar.vault/secret.read',
      'allow',
    );
  });

  it('filters by caller and searches functions', async () => {
    setup();
    await screen.findByRole('table', { name: 'Browser' });
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Aufrufer anzeigen' }),
      'dev.hangar.agents',
    );
    expect(screen.queryByRole('table', { name: 'Browser' })).toBeNull();
    expect(group('Agents')).toBeVisible();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Aufrufer anzeigen' }), '');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Funktion suchen' }), 'count');
    expect(screen.queryByRole('table', { name: 'Agents' })).toBeNull();
    expect(within(group('Browser')).getAllByRole('row')).toHaveLength(2);
  });

  it('explains the empty state', async () => {
    setup({ ...view, grants: [] });
    expect(
      await screen.findByText(
        'Noch keine Rechte. Hangar fragt beim ersten Zugriff einer Bay auf eine andere.',
      ),
    ).toBeVisible();
  });

  it('revokes once while the answer is pending', async () => {
    const api = setup();
    let finish!: () => void;
    api.revoke.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    const agents = await screen.findByRole('table', { name: 'Agents' });
    const button = within(row(agents, 'secret.read')).getByRole('button', { name: 'Widerrufen' });
    await userEvent.dblClick(button);
    await userEvent.click(button);
    expect(api.revoke).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(api.getPermissions).toHaveBeenCalledTimes(2);
  });

  it('keeps the newest list when an earlier load answers last', async () => {
    const api = setup();
    await screen.findByRole('table', { name: 'Agents' });
    const loads: ((v: PermissionsView) => void)[] = [];
    api.getPermissions.mockImplementation(() => new Promise((r) => loads.push(r)));
    const revoke = (table: string, fn: string) =>
      userEvent.click(within(row(group(table), fn)).getByRole('button', { name: 'Widerrufen' }));
    await revoke('Agents', 'secret.read');
    await revoke('Browser', 'entry.count');
    const newest = {
      ...view,
      grants: view.grants.filter((g) => g.subject !== 'dev.hangar.browser'),
    };
    await act(async () => loads[1]!(newest));
    await act(async () => loads[0]!(view));
    expect(screen.queryByRole('table', { name: 'Browser' })).toBeNull();
  });

  it('sets a rule once while the answer is pending', async () => {
    const api = setup();
    let finish!: () => void;
    api.setGrant.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    const form = await screen.findByRole('group', { name: 'Regel festlegen' });
    const button = within(form).getByRole('button', { name: 'Festlegen' });
    await userEvent.dblClick(button);
    expect(api.setGrant).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await userEvent.click(button);
    expect(api.setGrant).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['Widerrufen', 'revoke'],
    ['Festlegen', 'setGrant'],
  ] as const)('shows why %s failed', async (name, call) => {
    const api = setup();
    api[call].mockRejectedValueOnce(
      new Error('Error invoking remote method \'shell:x\': Error: Unknown bay "dev.hangar.x"'),
    );
    await screen.findByRole('table', { name: 'Agents' });
    await userEvent.click(screen.getAllByRole('button', { name })[0]!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Unknown bay "dev.hangar.x"');
  });
});
