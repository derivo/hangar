import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';
import { setLocale } from '../messages';
import type { ShellState, ThemeSetting } from '../shared';

// jsdom has no modal dialogs; like a browser, focus the first button.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
    this.querySelector('button')?.focus();
  };
});

const state: ShellState = {
  bays: [
    {
      id: 'dev.hangar.agents',
      name: 'Agents',
      icon: 'data:image/svg+xml;base64,PHN2Zy8+',
      badge: 2,
    },
    { id: 'dev.hangar.test', name: 'Test', icon: 'data:image/svg+xml;base64,PHN2Zy8+', badge: 0 },
  ],
  errors: [{ label: 'Kaputt', error: 'id: must be in reverse-domain style' }],
  servers: [],
  shortcuts: [],
  selected: 'dev.hangar.agents',
  available: [
    {
      id: 'dev.hangar.browser',
      name: 'Browser',
      icon: 'data:image/svg+xml;base64,PHN2Zy8+',
    },
  ],
};

const themeApi = (theme: ThemeSetting = 'system') => ({
  getSettings: vi.fn(async () => ({
    updateChannel: 'stable' as const,
    language: 'system' as const,
    theme,
    bays: [],
    baySettings: {},
    shortcuts: [],
  })),
  setTheme: vi.fn(async () => {}),
  addBay: vi.fn(async (_id: string) => {}),
  bayMenu: vi.fn(),
  setModal: vi.fn(),
  probeServer: vi.fn(async (_address: string) => ({ id: 'p1', fingerprint: 'SHA256:abc' })),
  pairServer: vi.fn(async (_probe: string, _name: string, _code: string) => {}),
  cancelProbe: vi.fn(),
  serverMenu: vi.fn(),
  pickShortcut: vi.fn(async (_kind: 'file' | 'folder') => true),
  addUrlShortcut: vi.fn(async (_url: string) => {}),
  openShortcut: vi.fn(),
  shortcutMenu: vi.fn(),
  moveBay: vi.fn(),
  moveShortcut: vi.fn(),
});

