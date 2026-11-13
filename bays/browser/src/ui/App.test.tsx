import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { BrowserApi } from './api';
import type { PageError } from '@hangar/sdk';
import type { BrowserState, TabView } from '../main/types';

beforeAll(() => {
  globalThis.ResizeObserver = class {
    constructor(private readonly cb: () => void) {}
    observe() {
      this.cb();
    }
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const tab = (id: string, patch: Partial<TabView> = {}): TabView => ({
  id,
  url: `https://${id}.test/`,
  title: `Seite ${id}`,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  partition: 'user',
  owner: 'user',
  ...patch,
});

function setup(initial: BrowserState = { tabs: [] }) {
  let push: (s: BrowserState) => void = () => {};
  let findRequest: (id: string) => void = () => {};
  const api = {
    state: vi.fn(async () => initial),
    open: vi.fn(async () => 'new'),
    navigate: vi.fn(async () => {}),
    back: vi.fn(async () => {}),
    forward: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    resetZoom: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    onState: (l: (s: BrowserState) => void) => ((push = l), () => {}),
    show: vi.fn(async () => {}),
    errors: vi.fn(async (_id: string): Promise<PageError[]> => []),
    find: vi.fn(async (_id: string, _text: string, _options?: object) => {}),
    stopFind: vi.fn(async (_id: string) => {}),
    focus: vi.fn(async (_id: string) => {}),
    onFind: (l: (id: string) => void) => ((findRequest = l), () => {}),
    openExternal: vi.fn((_url: string) => {}),
    trustCertificate: vi.fn(
      async (_id: string, _shown: { host: string; fingerprint: string }) => {},
    ),
  } satisfies BrowserApi;
  render(<App api={api} />);
  return {
    api,
    push: (s: BrowserState) => act(() => push(s)),
    requestFind: (id: string) => act(() => findRequest(id)),
  };
}

const address = () => screen.getByRole('textbox', { name: 'Adresse' });

describe('address bar', () => {
  it.each([
    ['', 'Adresse eingeben.'],
    ['   ', 'Adresse eingeben.'],
    ['file:///etc/passwd', 'Nur http- und https-Adressen lassen sich öffnen.'],
    ['javascript:alert(1)', 'Nur http- und https-Adressen lassen sich öffnen.'],
    ['zwei wörter', 'Nur http- und https-Adressen lassen sich öffnen.'],
  ])('rejects %j with the button', async (input, message) => {
    const { api } = setup();
    await userEvent.clear(address());
    if (input) await userEvent.type(address(), input);
    await userEvent.click(screen.getByRole('button', { name: 'Öffnen' }));

    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(address()).toHaveAttribute('aria-invalid', 'true');
    expect(address()).toHaveAccessibleDescription(message);
    expect(api.open).not.toHaveBeenCalled();
  });

  it('rejects an invalid address with Enter too', async () => {
    const { api } = setup();
    await userEvent.type(address(), 'file:///x{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Nur http- und https-Adressen lassen sich öffnen.',
    );
    expect(api.open).not.toHaveBeenCalled();
  });

  it('shows an error from Hangar', async () => {
    const { api } = setup();
    api.open.mockRejectedValueOnce(
      new Error("Error invoking remote method 'bay:invoke': Error: kaputt"),
    );
    await userEvent.type(address(), 'a.test{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('kaputt');
  });

  it('opens a new tab with Enter when none is open and selects it', async () => {
    const { api, push } = setup();
    expect(screen.getByText(/Kein Tab offen/)).toBeInTheDocument();
    await userEvent.type(address(), 'localhost:5173{Enter}');

    expect(api.open).toHaveBeenCalledWith('http://localhost:5173');
    push({ tabs: [tab('new', { url: 'http://localhost:5173/' })] });
    expect(screen.getByRole('button', { name: 'Seite new' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(address()).toHaveValue('http://localhost:5173/');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('loads an address in the selected tab', async () => {
    const { api } = setup({ tabs: [tab('a')] });
    await screen.findByDisplayValue('https://a.test/');
    await userEvent.clear(address());
    await userEvent.type(address(), 'b.test{Enter}');
    expect(api.navigate).toHaveBeenCalledWith('a', 'https://b.test');
  });
});

describe('tabs', () => {
  it('shows the selected tab over the page area and hides it without tabs', async () => {
    const { api, push } = setup({ tabs: [tab('a'), tab('b')] });
    await screen.findByDisplayValue('https://a.test/');
    expect(api.show).toHaveBeenLastCalledWith('a', { x: 0, y: 0, width: 0, height: 0 });

    await userEvent.click(screen.getByRole('button', { name: 'Seite b' }));
    expect(api.show).toHaveBeenLastCalledWith('b', expect.any(Object));
    expect(address()).toHaveValue('https://b.test/');

    push({ tabs: [] });
    expect(api.show).toHaveBeenLastCalledWith(undefined);
  });

  it('ignores a tab that closed in the main process before it was shown (the next state follows)', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { api, push } = setup({ tabs: [tab('a')] });
      await screen.findByDisplayValue('https://a.test/');
      // A plain function: vi.fn handles the promises it returns itself.
      const shown: unknown[] = [];
      (api as { show: unknown }).show = (id: unknown) => {
        shown.push(id);
        return Promise.reject(new Error('Unknown tab "b"'));
      };
      push({ tabs: [tab('b')] });
      expect(shown).toEqual(['b']);
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).toBeNull();

      // Any other error still surfaces.
      (api as { show: unknown }).show = () => Promise.reject(new Error('Invalid tab placement'));
      push({ tabs: [tab('c')] });
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Invalid tab placement' }),
        expect.anything(),
      );
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('selects another tab when the selected one closes', async () => {
    const { api, push } = setup({ tabs: [tab('a'), tab('b')] });
    await userEvent.click(await screen.findByRole('button', { name: 'Tab Seite a schließen' }));
    expect(api.close).toHaveBeenCalledWith('a');
    push({ tabs: [tab('b')] });
    expect(screen.getByRole('button', { name: 'Seite b' })).toHaveAttribute('aria-current', 'page');
  });

  it('marks agent tabs, loading and errors', async () => {
    const { push } = setup();
    push({
      tabs: [
        tab('a', { owner: 'agent', partition: 'session-x', title: '', url: 'about:blank' }),
        tab('b', { loading: true }),
      ],
    });
    const agentTab = screen.getByRole('button', { name: 'Agent about:blank' });
    expect(within(agentTab).getByText('Agent')).toHaveAttribute(
      'title',
      'Von einem Agent geöffnet, mit eigenen Cookies',
    );
    expect(screen.getByRole('status')).toBeEmptyDOMElement();

    await userEvent.click(screen.getByRole('button', { name: 'Seite b' }));
    expect(screen.getByRole('status')).toHaveTextContent('Lädt …');
    push({ tabs: [tab('a'), tab('b', { error: 'ERR_CONNECTION_REFUSED' })] });
    expect(screen.getByRole('alert')).toHaveTextContent('ERR_CONNECTION_REFUSED');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('goes back, forward and reloads the selected tab', async () => {
    const { api } = setup({ tabs: [tab('a', { canGoBack: true, canGoForward: true })] });
    await screen.findByDisplayValue('https://a.test/');
    await userEvent.click(screen.getByRole('button', { name: 'Zurück' }));
    await userEvent.click(screen.getByRole('button', { name: 'Vorwärts' }));
    await userEvent.click(screen.getByRole('button', { name: 'Neu laden' }));
    expect(api.back).toHaveBeenCalledWith('a');
    expect(api.forward).toHaveBeenCalledWith('a');
    expect(api.reload).toHaveBeenCalledWith('a');
  });

  it('shows the page zoom of the selected tab and resets it to 100 %', async () => {
    const { api, push } = setup({ tabs: [tab('a', { zoom: 110 }), tab('b')] });
    const zoom = await screen.findByRole('button', { name: /^110 %/ });
    expect(zoom).toHaveTextContent('110 %');
    expect(zoom).toHaveAccessibleName('110 % – Zoom auf 100 % zurücksetzen');
    await userEvent.click(zoom);
    expect(api.resetZoom).toHaveBeenCalledWith('a');
    push({ tabs: [tab('a'), tab('b')] });
    expect(screen.queryByRole('button', { name: /Zoom/ })).toBeNull();
  });

  it('disables back and forward without history and the toolbar without a tab', async () => {
    const { push } = setup({ tabs: [tab('a')] });
    await screen.findByDisplayValue('https://a.test/');
    expect(screen.getByRole('button', { name: 'Zurück' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Vorwärts' })).toBeDisabled();
    push({ tabs: [] });
    expect(screen.getByRole('button', { name: 'Neu laden' })).toBeDisabled();
  });

  it('opens a new tab from the new-tab button', async () => {
    const { api } = setup({ tabs: [tab('a')] });
    await screen.findByDisplayValue('https://a.test/');
    await userEvent.click(screen.getByRole('button', { name: 'Neuer Tab' }));

    expect(address()).toHaveValue('');
    expect(address()).toHaveFocus();
    expect(api.show).toHaveBeenLastCalledWith(undefined);
    await userEvent.type(address(), 'c.test{Enter}');
    expect(api.open).toHaveBeenCalledWith('https://c.test');
    expect(api.navigate).not.toHaveBeenCalled();
  });
});

describe('the same button again before the answer', () => {
  it('opens one tab for repeated Öffnen and Enter', async () => {
    const { api } = setup();
    let finish!: (id: string) => void;
    api.open.mockImplementation(() => new Promise<string>((r) => (finish = r)));
    await userEvent.type(address(), 'a.test{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Öffnen' }));
    await userEvent.type(address(), '{Enter}');
    expect(api.open).toHaveBeenCalledTimes(1);

    await act(async () => finish('new'));
    await userEvent.click(screen.getByRole('button', { name: 'Neuer Tab' }));
    await userEvent.type(address(), 'b.test{Enter}');
    expect(api.open).toHaveBeenCalledTimes(2);
  });

  it('opens one tab for a double click on Öffnen even when the first answer came already', async () => {
    const { api } = setup();
    await userEvent.type(address(), 'a.test');
    const open = screen.getByRole('button', { name: 'Öffnen' });
    fireEvent.click(open, { detail: 1 });
    await act(async () => {});
    fireEvent.click(open, { detail: 2 });
    await act(async () => {});
    expect(api.open).toHaveBeenCalledTimes(1);
  });

  it('closes a tab once and shows why closing failed', async () => {
    const { api } = setup({ tabs: [tab('a')] });
    let fail!: (e: Error) => void;
    api.close.mockImplementation(() => new Promise<void>((_r, reject) => (fail = reject)));
    const close = await screen.findByRole('button', { name: 'Tab Seite a schließen' });
    await userEvent.dblClick(close);
    await userEvent.click(close);
    expect(api.close).toHaveBeenCalledTimes(1);

    await act(async () =>
      fail(new Error('Error invoking remote method \'bay:invoke\': Error: Unknown tab "a"')),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Unknown tab "a"');
  });

  it.each(['Zurück', 'Vorwärts', 'Neu laden'])('shows a failed %s', async (name) => {
    const { api } = setup({ tabs: [tab('a', { canGoBack: true, canGoForward: true })] });
    await screen.findByDisplayValue('https://a.test/');
    const call = { Zurück: api.back, Vorwärts: api.forward, 'Neu laden': api.reload }[name]!;
    call.mockRejectedValueOnce(new Error('Unknown tab "a"'));
    await userEvent.click(screen.getByRole('button', { name }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Unknown tab "a"');
  });

  // jsdom moves no tab into place: this checks the second click of the double click itself.
  it('closes one tab for a double click', async () => {
    const { api } = setup({ tabs: [tab('a'), tab('b')] });
    await userEvent.dblClick(await screen.findByRole('button', { name: 'Tab Seite a schließen' }));
    expect(api.close.mock.calls).toEqual([['a']]);
  });

  it('loads in another tab and opens a new one while a tab still navigates', async () => {
    const { api } = setup({ tabs: [tab('a'), tab('b')] });
    api.navigate.mockImplementationOnce(() => new Promise<void>(() => {}));
    await screen.findByDisplayValue('https://a.test/');
    await userEvent.clear(address());
    await userEvent.type(address(), 'slow.test{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Seite b' }));
    await userEvent.clear(address());
    await userEvent.type(address(), 'b2.test{Enter}');
    expect(api.navigate).toHaveBeenLastCalledWith('b', 'https://b2.test');
    await userEvent.click(screen.getByRole('button', { name: 'Neuer Tab' }));
    await userEvent.type(address(), 'c.test{Enter}');
    expect(api.open).toHaveBeenCalledWith('https://c.test');
  });
});

describe('errors of the page (ADR 0042)', () => {
  it('replaces a page that failed to load by an error page with reload and open outside', async () => {
    const { api } = setup({
      tabs: [tab('a', { error: 'ERR_CERT_AUTHORITY_INVALID', url: 'https://self.test/' })],
    });
    const alert = await screen.findByRole('alert');
    expect(api.show).toHaveBeenLastCalledWith(undefined);
    expect(within(alert).getByRole('heading')).toHaveTextContent(
      'Seite konnte nicht geladen werden',
    );
    expect(alert).toHaveTextContent('ERR_CERT_AUTHORITY_INVALID');
    expect(alert).toHaveTextContent('https://self.test/');
    expect(alert).toHaveTextContent(
      'Das Zertifikat der Seite ist nicht vertrauenswürdig, zum Beispiel selbst signiert.',
    );
    await userEvent.click(within(alert).getByRole('button', { name: 'Neu laden' }));
    expect(api.reload).toHaveBeenCalledWith('a');
    await userEvent.click(within(alert).getByRole('button', { name: 'Im Browser öffnen' }));
    expect(api.openExternal).toHaveBeenCalledWith('https://self.test/');
  });

  it('lets the person trust the refused certificate of the host (ADR 0043)', async () => {
    const certificate = { host: 'self.test', fingerprint: 'sha256/abc=' };
    const { api } = setup({
      tabs: [
        tab('a', { error: 'ERR_CERT_AUTHORITY_INVALID', url: 'https://self.test/', certificate }),
      ],
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Zertifikat von self.test: sha256/abc=');
    expect(alert).toHaveTextContent(
      'Hangar vertraut ihm bis zum Beenden, auch in Tabs von Agenten.',
    );
    await userEvent.click(within(alert).getByRole('button', { name: 'Diesem Host vertrauen' }));
    expect(api.trustCertificate).toHaveBeenCalledWith('a', certificate);
  });

  it('shows why trusting failed', async () => {
    const certificate = { host: 'self.test', fingerprint: 'sha256/abc=' };
    const { api } = setup({
      tabs: [tab('a', { error: 'ERR_CERT_DATE_INVALID', url: 'https://self.test/', certificate })],
    });
    api.trustCertificate.mockRejectedValueOnce(new Error('No refused certificate in this tab'));
    await userEvent.click(await screen.findByRole('button', { name: 'Diesem Host vertrauen' }));
    expect(await screen.findByText('No refused certificate in this tab')).toBeInTheDocument();
  });

  it('offers no trust without a refused certificate', async () => {
    setup({ tabs: [tab('a', { error: 'ERR_CERT_AUTHORITY_INVALID', url: 'https://self.test/' })] });
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Diesem Host vertrauen' })).toBeNull();
  });

  it('gives no certificate hint for other load errors', async () => {
    setup({ tabs: [tab('a', { error: 'ERR_CONNECTION_REFUSED' })] });
    expect(await screen.findByRole('alert')).not.toHaveTextContent('Zertifikat');
  });

  it('marks tabs with errors in the tab bar', async () => {
    setup({ tabs: [tab('a', { errors: 3 }), tab('b', { error: 'ERR_FAILED' }), tab('c')] });
    expect(await screen.findByRole('button', { name: 'Seite a (3 Fehler)' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Seite b (Laden fehlgeschlagen)' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Seite c' })).toBeInTheDocument();
  });

  it('names an HTTP error status of the page, which stays visible', async () => {
    const { api } = setup({ tabs: [tab('a', { status: 500, errors: 1 })] });
    expect(await screen.findByText('Die Seite antwortet mit HTTP 500.')).toHaveClass('error');
    expect(api.show).toHaveBeenLastCalledWith('a', expect.any(Object));
  });

  it('lists the errors in a panel, warnings only when asked for, and updates it', async () => {
    const entry = (patch: Partial<PageError>): PageError => ({
      time: new Date(2026, 10, 12, 9, 5, 7).getTime(),
      kind: 'console',
      level: 'error',
      message: 'boom',
      ...patch,
    });
    const { api, push } = setup({ tabs: [tab('a', { errors: 1 })] });
    api.errors.mockResolvedValue([
      entry({ source: 'https://a.test/app.js', line: 12 }),
      entry({ level: 'warning', message: 'deprecated' }),
    ]);
    const toggle = await screen.findByRole('button', { name: 'Fehler (1)' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = screen.getByRole('region', { name: 'Fehler der Seite' });
    expect(await within(panel).findByText('boom')).toBeInTheDocument();
    expect(panel).toHaveTextContent('09:05:07');
    expect(panel).toHaveTextContent('Konsole');
    expect(panel).toHaveTextContent('https://a.test/app.js:12');
    expect(within(panel).queryByText('deprecated')).toBeNull();
    await userEvent.click(within(panel).getByRole('checkbox', { name: 'Warnungen anzeigen' }));
    expect(within(panel).getByText('deprecated')).toBeInTheDocument();

    api.errors.mockResolvedValue([entry({ kind: 'request', message: 'HTTP 404' })]);
    push({ tabs: [tab('a', { errors: 1 })] });
    expect(await within(panel).findByText('HTTP 404')).toBeInTheDocument();
    expect(panel).toHaveTextContent('Anfrage');
    expect(api.errors).toHaveBeenLastCalledWith('a');

    api.errors.mockResolvedValue([]);
    push({ tabs: [tab('a')] });
    expect(await within(panel).findByText('Keine Fehler auf dieser Seite.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fehler' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Fehler' }));
    expect(screen.queryByRole('region', { name: 'Fehler der Seite' })).toBeNull();
  });
});

describe('open in the system browser (ADR 0042)', () => {
  it('opens the page of the selected tab outside Hangar', async () => {
    const { api } = setup({ tabs: [tab('a')] });
    await screen.findByDisplayValue('https://a.test/');
    await userEvent.click(screen.getByRole('button', { name: 'Im Browser öffnen' }));
    expect(api.openExternal).toHaveBeenCalledWith('https://a.test/');
  });

  it('is off without a tab and for about:blank', async () => {
    const { push } = setup();
    expect(screen.getByRole('button', { name: 'Im Browser öffnen' })).toBeDisabled();
    push({ tabs: [tab('a', { url: 'about:blank' })] });
    expect(screen.getByRole('button', { name: 'Im Browser öffnen' })).toBeDisabled();
  });
});

describe('find in page (ADR 0042)', () => {
  // As the bay checks it: by the platform the page reports (jsdom: not a Mac).
  const mac = navigator.platform.startsWith('Mac');
  const mod = mac ? '{Meta>}' : '{Control>}';
  const modUp = mac ? '{/Meta}' : '{/Control}';
  const field = () => screen.getByRole('searchbox', { name: 'Auf der Seite suchen' });

  async function openBar() {
    const fake = setup({ tabs: [tab('a'), tab('b')] });
    await screen.findByDisplayValue('https://a.test/');
    await userEvent.keyboard(`${mod}f${modUp}`);
    return fake;
  }

  it('opens with Cmd/Ctrl+F in the bay and searches while typing', async () => {
    const { api } = await openBar();
    expect(field()).toHaveFocus();
    await userEvent.type(field(), 'Ha');
    expect(api.find).toHaveBeenLastCalledWith('a', 'Ha');
  });

  it('opens when the person presses Cmd/Ctrl+F in the page', async () => {
    const { requestFind } = setup({ tabs: [tab('a')] });
    await screen.findByDisplayValue('https://a.test/');
    requestFind('a');
    expect(field()).toHaveFocus();
  });

  it('shows the result, and no matches with its own text', async () => {
    const { push } = await openBar();
    await userEvent.type(field(), 'Hangar');
    push({ tabs: [tab('a', { find: { active: 3, matches: 17 } }), tab('b')] });
    expect(screen.getByText('3/17')).toBeInTheDocument();
    push({ tabs: [tab('a', { find: { active: 0, matches: 0 } }), tab('b')] });
    expect(screen.getByText('Keine Treffer')).toBeInTheDocument();
  });

  it('goes to the next match with Enter, Cmd/Ctrl+G and the button', async () => {
    const { api } = await openBar();
    await userEvent.type(field(), 'x{Enter}');
    expect(api.find).toHaveBeenLastCalledWith('a', 'x', { forward: true, next: true });
    api.find.mockClear();
    await userEvent.keyboard(`${mod}g${modUp}`);
    await userEvent.click(screen.getByRole('button', { name: 'Nächster Treffer' }));
    expect(api.find.mock.calls).toEqual([
      ['a', 'x', { forward: true, next: true }],
      ['a', 'x', { forward: true, next: true }],
    ]);
  });

  it('goes to the previous match with Shift+Enter, Shift+Cmd/Ctrl+G and the button', async () => {
    const { api } = await openBar();
    await userEvent.type(field(), 'x{Shift>}{Enter}{/Shift}');
    expect(api.find).toHaveBeenLastCalledWith('a', 'x', { forward: false, next: true });
    api.find.mockClear();
    await userEvent.keyboard(`{Shift>}${mod}g${modUp}{/Shift}`);
    await userEvent.click(screen.getByRole('button', { name: 'Vorheriger Treffer' }));
    expect(api.find.mock.calls).toEqual([
      ['a', 'x', { forward: false, next: true }],
      ['a', 'x', { forward: false, next: true }],
    ]);
  });

  it('does not search for an empty field: Enter does nothing, clearing stops the search', async () => {
    const { api } = await openBar();
    await userEvent.keyboard('{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Nächster Treffer' }));
    expect(api.find).not.toHaveBeenCalled();
    await userEvent.type(field(), 'x{Backspace}');
    expect(api.stopFind).toHaveBeenLastCalledWith('a');
  });

  it('closes with Esc and the close button, stops the search and gives the page the focus', async () => {
    const { api } = await openBar();
    await userEvent.type(field(), 'x{Escape}');
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(api.stopFind).toHaveBeenLastCalledWith('a');
    expect(api.focus).toHaveBeenLastCalledWith('a');
    api.stopFind.mockClear();
    api.focus.mockClear();
    await userEvent.keyboard(`${mod}f${modUp}`);
    await userEvent.click(screen.getByRole('button', { name: 'Suche schließen' }));
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(api.stopFind).toHaveBeenLastCalledWith('a');
    expect(api.focus).toHaveBeenLastCalledWith('a');
  });

  it('takes Esc and Cmd/Ctrl+G on its buttons too (Codex)', async () => {
    const { api } = await openBar();
    await userEvent.type(field(), 'x');
    screen.getByRole('button', { name: 'Nächster Treffer' }).focus();
    api.find.mockClear();
    await userEvent.keyboard(`${mod}g${modUp}`);
    expect(api.find.mock.calls).toEqual([['a', 'x', { forward: true, next: true }]]);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('leaves Enter on its buttons to the buttons (Codex)', async () => {
    const { api } = await openBar();
    await userEvent.type(field(), 'x');
    api.find.mockClear();
    screen.getByRole('button', { name: 'Vorheriger Treffer' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(api.find.mock.calls).toEqual([['a', 'x', { forward: false, next: true }]]);
    screen.getByRole('button', { name: 'Suche schließen' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('gives the focus to nobody when another tab is selected: the click has it', async () => {
    const { api } = await openBar();
    await userEvent.click(screen.getByRole('button', { name: 'Seite b' }));
    expect(api.focus).not.toHaveBeenCalled();
  });

  it('closes and stops when another tab is selected', async () => {
    const { api } = await openBar();
    await userEvent.type(field(), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Seite b' }));
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(api.stopFind).toHaveBeenLastCalledWith('a');
    // Back on a: the bar stays closed and takes no focus from the page (OpenCode).
    await userEvent.click(screen.getByRole('button', { name: 'Seite a' }));
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('stays quiet when the tab is gone during a call (OpenCode)', async () => {
    const { api } = await openBar();
    // Plain functions: a rejection of a vi.fn never counts as unhandled.
    const gone = () => Promise.reject(new Error('Unknown tab "a"'));
    Object.assign(api, { find: gone, stopFind: gone, errors: gone });
    await userEvent.type(field(), 'x');
    await userEvent.keyboard('{Enter}');
    await userEvent.clear(field());
    await userEvent.click(screen.getByRole('button', { name: /^Fehler/ }));
    expect(await screen.findByRole('region', { name: 'Fehler der Seite' })).toBeVisible();
  });
});
