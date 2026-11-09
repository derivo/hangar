import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { BrowserApi } from './api';
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
  } satisfies BrowserApi;
  render(<App api={api} />);
  return { api, push: (s: BrowserState) => act(() => push(s)) };
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
    expect(screen.getByRole('status')).toHaveTextContent(
      'Laden fehlgeschlagen: ERR_CONNECTION_REFUSED',
    );
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
