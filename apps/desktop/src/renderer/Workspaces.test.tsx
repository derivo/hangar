import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Workspaces } from './Workspaces';
import type { WorkspacesSettingsView } from '../shared';

const me = 'a'.repeat(64);
const ben = 'b'.repeat(64);
const eve = 'e'.repeat(64);

const view = (over: Partial<WorkspacesSettingsView> = {}): WorkspacesSettingsView => ({
  relay: 'wss://relay.example',
  status: 'connected',
  name: 'anna-mac',
  fingerprint: me,
  workspaces: [
    {
      name: 'team',
      waiting: false,
      members: [
        { name: 'anna-mac', fingerprint: me },
        { name: 'ben-pc', fingerprint: ben },
      ],
      joined: [{ name: 'eve-pc', fingerprint: eve }],
      shared: ['dev.hangar.notes/read'],
    },
  ],
  functions: [
    { id: 'dev.hangar.notes/read', description: 'Notizen lesen' },
    { id: 'dev.hangar.notes/list' },
  ],
  ...over,
});

const remote = (channel: string, message: string) =>
  new Error(`Error invoking remote method 'shell:workspace.${channel}': Error: ${message}`);

function setup(initial = view()) {
  let changed = () => {};
  const api = {
    getWorkspaces: vi.fn(async () => initial),
    connectRelay: vi.fn(async (_url: string) => {}),
    createWorkspace: vi.fn(async (_name: string, _token: string) => {}),
    inviteToWorkspace: vi.fn(async (workspace: string) => ({
      workspace,
      token: 'tok-123',
      fingerprint: me,
    })),
    joinWorkspace: vi.fn(async (_n: string, _t: string, _f: string) => 'waiting' as const),
    acceptMember: vi.fn(async (_n: string, _f: string) => {}),
    rejectMember: vi.fn(async (_n: string, _f: string) => {}),
    removeMember: vi.fn(async (_n: string, _f: string) => {}),
    setWorkspaceShare: vi.fn(async (_n: string, _t: string, _on: boolean) => {}),
    onWorkspaces: vi.fn((listener: () => void) => {
      changed = listener;
      return () => {};
    }),
  };
  render(<Workspaces api={api} />);
  return { api, changed: () => act(() => changed()) };
}

const form = (name: string) => screen.getByRole('form', { name });
const alertIn = (f: HTMLElement) => within(f).getByRole('alert');

afterEach(() => vi.restoreAllMocks());