describe('Sidebar', () => {
  it('switches the color scheme above the settings: system, light, dark, system', async () => {
    const api = themeApi();
    render(<Sidebar state={state} api={api} onSelect={() => {}} />);
    const toggle = await screen.findByRole('button', {
      name: 'Farbschema: System (wechseln zu Hell)',
    });
    expect(toggle.nextElementSibling).toHaveAccessibleName('Einstellungen');
    await userEvent.click(toggle);
    expect(api.setTheme).toHaveBeenLastCalledWith('light');
    await userEvent.click(
      screen.getByRole('button', { name: 'Farbschema: Hell (wechseln zu Dunkel)' }),
    );
    expect(api.setTheme).toHaveBeenLastCalledWith('dark');
    await userEvent.click(
      screen.getByRole('button', { name: 'Farbschema: Dunkel (wechseln zu System)' }),
    );
    expect(api.setTheme).toHaveBeenLastCalledWith('system');
  });

  it('starts with the saved color scheme', async () => {
    render(<Sidebar state={state} api={themeApi('dark')} onSelect={() => {}} />);
    expect(
      await screen.findByRole('button', { name: 'Farbschema: Dunkel (wechseln zu System)' }),
    ).toBeVisible();
  });

  it('lists every bay with its name and marks the selected one', () => {
    render(<Sidebar state={state} api={themeApi()} onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: 'Agents, 2 Hinweise' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('button', { name: 'Test' })).not.toHaveAttribute('aria-current');
  });

  it('names the badge count in the app language', () => {
    const one = { ...state, bays: [{ ...state.bays[0]!, badge: 1 }] };
    const { unmount } = render(<Sidebar state={one} api={themeApi()} onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: 'Agents, 1 Hinweis' })).toBeVisible();
    unmount();
    setLocale('en');
    try {
      render(<Sidebar state={one} api={themeApi()} onSelect={() => {}} />);
      expect(screen.getByRole('button', { name: 'Agents, 1 notification' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Settings' })).toBeVisible();
    } finally {
      setLocale('de');
    }
  });

  it('opens the Hangar overview from the mark at the top', async () => {
    const onSelect = vi.fn();
    const { rerender } = render(<Sidebar state={state} api={themeApi()} onSelect={onSelect} />);
    const overview = screen.getByRole('button', { name: 'Hangar-Übersicht' });
    await userEvent.click(overview);
    expect(onSelect).toHaveBeenCalledWith('overview');
    rerender(
      <Sidebar state={{ ...state, selected: 'overview' }} api={themeApi()} onSelect={onSelect} />,
    );
    expect(overview).toHaveAttribute('aria-current', 'page');
  });

  it('shows a badge only when the count is positive', () => {
    render(<Sidebar state={state} api={themeApi()} onSelect={() => {}} />);
    expect(screen.getByTestId('badge-dev.hangar.agents')).toHaveTextContent('2');
    expect(screen.queryByTestId('badge-dev.hangar.test')).toBeNull();
  });

  it('caps large badge counts', () => {
    const many = { ...state, bays: [{ ...state.bays[0]!, badge: 120 }] };
    render(<Sidebar state={many} api={themeApi()} onSelect={() => {}} />);
    expect(screen.getByTestId('badge-dev.hangar.agents')).toHaveTextContent('99+');
  });

  it('selects bays and the settings page', async () => {
    const onSelect = vi.fn();
    render(<Sidebar state={state} api={themeApi()} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('button', { name: 'Test' }));
    await userEvent.click(screen.getByRole('button', { name: 'Einstellungen' }));
    expect(onSelect.mock.calls).toEqual([['dev.hangar.test'], ['settings']]);
  });

  it('lists bays that failed to load with their error', () => {
    render(<Sidebar state={state} api={themeApi()} onSelect={() => {}} />);
    expect(
      screen.getByRole('img', { name: 'Kaputt: id: must be in reverse-domain style' }),
    ).toBeVisible();
  });

  it('adds a bay from the picker under the plus (ADR 0017)', async () => {
    const api = themeApi();
    render(<Sidebar state={state} api={api} onSelect={() => {}} />);
    const plus = screen.getByRole('button', { name: 'Zur Leiste hinzufügen' });
    expect(screen.getByRole('button', { name: 'Test' }).compareDocumentPosition(plus)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    await userEvent.click(plus);
    const dialog = screen.getByRole('dialog', { name: 'Zur Leiste hinzufügen' });
    expect(api.setModal).toHaveBeenLastCalledWith(true);
    await userEvent.click(within(dialog).getByRole('button', { name: /Browser/ }));
    expect(api.addBay).toHaveBeenCalledWith('dev.hangar.browser');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.setModal).toHaveBeenLastCalledWith(false);
  });

  it('closes the picker with Escape or Cancel and says when every bay is added', async () => {
    const api = themeApi();
    render(<Sidebar state={{ ...state, available: [] }} api={api} onSelect={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Zur Leiste hinzufügen' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Alle Bays sind schon in der Leiste.');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.setModal).toHaveBeenLastCalledWith(false);

    await userEvent.click(screen.getByRole('button', { name: 'Zur Leiste hinzufügen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows why a bay could not be added and keeps the picker open', async () => {
    const api = themeApi();
    api.addBay.mockRejectedValueOnce(
      new Error("Error invoking remote method 'shell:addBay': Error: Start failed: kaputt"),
    );
    render(<Sidebar state={state} api={api} onSelect={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Zur Leiste hinzufügen' }));
    await userEvent.click(screen.getByRole('button', { name: /Browser/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Start failed: kaputt');
    expect(screen.getByRole('dialog')).toBeVisible();
  });

  it('opens the bay menu on right click', async () => {
    const api = themeApi();
    render(<Sidebar state={state} api={api} onSelect={() => {}} />);
    await userEvent.pointer({
      keys: '[MouseRight]',
      target: screen.getByRole('button', { name: 'Test' }),
    });
    expect(api.bayMenu).toHaveBeenCalledWith('dev.hangar.test');
  });

  it('shows a server with its bays; its button opens the server menu (ADR 0019)', async () => {
    const api = themeApi();
    const onSelect = vi.fn();
    const withServer: ShellState = {
      ...state,
      servers: [
        {
          id: 's1',
          name: 'Heimserver',
          status: 'connected',
          bays: [
            {
              id: 'remote:s1:dev.hangar.agents',
              name: 'Agents',
              icon: 'data:image/svg+xml;base64,PHN2Zy8+',
              badge: 0,
            },
          ],
          errors: [{ label: 'Browser', error: 'Version passt nicht (Server 0.2.0, hier 0.1.0)' }],
        },
        { id: 's2', name: 'Alt', status: 'failed', error: 'Invalid token', bays: [], errors: [] },
      ],
    };
    render(<Sidebar state={withServer} api={api} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('button', { name: 'Agents (Heimserver)' }));
    expect(onSelect).toHaveBeenCalledWith('remote:s1:dev.hangar.agents');
    expect(
      screen.getByRole('img', { name: 'Browser: Version passt nicht (Server 0.2.0, hier 0.1.0)' }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Server Heimserver: verbunden' }));
    expect(api.serverMenu).toHaveBeenCalledWith('s1');
    expect(
      screen.getByRole('button', { name: 'Server Alt: Fehler (Invalid token)' }),
    ).toBeInTheDocument();
  });
});

describe('Sidebar: the local server (ADR 0036)', () => {
  const agents = {
    id: 'remote:loc:dev.hangar.agents',
    name: 'Agents',
    icon: 'data:image/svg+xml;base64,PHN2Zy8+',
    badge: 1,
  };
  it('shows its bays by their name, and says so while it is down', async () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <Sidebar
        state={{ ...state, localServer: { status: 'connected', bays: [agents] } }}
        api={themeApi()}
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Agents, 1 Hinweis' }));
    expect(onSelect).toHaveBeenCalledWith('remote:loc:dev.hangar.agents');
    expect(screen.queryByRole('button', { name: /^Server / })).toBeNull();
    rerender(
      <Sidebar
        state={{ ...state, localServer: { status: 'failed', bays: [{ ...agents, badge: 0 }] } }}
        api={themeApi()}
        onSelect={onSelect}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Agents (Lokaler Server läuft nicht)' }),
    ).toBeInTheDocument();
    rerender(
      <Sidebar
        state={{ ...state, localServer: { status: 'connecting', bays: [{ ...agents, badge: 0 }] } }}
        api={themeApi()}
        onSelect={onSelect}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Agents (Lokaler Server startet …)' }),
    ).toBeInTheDocument();
  });
});

describe('Sidebar: shortcuts (ADR 0027)', () => {
  const withShortcuts: ShellState = {
    ...state,
    shortcuts: [
      {
        id: 'k1',
        name: 'Mail',
        target: '/Applications/Mail.app',
        url: false,
        icon: 'data:image/png;base64,iVBORw0KGgo=',
      },
      { id: 'k2', name: 'example.com', target: 'https://example.com/', url: true },
    ],
  };

  it('lists the shortcuts between the bays and the plus with their target in the tooltip', () => {
    render(<Sidebar state={withShortcuts} api={themeApi()} onSelect={() => {}} />);
    const list = screen.getByRole('list', { name: 'Verknüpfungen' });
    const mail = within(list).getByRole('button', { name: 'Mail öffnen' });
    const web = within(list).getByRole('button', { name: 'example.com öffnen' });
    expect(mail).toHaveAttribute('title', 'Mail\n/Applications/Mail.app');
    expect(mail.querySelector('img')).toHaveAttribute('src', withShortcuts.shortcuts[0]!.icon);
    expect(web.querySelector('img')).toBeNull();
    expect(web.querySelector('svg')).not.toBeNull();
    expect(
      screen.getByRole('button', { name: 'Test' }).compareDocumentPosition(mail) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      web.compareDocumentPosition(screen.getByRole('button', { name: 'Zur Leiste hinzufügen' })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('has no shortcut list while there is none', () => {
    render(<Sidebar state={state} api={themeApi()} onSelect={() => {}} />);
    expect(screen.queryByRole('list', { name: 'Verknüpfungen' })).toBeNull();
  });

  it('opens a shortcut by click, Enter and Space and its menu by right click', async () => {
    const api = themeApi();
    render(<Sidebar state={withShortcuts} api={api} onSelect={() => {}} />);
    const mail = screen.getByRole('button', { name: 'Mail öffnen' });
    await userEvent.click(mail);
    mail.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(api.openShortcut.mock.calls).toEqual([['k1'], ['k1'], ['k1']]);
    await userEvent.pointer({ keys: '[MouseRight]', target: mail });
    expect(api.shortcutMenu).toHaveBeenCalledWith('k1');
    expect(api.openShortcut).toHaveBeenCalledTimes(3);
  });

  it('opens a shortcut once for a double or triple click', async () => {
    const api = themeApi();
    render(<Sidebar state={withShortcuts} api={api} onSelect={() => {}} />);
    const mail = screen.getByRole('button', { name: 'Mail öffnen' });
    await userEvent.dblClick(mail);
    await userEvent.tripleClick(mail);
    expect(api.openShortcut).toHaveBeenCalledTimes(2);
  });

  const open = async (api = themeApi()) => {
    render(<Sidebar state={state} api={api} onSelect={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Zur Leiste hinzufügen' }));
    const dialog = screen.getByRole('dialog', { name: 'Zur Leiste hinzufügen' });
    return { api, dialog, ui: within(dialog) };
  };

  it.each([
    ['Datei oder Programm …', 'file'],
    ['Ordner …', 'folder'],
  ] as const)('adds a path with %j and closes the picker', async (label, kind) => {
    const { api, ui } = await open();
    await userEvent.click(ui.getByRole('button', { name: label }));
    expect(api.pickShortcut).toHaveBeenCalledWith(kind);
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the picker open when the file dialog is cancelled', async () => {
    const api = themeApi();
    api.pickShortcut.mockResolvedValueOnce(false);
    const { ui } = await open(api);
    await userEvent.click(ui.getByRole('button', { name: 'Datei oder Programm …' }));
    await vi.waitFor(() => expect(api.pickShortcut).toHaveBeenCalled());
    expect(screen.getByRole('dialog')).toBeVisible();
  });

  // One wrong value each; the main process checks the scheme (ADR 0027).
  it.each(['', '   '])('needs a website address (%j)', async (text) => {
    const { api, ui } = await open();
    if (text) await userEvent.type(ui.getByLabelText('Webseite'), text);
    await userEvent.click(ui.getByRole('button', { name: 'Webseite hinzufügen' }));
    expect(ui.getByRole('alert')).toHaveTextContent('Adresse fehlt.');
    expect(api.addUrlShortcut).not.toHaveBeenCalled();
  });

  it('names an address without http or https and lets it be corrected', async () => {
    const api = themeApi();
    api.addUrlShortcut.mockRejectedValueOnce(
      new Error("Error invoking remote method 'shell:shortcut.url': Error: Invalid URL"),
    );
    const { ui } = await open(api);
    const field = ui.getByLabelText('Webseite');
    expect(field).toHaveAccessibleDescription(
      'Adresse mit http:// oder https://, z. B. https://example.com',
    );
    await userEvent.type(field, 'example.com');
    await userEvent.click(ui.getByRole('button', { name: 'Webseite hinzufügen' }));
    expect(await ui.findByRole('alert')).toHaveTextContent(
      'Nur Adressen mit http:// oder https:// gehen.',
    );
    expect(screen.getByRole('dialog')).toBeVisible();
    await userEvent.clear(field);
    await userEvent.type(field, 'https://example.com{Enter}');
    expect(api.addUrlShortcut).toHaveBeenLastCalledWith('https://example.com');
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('does not let a late answer close a picker opened again', async () => {
    const api = themeApi();
    let answer!: () => void;
    api.addUrlShortcut.mockReturnValueOnce(new Promise<void>((r) => (answer = r)));
    const { ui } = await open(api);
    await userEvent.type(ui.getByLabelText('Webseite'), 'https://example.com{Enter}');
    await userEvent.click(ui.getByRole('button', { name: 'Abbrechen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Zur Leiste hinzufügen' }));
    await userEvent.type(screen.getByLabelText('Webseite'), 'https://zweite');
    await act(async () => answer());
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByLabelText('Webseite')).toHaveValue('https://zweite');
  });

  it('asks the file dialog and adds a website once while the first answer is pending', async () => {
    const api = themeApi();
    let picked!: (added: boolean) => void;
    api.pickShortcut.mockImplementation(() => new Promise<boolean>((r) => (picked = r)));
    let added!: () => void;
    api.addUrlShortcut.mockImplementation(() => new Promise<void>((r) => (added = r)));
    const { ui } = await open(api);
    const file = ui.getByRole('button', { name: 'Datei oder Programm …' });
    await userEvent.dblClick(file);
    await userEvent.click(ui.getByRole('button', { name: 'Ordner …' }));
    expect(api.pickShortcut.mock.calls).toEqual([['file']]);
    await act(async () => picked(false));
    await userEvent.click(file);
    expect(api.pickShortcut).toHaveBeenCalledTimes(2);
    await act(async () => picked(false));

    await userEvent.type(ui.getByLabelText('Webseite'), 'https://example.com{Enter}{Enter}');
    await userEvent.click(ui.getByRole('button', { name: 'Webseite hinzufügen' }));
    expect(api.addUrlShortcut).toHaveBeenCalledTimes(1);
    await act(async () => added());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lets a picker opened again act while an earlier choice still starts', async () => {
    const api = themeApi();
    api.addBay.mockImplementation(() => new Promise<void>(() => {}));
    const { ui } = await open(api);
    await userEvent.click(ui.getByRole('button', { name: /^Browser/ }));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Zur Leiste hinzufügen' }));
    const again = within(screen.getByRole('dialog', { name: 'Zur Leiste hinzufügen' }));
    await userEvent.type(again.getByLabelText('Webseite'), 'https://example.com{Enter}');
    expect(api.addUrlShortcut).toHaveBeenCalledWith('https://example.com');
  });

  it('adds a website by Enter with the address trimmed', async () => {
    const { api, ui } = await open();
    await userEvent.type(ui.getByLabelText('Webseite'), '  https://example.com/a  {Enter}');
    expect(api.addUrlShortcut).toHaveBeenCalledWith('https://example.com/a');
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('Sidebar: pairing a server (one wrong field each)', () => {
  const open = async (api = themeApi()) => {
    render(<Sidebar state={state} api={api} onSelect={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Zur Leiste hinzufügen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Mit Server verbinden' }));
    const dialog = screen.getByRole('dialog', { name: 'Mit Server verbinden' });
    return { api, dialog, ui: within(dialog) };
  };
  const remote = (message: string) =>
    new Error(`Error invoking remote method 'shell:server.probe': Error: ${message}`);

  it.each(['', '   '])('needs a name (%j)', async (name) => {
    const { api, ui } = await open();
    if (name) await userEvent.type(ui.getByLabelText('Name'), name);
    await userEvent.type(ui.getByLabelText('Adresse'), '127.0.0.1:7420');
    await userEvent.click(ui.getByRole('button', { name: 'Weiter' }));
    expect(ui.getByRole('alert')).toHaveTextContent('Name fehlt.');
    expect(api.probeServer).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('needs an address (%j)', async (address) => {
    const { api, ui } = await open();
    await userEvent.type(ui.getByLabelText('Name'), 'Heimserver');
    if (address) await userEvent.type(ui.getByLabelText('Adresse'), address);
    await userEvent.click(ui.getByRole('button', { name: 'Weiter' }));
    expect(ui.getByRole('alert')).toHaveTextContent('Adresse fehlt.');
    expect(api.probeServer).not.toHaveBeenCalled();
  });

  it('names an invalid address', async () => {
    const api = themeApi();
    api.probeServer.mockRejectedValueOnce(remote('Invalid address: heimserver'));
    const { ui } = await open(api);
    await userEvent.type(ui.getByLabelText('Name'), 'Heimserver');
    await userEvent.type(ui.getByLabelText('Adresse'), 'heimserver');
    await userEvent.click(ui.getByRole('button', { name: 'Weiter' }));
    expect(ui.getByRole('alert')).toHaveTextContent(
      'Adresse ungültig: benutzer@host:port oder 127.0.0.1:port, Port 1–65535.',
    );
  });

  it('names what ssh said when the tunnel fails', async () => {
    const api = themeApi();
    api.probeServer.mockRejectedValueOnce(
      remote('SSH failed: ssh: Could not resolve hostname heimserver'),
    );
    const { ui } = await open(api);
    await userEvent.type(ui.getByLabelText('Name'), 'Heimserver');
    await userEvent.type(ui.getByLabelText('Adresse'), 'anna@heimserver:7420{Enter}');
    expect(api.probeServer).toHaveBeenCalledWith('anna@heimserver:7420');
    expect(ui.getByRole('alert')).toHaveTextContent(
      'SSH-Verbindung fehlgeschlagen (ssh: Could not resolve hostname heimserver). Klappt ssh im Terminal ohne Passwortabfrage?',
    );
  });

  it('says when the server cannot be reached', async () => {
    const api = themeApi();
    api.probeServer.mockRejectedValueOnce(remote('Cannot reach ws://127.0.0.1:9/connect'));
    const { ui } = await open(api);
    await userEvent.type(ui.getByLabelText('Name'), 'Heimserver');
    await userEvent.type(ui.getByLabelText('Adresse'), '127.0.0.1:9');
    await userEvent.click(ui.getByRole('button', { name: 'Weiter' }));
    expect(ui.getByRole('alert')).toHaveTextContent(
      'Server nicht erreichbar. Läuft hangar-server dort mit diesem Port?',
    );
  });

  it.each(['', '   '])('needs the pairing code (%j)', async (code) => {
    const { api, ui } = await open();
    await userEvent.type(ui.getByLabelText('Name'), 'Heimserver');
    await userEvent.type(ui.getByLabelText('Adresse'), '127.0.0.1:7420{Enter}');
    expect(api.probeServer).toHaveBeenCalledWith('127.0.0.1:7420');
    expect(ui.getByText('SHA256:abc')).toBeInTheDocument();
    if (code) await userEvent.type(ui.getByLabelText('Kopplungscode'), code);
    await userEvent.click(ui.getByRole('button', { name: 'Koppeln' }));
    expect(ui.getByRole('alert')).toHaveTextContent('Kopplungscode fehlt.');
    expect(api.pairServer).not.toHaveBeenCalled();
  });

  it('names a wrong pairing code and lets it be corrected', async () => {
    const api = themeApi();
    api.pairServer.mockRejectedValueOnce(remote('Wrong pairing code'));
    const { ui } = await open(api);
    await userEvent.type(ui.getByLabelText('Name'), 'Heimserver');
    await userEvent.type(ui.getByLabelText('Adresse'), '127.0.0.1:7420{Enter}');
    await userEvent.type(ui.getByLabelText('Kopplungscode'), 'WRON-GCOD{Enter}');
    expect(ui.getByRole('alert')).toHaveTextContent('Kopplungscode falsch.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('says when the pairing has ended', async () => {
    const api = themeApi();
    api.pairServer.mockRejectedValueOnce(remote('Pairing has ended'));
    const { ui } = await open(api);
    await userEvent.type(ui.getByLabelText('Name'), 'Heimserver');
    await userEvent.type(ui.getByLabelText('Adresse'), '127.0.0.1:7420{Enter}');
    await userEvent.type(ui.getByLabelText('Kopplungscode'), 'ABCD-EFGH{Enter}');
    expect(ui.getByRole('alert')).toHaveTextContent('Kopplung abgebrochen. Bitte neu verbinden.');
  });

  it('cancels a started pairing', async () => {
    const { api, ui } = await open();
    await userEvent.type(ui.getByLabelText('Name'), 'Heimserver');
    await userEvent.type(ui.getByLabelText('Adresse'), '127.0.0.1:7420{Enter}');
    await userEvent.click(ui.getByRole('button', { name: 'Abbrechen' }));
    expect(api.cancelProbe).toHaveBeenCalledWith('p1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('ends a shown probe when Escape closes the dialog', async () => {
    const { api, ui } = await open();
    await userEvent.type(ui.getByLabelText('Name'), 'Heimserver');
    await userEvent.type(ui.getByLabelText('Adresse'), '127.0.0.1:7420{Enter}');
    expect(ui.getByText('SHA256:abc')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.cancelProbe).toHaveBeenCalledWith('p1');
  });

  it('ends a probe that answers after the dialog closed', async () => {
    const api = themeApi();
    let answer: (p: { id: string; fingerprint: string }) => void = () => {};
    api.probeServer.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const { ui } = await open(api);
    await userEvent.type(ui.getByLabelText('Name'), 'Heimserver');
    await userEvent.type(ui.getByLabelText('Adresse'), '127.0.0.1:7420{Enter}');
    await userEvent.keyboard('{Escape}');
    expect(api.cancelProbe).not.toHaveBeenCalled();
    await act(async () => answer({ id: 'late', fingerprint: 'SHA256:late' }));
    expect(api.cancelProbe).toHaveBeenCalledWith('late');
  });

  it('probes and pairs once when Weiter and Koppeln are pressed again', async () => {
    const api = themeApi();
    let probed!: (p: { id: string; fingerprint: string }) => void;
    api.probeServer.mockImplementation(() => new Promise((r) => (probed = r)));
    let paired!: () => void;
    api.pairServer.mockImplementation(() => new Promise<void>((r) => (paired = r)));
    const { ui } = await open(api);
    await userEvent.type(ui.getByLabelText('Name'), 'Heimserver');
    await userEvent.type(ui.getByLabelText('Adresse'), '127.0.0.1:7420{Enter}{Enter}');
    await userEvent.dblClick(ui.getByRole('button', { name: 'Weiter' }));
    expect(api.probeServer).toHaveBeenCalledTimes(1);
    await act(async () => probed({ id: 'p1', fingerprint: 'SHA256:abc' }));

    await userEvent.type(ui.getByLabelText('Kopplungscode'), 'ABCD-EFGH{Enter}{Enter}');
    await userEvent.dblClick(ui.getByRole('button', { name: 'Koppeln' }));
    expect(api.pairServer).toHaveBeenCalledTimes(1);
    await act(async () => paired());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.cancelProbe).not.toHaveBeenCalled();
  });

  it('takes the second click of a double click on Weiter not as Koppeln when the probe answered fast', async () => {
    const { api, ui } = await open();
    await userEvent.type(ui.getByLabelText('Name'), 'Heimserver');
    await userEvent.type(ui.getByLabelText('Adresse'), '127.0.0.1:7420');
    fireEvent.click(ui.getByRole('button', { name: 'Weiter' }), { detail: 1 });
    await act(async () => {});
    expect(ui.getByText('SHA256:abc')).toBeInTheDocument();
    fireEvent.click(ui.getByRole('button', { name: 'Koppeln' }), { detail: 2 });
    await act(async () => {});
    expect(ui.queryByRole('alert')).toBeNull();
    expect(api.probeServer).toHaveBeenCalledTimes(1);
    expect(api.pairServer).not.toHaveBeenCalled();
  });

  it('lets Weiter be pressed again after a failed probe', async () => {
    const api = themeApi();
    api.probeServer.mockRejectedValueOnce(remote('Cannot reach ws://127.0.0.1:9/connect'));
    const { ui } = await open(api);
    await userEvent.type(ui.getByLabelText('Name'), 'Heimserver');
    await userEvent.type(ui.getByLabelText('Adresse'), '127.0.0.1:9{Enter}');
    expect(await ui.findByRole('alert')).toHaveTextContent('Server nicht erreichbar.');
    await userEvent.click(ui.getByRole('button', { name: 'Weiter' }));
    expect(api.probeServer).toHaveBeenCalledTimes(2);
    expect(await ui.findByText('SHA256:abc')).toBeInTheDocument();
  });

  it('pairs with name, address and code (Enter submits)', async () => {
    const { api, ui } = await open();
    await userEvent.type(ui.getByLabelText('Name'), ' Heimserver ');
    await userEvent.type(ui.getByLabelText('Adresse'), '127.0.0.1:7420{Enter}');
    await userEvent.type(ui.getByLabelText('Kopplungscode'), 'ABCD-EFGH{Enter}');
    expect(api.pairServer).toHaveBeenCalledWith('p1', 'Heimserver', 'ABCD-EFGH');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.cancelProbe).not.toHaveBeenCalled();
  });
});

describe('Sidebar: order (ADR 0038)', () => {
  const agents = {
    id: 'remote:loc:dev.hangar.agents',
    name: 'Agents',
    icon: 'data:image/svg+xml;base64,PHN2Zy8+',
    badge: 0,
  };
  const sorted: ShellState = {
    ...state,
    bays: [
      { ...state.bays[1]!, id: 'dev.hangar.test' },
      { id: 'dev.hangar.browser', name: 'Browser', icon: agents.icon, badge: 0 },
    ],
    localServer: { status: 'connected', bays: [agents] },
    order: ['dev.hangar.browser', 'remote:loc:dev.hangar.agents', 'dev.hangar.test'],
    shortcuts: [
      { id: 'k1', name: 'Mail', target: '/Applications/Mail.app', url: false },
      { id: 'k2', name: 'example.com', target: 'https://example.com/', url: true },
    ],
  };
  const names = () =>
    screen
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'))
      .filter((n) => ['Browser', 'Agents', 'Test'].includes(n!));

  it('shows the bays of the app and of the local server in one order, each with its menu', () => {
    const api = themeApi();
    render(<Sidebar state={sorted} api={api} onSelect={() => {}} />);
    expect(names()).toEqual(['Browser', 'Agents', 'Test']);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Agents' }));
    expect(api.bayMenu).toHaveBeenCalledWith('remote:loc:dev.hangar.agents');
  });

  it('puts a dragged bay where it is dropped and marks the place while dragging', () => {
    const api = themeApi();
    render(<Sidebar state={sorted} api={api} onSelect={() => {}} />);
    const item = (name: string) => screen.getByRole('button', { name }).closest('li')!;
    expect(screen.getByRole('button', { name: 'Browser' })).toHaveAttribute('draggable', 'true');
    fireEvent.dragStart(item('Browser'));
    fireEvent.dragOver(item('Test'));
    expect(item('Test')).toHaveClass('drop-after');
    fireEvent.dragLeave(item('Test'));
    expect(item('Test')).not.toHaveClass('drop-after');
    fireEvent.drop(item('Test'));
    expect(api.moveBay).toHaveBeenCalledWith('dev.hangar.browser', 2);
    fireEvent.dragEnd(item('Browser'));
    // Up: the mark goes before it.
    fireEvent.dragStart(item('Test'));
    fireEvent.dragOver(item('Browser'));
    expect(item('Browser')).toHaveClass('drop-target');
    fireEvent.drop(item('Test'));
    fireEvent.dragEnd(item('Test'));
    expect(api.moveBay).toHaveBeenCalledTimes(1);
  });

  it('keeps shortcuts among themselves', () => {
    const api = themeApi();
    render(<Sidebar state={sorted} api={api} onSelect={() => {}} />);
    const item = (name: string) => screen.getByRole('button', { name }).closest('li')!;
    fireEvent.dragStart(item('example.com öffnen'));
    fireEvent.dragOver(item('Browser'));
    fireEvent.drop(item('Browser'));
    expect(api.moveBay).not.toHaveBeenCalled();
    expect(item('Browser')).not.toHaveClass('drop-target');
    fireEvent.drop(item('Mail öffnen'));
    expect(api.moveShortcut).toHaveBeenCalledWith('k2', 0);
    fireEvent.dragEnd(item('example.com öffnen'));
    // A drop without a drag in progress (a file from the Finder) does nothing.
    fireEvent.dragOver(item('Mail öffnen'));
    fireEvent.drop(item('Mail öffnen'));
    expect(api.moveShortcut).toHaveBeenCalledTimes(1);
  });
});
