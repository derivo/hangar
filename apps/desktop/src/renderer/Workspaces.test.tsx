import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Workspaces } from './Workspaces';
import type { ActivityEvent } from '@hangar/bus';
import type { InboxItem, WorkspaceActivity, WorkspacesSettingsView } from '../shared';

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
      trusted: [],
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

function setup(initial = view(), activity: WorkspaceActivity = { inbox: [], log: [] }) {
  const listeners = new Set<() => void>();
  const api = {
    setWorkspaceTrust: vi.fn(async (_n: string, _f: string, _on: boolean) => {}),
    getWorkspaceActivity: vi.fn(async () => activity),
    acceptInbox: vi.fn(async (_id: string) => {}),
    rejectInbox: vi.fn(async (_id: string) => {}),
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
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  render(<Workspaces api={api} />);
  return { api, changed: () => act(() => listeners.forEach((l) => l())) };
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

    it('keeps the description of a function closed below it, the checkbox still describes it', async () => {
      setup();
      const region = await screen.findByRole('region', { name: 'team' });
      const read = within(region).getByRole('checkbox', { name: 'dev.hangar.notes/read' });
      expect(read).toHaveAccessibleDescription('Notizen lesen');
      const more = within(region).getByText('Beschreibung', { selector: 'summary' });
      expect(more).toHaveAccessibleName('Beschreibung für dev.hangar.notes/read');
      const details = more.closest('details')!;
      expect(details.open).toBe(false);
      await userEvent.click(more);
      expect(details.open).toBe(true);
      expect(read).toBeChecked();
    });

    it('says when no bay offers functions, and when the inviter has not added this Hangar', async () => {
      setup(
        view({
          functions: [],
          workspaces: [
            { name: 'team', waiting: false, members: [], joined: [], shared: [], trusted: [] },
            { name: 'club', waiting: true, members: [], joined: [], shared: [], trusted: [] },
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

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 'i1',
  at: '2026-11-16T10:00:00.000Z',
  workspace: 'team',
  instance: ben,
  name: 'ben-pc',
  target: 'dev.hangar.board/task.add',
  preview: 'Login reparieren',
  ...over,
});
const logged = (over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  at: '2026-11-16T10:00:00.000Z',
  direction: 'in',
  workspace: 'team',
  instance: ben,
  name: 'ben-pc',
  target: 'dev.hangar.board/task.add',
  outcome: 'queued',
  ...over,
});

describe('Workspaces – trust and activity (ADR 0046)', () => {
  it('switches trust per member by fingerprint, never for this instance', async () => {
    const { api } = setup(view({ workspaces: [{ ...view().workspaces[0]!, trusted: [ben] }] }));
    const trust = await screen.findByRole('checkbox', {
      name: 'Arbeit von ben-pc automatisch annehmen',
    });
    expect(trust).toBeChecked();
    expect(
      screen.queryByRole('checkbox', { name: 'Arbeit von anna-mac automatisch annehmen' }),
    ).toBeNull();
    fireEvent.click(trust);
    await waitFor(() => expect(api.setWorkspaceTrust).toHaveBeenCalledWith('team', ben, false));
  });

  it('says when nothing waits and nothing happened', async () => {
    setup();
    expect(await screen.findByRole('heading', { name: 'Aktivität' })).toBeVisible();
    expect(screen.getByText('Nichts wartet auf Freigabe.')).toBeVisible();
    expect(screen.getByText('Noch keine Aktivität.')).toBeVisible();
  });

  it('accepts and rejects waiting work and loads again', async () => {
    const { api } = setup(view(), {
      inbox: [item(), item({ id: 'i2', preview: 'Docs' })],
      log: [],
    });
    const waiting = await screen.findByRole('list', { name: 'Wartet auf Freigabe' });
    expect(within(waiting).getAllByRole('listitem')).toHaveLength(2);
    expect(within(waiting).getAllByText('ben-pc (team)')[0]).toBeVisible();
    expect(within(waiting).getByText('Login reparieren')).toBeVisible();
    fireEvent.click(
      screen.getByRole('button', { name: 'Annehmen: Login reparieren – ben-pc (team)' }),
    );
    await waitFor(() => expect(api.acceptInbox).toHaveBeenCalledWith('i1'));
    fireEvent.click(screen.getByRole('button', { name: 'Ablehnen: Docs – ben-pc (team)' }));
    await waitFor(() => expect(api.rejectInbox).toHaveBeenCalledWith('i2'));
    await waitFor(() => expect(api.getWorkspaceActivity).toHaveBeenCalledTimes(3));
  });

  it('says so when an entry is gone in between or no longer allowed', async () => {
    const { api } = setup(view(), { inbox: [item()], log: [] });
    api.acceptInbox.mockRejectedValueOnce(remote('acceptInbox', 'No open inbox entry: i1'));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Annehmen: Login reparieren – ben-pc (team)' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Der Eintrag ist nicht mehr offen.');
    api.acceptInbox.mockRejectedValueOnce(
      remote('acceptInbox', 'Access denied: remote:x/y → dev.hangar.board/task.add'),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Annehmen: Login reparieren – ben-pc (team)' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Nicht mehr erlaubt: Die Instanz ist kein Mitglied mehr oder die Funktion nicht mehr freigegeben.',
      ),
    );
  });

  it('tells two members of one name apart by fingerprint (Codex)', async () => {
    const twin = { name: 'ben-pc', fingerprint: eve };
    const base = view().workspaces[0]!;
    setup(view({ workspaces: [{ ...base, members: [...base.members, twin] }] }));
    const boxes = await screen.findAllByRole('checkbox', {
      name: 'Arbeit von ben-pc automatisch annehmen',
    });
    expect(boxes.map((b) => b.getAttribute('aria-describedby') ?? '')).toHaveLength(2);
    expect(boxes[0]).toHaveAccessibleDescription(expect.stringContaining(ben));
    expect(boxes[1]).toHaveAccessibleDescription(expect.stringContaining(eve));
  });

  it('hides waiting entries and says why when the activity cannot be read (Codex)', async () => {
    const { api, changed } = setup(view(), { inbox: [item()], log: [] });
    await screen.findByRole('button', { name: /Annehmen: Login reparieren/ });
    api.getWorkspaceActivity.mockRejectedValueOnce(
      new Error("Error invoking remote method 'shell:workspace.activity': Error: Server down"),
    );
    changed();
    expect(await screen.findByText('Aktivität nicht lesbar: Server down')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Annehmen/ })).toBeNull();
  });

  it('warns when the inbox is full', async () => {
    const inbox = Array.from({ length: 200 }, (_, i) => item({ id: `i${i}`, preview: `t${i}` }));
    setup(view(), { inbox, log: [] });
    expect(
      await screen.findByText('Die Inbox ist voll: Neue Einträge verdrängen die ältesten.'),
    ).toBeVisible();
  });

  it('lists the log newest first and filters by workspace and instance', async () => {
    setup(view(), {
      inbox: [],
      log: [
        logged({ outcome: 'accepted' }),
        logged({
          direction: 'out',
          outcome: 'ran',
          workspace: 'club',
          instance: eve,
          name: 'eve-pc',
        }),
        logged({ outcome: 'denied', preview: 'x' }),
      ],
    });
    const table = await screen.findByRole('table', { name: 'Protokoll' });
    const rows = () => within(table).getAllByRole('row').slice(1);
    expect(rows().map((r) => within(r).getAllByRole('cell')[3]!.textContent)).toEqual([
      'angenommen',
      'ausgeführt',
      'verweigert',
    ]);
    expect(within(rows()[1]!).getByText('ausgehend')).toBeVisible();
    fireEvent.change(screen.getByRole('combobox', { name: 'Workspace' }), {
      target: { value: 'club' },
    });
    expect(rows()).toHaveLength(1);
    fireEvent.change(screen.getByRole('combobox', { name: 'Workspace' }), {
      target: { value: '' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Instanz' }), { target: { value: ben } });
    expect(rows()).toHaveLength(2);
  });
});