describe('Workspaces (ADR 0030)', () => {
  it('shows this instance, the relay and its status', async () => {
    setup(view({ status: 'error', error: 'Relay not reachable' }));
    expect(await screen.findByRole('heading', { name: 'Workspaces' })).toBeVisible();
    expect(screen.getByText(me, { selector: 'b' })).toBeVisible();
    expect(screen.getByText('anna-mac', { selector: 'b' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Relay-Adresse' })).toHaveValue(
      'wss://relay.example',
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Nicht verbunden – Das Relay ist nicht erreichbar.',
    );
  });

  describe('relay form', () => {
    const relay = async (address: string) => {
      const field = await screen.findByRole('textbox', { name: 'Relay-Adresse' });
      await userEvent.clear(field);
      if (address) await userEvent.type(field, address);
      await userEvent.click(within(form('Relay')).getByRole('button', { name: 'Verbinden' }));
    };

    it('refuses an empty address', async () => {
      const { api } = setup(view({ relay: undefined, status: 'off' }));
      await relay('');
      expect(alertIn(form('Relay'))).toHaveTextContent('Relay-Adresse fehlt.');
      expect(api.connectRelay).not.toHaveBeenCalled();
    });

    it.each([
      [
        'Invalid relay address',
        'Die Adresse beginnt mit wss:// (ws:// nur für Tests auf diesem Rechner).',
      ],
      ['Relay not reachable', 'Das Relay ist nicht erreichbar.'],
      [
        'Invalid proof',
        'Das Relay hat die Anmeldung abgelehnt. Stimmt die Adresse mit HANGAR_RELAY_URL des Relays überein?',
      ],
    ])('says why the relay refused: %s', async (message, text) => {
      const { api } = setup();
      api.connectRelay.mockRejectedValueOnce(remote('connect', message));
      await relay('wss://other.example');
      expect(alertIn(form('Relay'))).toHaveTextContent(text);
    });

    it('connects with Enter', async () => {
      const { api } = setup(view({ relay: undefined, status: 'off' }));
      await userEvent.type(
        await screen.findByRole('textbox', { name: 'Relay-Adresse' }),
        ' wss://relay.example {Enter}',
      );
      expect(api.connectRelay).toHaveBeenCalledWith('wss://relay.example');
    });

    it('connects once for a double click', async () => {
      const { api } = setup();
      await screen.findByRole('textbox', { name: 'Relay-Adresse' });
      await userEvent.dblClick(within(form('Relay')).getByRole('button', { name: 'Verbinden' }));
      expect(api.connectRelay).toHaveBeenCalledTimes(1);
    });

    it('connects (happy path)', async () => {
      const { api } = setup(view({ relay: undefined, status: 'off' }));
      await relay('wss://relay.example');
      expect(api.connectRelay).toHaveBeenCalledWith('wss://relay.example');
      expect(within(form('Relay')).queryByRole('alert')).toBeNull();
    });
  });

  describe('create form', () => {
    const fill = async (name: string, token: string, submit = true) => {
      await screen.findByRole('heading', { name: 'Workspaces' });
      const f = form('Workspace anlegen');
      if (name) await userEvent.type(within(f).getByRole('textbox', { name: 'Name' }), name);
      if (token) await userEvent.type(within(f).getByLabelText('Betreiber-Token'), token);
      if (submit) await userEvent.click(within(f).getByRole('button', { name: 'Anlegen' }));
      return f;
    };

    it.each([
      ['', 'secret', 'Name fehlt.'],
      [
        '-team',
        'secret',
        'Der Name beginnt mit Buchstabe oder Ziffer und enthält nur Buchstaben, Ziffern, Leerzeichen, Punkt, Unterstrich und Bindestrich, höchstens 64 Zeichen.',
      ],
      [
        'x'.repeat(65),
        'secret',
        'Der Name beginnt mit Buchstabe oder Ziffer und enthält nur Buchstaben, Ziffern, Leerzeichen, Punkt, Unterstrich und Bindestrich, höchstens 64 Zeichen.',
      ],
      ['team', '', 'Betreiber-Token fehlt.'],
    ])('refuses name %j with token %j', async (name, token, text) => {
      const { api } = setup();
      const f = await fill(name, token);
      expect(alertIn(f)).toHaveTextContent(text);
      expect(api.createWorkspace).not.toHaveBeenCalled();
    });

    it.each([
      ['Invalid operator token', 'Das Betreiber-Token stimmt nicht.'],
      ['Workspace exists', 'Diesen Workspace gibt es schon.'],
      ['Not connected to a relay', 'Nicht mit einem Relay verbunden.'],
    ])('says why the relay refused: %s', async (message, text) => {
      const { api } = setup();
      api.createWorkspace.mockRejectedValueOnce(remote('create', message));
      const f = await fill('team', 'secret');
      expect(alertIn(f)).toHaveTextContent(text);
    });

    it('creates with Enter', async () => {
      const { api } = setup();
      const f = await fill('team', 'secret{Enter}', false);
      expect(api.createWorkspace).toHaveBeenCalledWith('team', 'secret');
      expect(within(f).getByRole('textbox', { name: 'Name' })).toHaveValue('');
    });

    it('creates (happy path)', async () => {
      const { api } = setup();
      const f = await fill(' new team ', 'secret');
      expect(api.createWorkspace).toHaveBeenCalledWith('new team', 'secret');
      expect(within(f).queryByRole('alert')).toBeNull();
      expect(within(f).getByLabelText('Betreiber-Token')).toHaveValue('');
    });
  });

  describe('join form', () => {
    const fill = async (workspace: string, token: string, fingerprint: string, submit = true) => {
      await screen.findByRole('heading', { name: 'Workspaces' });
      const f = form('Workspace beitreten');
      const type = async (name: string, value: string) =>
        value && userEvent.type(within(f).getByRole('textbox', { name }), value);
      await type('Workspace', workspace);
      await type('Einladungs-Token', token);
      await type('Fingerabdruck des Einladenden', fingerprint);
      if (submit) await userEvent.click(within(f).getByRole('button', { name: 'Beitreten' }));
      return f;
    };

    it.each([
      ['', 'tok', ben, 'Workspace fehlt.'],
      [
        'team!',
        'tok',
        ben,
        'Der Name beginnt mit Buchstabe oder Ziffer und enthält nur Buchstaben, Ziffern, Leerzeichen, Punkt, Unterstrich und Bindestrich, höchstens 64 Zeichen.',
      ],
      ['team', '', ben, 'Einladungs-Token fehlt.'],
      ['team', 'tok', '', 'Fingerabdruck fehlt.'],
      ['team', 'tok', 'b'.repeat(63), 'Der Fingerabdruck hat 64 Zeichen aus 0–9 und a–f.'],
      ['team', 'tok', 'g'.repeat(64), 'Der Fingerabdruck hat 64 Zeichen aus 0–9 und a–f.'],
    ])('refuses workspace %j, token %j, fingerprint %j', async (w, tok, fp, text) => {
      const { api } = setup();
      const f = await fill(w, tok, fp);
      expect(alertIn(f)).toHaveTextContent(text);
      expect(api.joinWorkspace).not.toHaveBeenCalled();
    });

    it.each([
      ['Invalid invitation', 'Die Einladung gilt nicht: falsch, schon benutzt oder abgelaufen.'],
      ['Revoked', 'Dieser Hangar wurde aus dem Workspace entfernt.'],
      ['Something else', 'Something else'],
    ])('says why the relay refused: %s', async (message, text) => {
      const { api } = setup();
      api.joinWorkspace.mockRejectedValueOnce(remote('join', message));
      const f = await fill('team', 'tok', ben);
      expect(alertIn(f)).toHaveTextContent(text);
    });

    it('joins with Enter', async () => {
      const { api } = setup();
      await fill('team', 'tok', `${ben}{Enter}`, false);
      expect(api.joinWorkspace).toHaveBeenCalledWith('team', 'tok', ben);
    });

    it('joins (happy path), the fingerprint in any case and with spaces', async () => {
      const { api } = setup();
      const f = await fill('team', ' tok ', ` ${'B'.repeat(64)} `);
      expect(api.joinWorkspace).toHaveBeenCalledWith('team', 'tok', ben);
      expect(within(f).queryByRole('alert')).toBeNull();
      expect(within(f).getByRole('textbox', { name: 'Workspace' })).toHaveValue('');
    });
  });

  describe('a workspace', () => {
    const team = async () => screen.findByRole('region', { name: 'team' });

    it('lists the members, this Hangar without a remove button', async () => {
      setup();
      const members = within(await team()).getByRole('list', { name: 'Mitglieder' });
      const items = within(members).getAllByRole('listitem');
      expect(items[0]).toHaveTextContent('anna-mac (dieser Hangar)');
      expect(within(items[0]!).queryByRole('button')).toBeNull();
      expect(items[1]).toHaveTextContent(`ben-pc${ben}`);
    });

    it('removes a member after confirmation', async () => {
      const { api } = setup();
      const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
      const remove = within(await team()).getByRole('button', { name: 'ben-pc entfernen' });
      await userEvent.click(remove);
      expect(confirm).toHaveBeenCalledWith(
        'ben-pc aus „team“ entfernen? Diese Instanz kann danach nicht wieder beitreten.',
      );
      expect(api.removeMember).not.toHaveBeenCalled();
      await userEvent.click(remove);
      expect(api.removeMember).toHaveBeenCalledWith('team', ben);
    });

    it('shows who wants to join with the fingerprint, to add or refuse', async () => {
      const { api } = setup();
      const region = await team();
      expect(region).toHaveTextContent('„eve-pc“ möchte beitreten. Vergleiche den Fingerabdruck:');
      expect(within(region).getByText(eve)).toBeVisible();
      await userEvent.dblClick(
        within(region).getByRole('button', { name: 'Fingerabdruck stimmt – eve-pc aufnehmen' }),
      );
      expect(api.acceptMember).toHaveBeenCalledTimes(1);
      expect(api.acceptMember).toHaveBeenCalledWith('team', eve);
      await userEvent.click(within(region).getByRole('button', { name: 'eve-pc ablehnen' }));
      expect(api.rejectMember).toHaveBeenCalledWith('team', eve);
    });

    it('a request another member invited: refuse only, the inviter adds it', async () => {
      const team = view().workspaces[0]!;
      const { api } = setup(
        view({
          workspaces: [{ ...team, joined: [{ name: 'eve-pc', fingerprint: eve, inviter: ben }] }],
        }),
      );
      const region = await screen.findByRole('region', { name: 'team' });
      expect(region).toHaveTextContent('ben-pc hat eingeladen und nimmt auf.');
      expect(
        within(region).queryByRole('button', { name: /^Fingerabdruck stimmt/ }),
      ).not.toBeInTheDocument();
      await userEvent.click(within(region).getByRole('button', { name: 'eve-pc ablehnen' }));
      expect(api.rejectMember).toHaveBeenCalledWith('team', eve);
    });

    it('a request this instance invited can be added', async () => {
      const team = view().workspaces[0]!;
      setup(
        view({
          workspaces: [{ ...team, joined: [{ name: 'eve-pc', fingerprint: eve, inviter: me }] }],
        }),
      );
      const region = await screen.findByRole('region', { name: 'team' });
      expect(
        within(region).getByRole('button', { name: 'Fingerabdruck stimmt – eve-pc aufnehmen' }),
      ).toBeVisible();
      expect(region).not.toHaveTextContent('hat eingeladen');
    });

    it('names the error when another member tries to add', async () => {
      const { api } = setup();
      api.acceptMember.mockRejectedValueOnce(
        remote('accept', 'Only the inviter can add this instance'),
      );
      const region = await team();
      await userEvent.click(
        within(region).getByRole('button', { name: 'Fingerabdruck stimmt – eve-pc aufnehmen' }),
      );
      expect(within(region).getByRole('alert')).toHaveTextContent(
        'Nur wer eingeladen hat, kann diese Instanz aufnehmen.',
      );
    });

    it('shows an error of an action in the workspace', async () => {
      const { api } = setup();
      api.acceptMember.mockRejectedValueOnce(remote('accept', 'Relay connection closed'));
      const region = await team();
      await userEvent.click(
        within(region).getByRole('button', { name: 'Fingerabdruck stimmt – eve-pc aufnehmen' }),
      );
      expect(within(region).getByRole('alert')).toHaveTextContent(
        'Die Verbindung zum Relay ist getrennt.',
      );
    });

    it('invites: shows workspace, token and fingerprint to hand over', async () => {
      const { api } = setup();
      const region = await team();
      await userEvent.click(within(region).getByRole('button', { name: 'Einladen' }));
      expect(api.inviteToWorkspace).toHaveBeenCalledWith('team');
      const invite = within(region).getByRole('list', { name: 'Einladung' });
      expect(invite).toHaveTextContent('Workspaceteam');
      expect(invite).toHaveTextContent('Einladungs-Tokentok-123');
      expect(invite).toHaveTextContent(`Fingerabdruck${me}`);
      expect(region).toHaveTextContent(
        'Gib alle drei Angaben der Person, die beitreten soll. Das Token gilt einmal und sieben Tage.',
      );
    });

    it('shares functions with the workspace', async () => {
      const { api } = setup();
      const region = await team();
      const read = within(region).getByRole('checkbox', { name: 'dev.hangar.notes/read' });
      expect(read).toBeChecked();
      expect(read).toHaveAccessibleDescription('Notizen lesen');
      await userEvent.click(read);
      expect(api.setWorkspaceShare).toHaveBeenCalledWith('team', 'dev.hangar.notes/read', false);
      await userEvent.click(
        within(region).getByRole('checkbox', { name: 'dev.hangar.notes/list' }),
      );
      expect(api.setWorkspaceShare).toHaveBeenCalledWith('team', 'dev.hangar.notes/list', true);
    });

    it('says when no bay offers functions, and when the inviter has not added this Hangar', async () => {
      setup(
        view({
          functions: [],
          workspaces: [
            { name: 'team', waiting: false, members: [], joined: [], shared: [] },
            { name: 'club', waiting: true, members: [], joined: [], shared: [] },
          ],
        }),
      );
      expect(
        within(await team()).getByText('Keine Bay bietet Funktionen für andere Instanzen an.'),
      ).toBeVisible();
      const club = screen.getByRole('region', { name: 'club' });
      expect(club).toHaveTextContent('Wartet, bis der Einladende diesen Hangar aufnimmt.');
      expect(within(club).queryByRole('button')).toBeNull();
    });

    it('reloads when the workspaces change', async () => {
      const { api, changed } = setup();
      await team();
      api.getWorkspaces.mockResolvedValueOnce(view({ workspaces: [] }));
      await changed();
      await vi.waitFor(() => expect(screen.queryByRole('region', { name: 'team' })).toBeNull());
    });
  });
});
