import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { FeedsApi } from './api';
import type { Feed, FeedState, Item } from '../main/feeds';

// jsdom has no modal dialogs.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

const settings = { intervalMinutes: 15, maxItems: 1000 };

const RSS = `<rss><channel><title>Blog A</title>
  <item><title>Neu</title><link>https://example.org/neu</link><guid>n</guid></item>
</channel></rss>`;

const feed = (url: string, patch: Partial<Feed> = {}): Feed => ({
  url,
  title: url,
  fetchedAt: '2026-11-04T10:00:00.000Z',
  ...patch,
});
const item = (id: string, patch: Partial<Item> = {}): Item => ({
  id,
  title: `Post ${id}`,
  link: `https://example.org/${id}`,
  summary: `Text ${id}`,
  feedUrl: 'https://example.org/a.xml',
  feedTitle: 'Blog A',
  receivedAt: '2026-11-04T10:00:00.000Z',
  ...patch,
});

function setup(initial: Omit<FeedState, 'settings'> = { feeds: [], items: [] }) {
  const state: FeedState = { ...initial, settings };
  let push: (s: FeedState) => void = () => {};
  const api = {
    state: vi.fn(async () => state),
    add: vi.fn(async (url: string) => feed(url)),
    remove: vi.fn(async () => {}),
    fetch: vi.fn(async () => RSS),
    ingest: vi.fn(async () => []),
    failed: vi.fn(async () => {}),
    onState: (l: (s: FeedState) => void) => ((push = l), () => {}),
    saveSettings: vi.fn(async () => {}),
  } satisfies FeedsApi;
  render(<App api={api} />);
  return {
    api,
    push: (s: Omit<FeedState, 'settings'> & Partial<FeedState>) =>
      act(() => push({ settings, ...s })),
  };
}

describe('feeds UI', () => {
  it('shows the entries in arrival order with a line per day, links open outside', async () => {
    setup({
      feeds: [feed('https://example.org/a.xml', { title: 'Blog A' })],
      items: [
        item('1', { published: '2026-11-01T08:00:00.000Z' }),
        item('2', { link: '', summary: '' }),
        item('3', { receivedAt: '2026-11-05T10:00:00.000Z' }),
      ],
    });
    // The log shows before the state arrives (empty); the entries come with the state at once.
    const log = await screen.findByRole('log', { name: 'Verlauf' });
    const rows = await within(log).findAllByRole('listitem');
    expect(rows.map((r) => r.className)).toEqual(['day', 'entry', 'entry', 'day', 'entry']);
    expect(within(rows[1]!).getByRole('link', { name: 'Post 1' })).toHaveAttribute(
      'target',
      '_blank',
    );
    expect(within(rows[2]!).queryByRole('link')).toBeNull();
    expect(within(rows[2]!).getByText('Post 2')).toBeTruthy();
    expect(within(rows[4]!).getByText('Text 3')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Abonnements' })).toHaveTextContent('Blog A');
  });

  it('fetches every feed at start and stores the parsed entries', async () => {
    const { api } = setup({ feeds: [feed('https://example.org/a.xml')], items: [] });
    await vi.waitFor(() =>
      expect(api.ingest).toHaveBeenCalledWith('https://example.org/a.xml', {
        title: 'Blog A',
        items: [{ id: 'n', title: 'Neu', link: 'https://example.org/neu', summary: '' }],
      }),
    );
    expect(screen.getByText('Noch keine Einträge.')).toBeTruthy();
  });

  it('records a failed fetch without the Electron prefix and shows it on the feed', async () => {
    const { api, push } = setup({ feeds: [feed('https://example.org/a.xml')], items: [] });
    api.fetch.mockRejectedValueOnce(
      new Error("Error invoking remote method 'bay:invoke': Error: HTTP 404"),
    );
    await vi.waitFor(() =>
      expect(api.failed).toHaveBeenCalledWith('https://example.org/a.xml', 'HTTP 404'),
    );
    push({ feeds: [feed('https://example.org/a.xml', { error: 'HTTP 404' })], items: [] });
    expect(screen.getByText('https://example.org/a.xml: HTTP 404')).toBeTruthy();
  });

  it('records a page that is no feed', async () => {
    const { api } = setup({ feeds: [feed('https://example.org/a.xml')], items: [] });
    api.fetch.mockResolvedValueOnce('<html></html>');
    await vi.waitFor(() =>
      expect(api.failed).toHaveBeenCalledWith(
        'https://example.org/a.xml',
        'Kein RSS- oder Atom-Feed',
      ),
    );
  });

  it('fetches a new subscription at once, also one an agent added', async () => {
    const { api, push } = setup();
    await vi.waitFor(() => expect(api.state).toHaveBeenCalled());
    expect(api.fetch).not.toHaveBeenCalled();
    push({ feeds: [feed('https://example.org/b.xml', { fetchedAt: undefined })], items: [] });
    await vi.waitFor(() => expect(api.fetch).toHaveBeenCalledWith('https://example.org/b.xml'));
  });

  it('refreshes all feeds on demand and unsubscribes', async () => {
    const user = userEvent.setup();
    const { api } = setup({
      feeds: [feed('https://example.org/a.xml', { title: 'A' })],
      items: [],
    });
    await vi.waitFor(() => expect(api.ingest).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Aktualisieren' }));
    await vi.waitFor(() => expect(api.ingest).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: 'A abbestellen' }));
    expect(api.remove).toHaveBeenCalledWith('https://example.org/a.xml');
  });

  it('fetches every interval from the settings and follows a change', async () => {
    const set = vi.spyOn(globalThis, 'setInterval');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const feeds = [feed('https://example.org/a.xml')];
    const { push } = setup({ feeds, items: [] });
    await vi.waitFor(() => expect(set).toHaveBeenCalledWith(expect.any(Function), 15 * 60_000));
    push({ feeds, items: [], settings: { intervalMinutes: 5, maxItems: 1000 } });
    expect(set).toHaveBeenLastCalledWith(expect.any(Function), 5 * 60_000);
    expect(clear).toHaveBeenCalled();
    set.mockRestore();
    clear.mockRestore();
  });

  describe('a server bay whose connection is gone', () => {
    const gone = new Error("Error invoking remote method 'bay:invoke': Error: Not connected: s1");
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    beforeEach(() => {
      unhandled.length = 0;
      process.on('unhandledRejection', record);
    });
    afterEach(async () => {
      // Unhandled rejections are reported after the microtasks of the current turn.
      await new Promise((r) => setTimeout(r, 0));
      process.off('unhandledRejection', record);
      expect(unhandled).toEqual([]);
    });

    it('shows the error when the state does not load at start', async () => {
      const { api } = setup();
      const start = { ...api, state: vi.fn(() => Promise.reject(gone)) };
      cleanup();
      render(<App api={start} />);
      expect(await screen.findByRole('alert')).toHaveTextContent('Not connected: s1');
    });

    it('shows the error on the interval and on unsubscribe', async () => {
      const user = userEvent.setup();
      const set = vi.spyOn(globalThis, 'setInterval');
      try {
        const { api } = setup({ feeds: [feed('https://example.org/a.xml')], items: [] });
        await vi.waitFor(() => expect(set).toHaveBeenCalled());
        api.state.mockRejectedValueOnce(gone);
        await act(async () => (set.mock.lastCall![0] as () => void)());
        expect(screen.getByRole('alert')).toHaveTextContent('Not connected: s1');
        api.remove.mockRejectedValueOnce(new Error('Error: Connection closed'));
        await user.click(screen.getByRole('button', { name: /abbestellen|unsubscribe/i }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Connection closed');
      } finally {
        set.mockRestore();
      }
    });
  });

  describe('subscribe form', () => {
    const error = (message: string) =>
      new Error(`Error invoking remote method 'bay:invoke': Error: ${message}`);

    it('shows the error for an empty URL', async () => {
      const user = userEvent.setup();
      const { api } = setup();
      api.add.mockRejectedValueOnce(error('Ungültige Feed-URL (nur http und https)'));
      await user.click(screen.getByRole('button', { name: 'Abonnieren' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Ungültige Feed-URL (nur http und https)',
      );
      expect(api.add).toHaveBeenCalledWith('');
    });

    it('shows the error for an invalid URL and keeps the input', async () => {
      const user = userEvent.setup();
      const { api } = setup();
      api.add.mockRejectedValueOnce(error('Ungültige Feed-URL (nur http und https)'));
      await user.type(screen.getByLabelText('Feed-URL'), 'ftp://x');
      await user.click(screen.getByRole('button', { name: 'Abonnieren' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Ungültige Feed-URL (nur http und https)',
      );
      expect(screen.getByLabelText('Feed-URL')).toHaveValue('ftp://x');
    });

    it('shows the error for a feed already subscribed', async () => {
      const user = userEvent.setup();
      const { api } = setup();
      api.add.mockRejectedValueOnce(error('Feed ist schon abonniert'));
      await user.type(screen.getByLabelText('Feed-URL'), 'https://example.org/a.xml');
      await user.click(screen.getByRole('button', { name: 'Abonnieren' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Feed ist schon abonniert');
    });

    it('subscribes with Enter, clears the input and the error', async () => {
      const user = userEvent.setup();
      const { api } = setup();
      api.add.mockRejectedValueOnce(error('Feed ist schon abonniert'));
      await user.click(screen.getByRole('button', { name: 'Abonnieren' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Feed ist schon abonniert');
      await user.type(screen.getByLabelText('Feed-URL'), 'https://example.org/b.xml{Enter}');
      await vi.waitFor(() => expect(api.add).toHaveBeenLastCalledWith('https://example.org/b.xml'));
      await vi.waitFor(() => expect(screen.getByLabelText('Feed-URL')).toHaveValue(''));
      expect(screen.getByRole('alert')).toHaveTextContent('');
    });
  });

  describe('settings dialog', () => {
    const error = (message: string) =>
      new Error(`Error invoking remote method 'bay:invoke': Error: ${message}`);
    const open = async () => {
      const user = userEvent.setup();
      const result = setup();
      await user.click(await screen.findByRole('button', { name: 'Einstellungen' }));
      const dialog = screen.getByRole('dialog', { name: 'Einstellungen' });
      return { ...result, user, dialog };
    };

    it('opens from the gear with the values, focus on the first field; Esc closes', async () => {
      const { user, dialog } = await open();
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      const form = within(dialog).getByRole('form', { name: 'Feed-Einstellungen' });
      expect(within(form).getByRole('group', { name: 'Abruf' })).toBeTruthy();
      expect(within(form).getByRole('group', { name: 'Verlauf' })).toBeTruthy();
      const interval = within(dialog).getByLabelText('Abruf-Intervall (Minuten)');
      expect(interval).toHaveFocus();
      expect(interval).toHaveValue(15);
      expect(within(dialog).getByLabelText('Einträge im Verlauf')).toHaveValue(1000);
      expect(
        within(dialog).getByText('100 bis 10000. Ältere Einträge fallen heraus.'),
      ).toBeTruthy();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('button', { name: 'Einstellungen' })).toHaveFocus();
    });

    it('closes with Abbrechen and on the backdrop without saving', async () => {
      const { user, dialog, api } = await open();
      await user.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('button', { name: 'Einstellungen' })).toHaveFocus();
      await user.click(screen.getByRole('button', { name: 'Einstellungen' }));
      await user.click(screen.getByRole('dialog'));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(api.saveSettings).not.toHaveBeenCalled();
    });

    it('shows the message for an invalid interval and stays open', async () => {
      const { user, dialog, api } = await open();
      api.saveSettings.mockRejectedValueOnce(
        error('Abruf-Intervall: ganze Zahl von 1 bis 1440 Minuten'),
      );
      await user.clear(within(dialog).getByLabelText('Abruf-Intervall (Minuten)'));
      await user.click(within(dialog).getByRole('button', { name: 'Speichern' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'Abruf-Intervall: ganze Zahl von 1 bis 1440 Minuten',
      );
      expect(api.saveSettings).toHaveBeenCalledWith({ intervalMinutes: NaN, maxItems: 1000 });
      expect(screen.getByRole('dialog')).toBeTruthy();
    });

    it('shows the message for an invalid history size and stays open', async () => {
      const { user, dialog, api } = await open();
      api.saveSettings.mockRejectedValueOnce(
        error('Verlauf: ganze Zahl von 100 bis 10000 Einträgen'),
      );
      const max = within(dialog).getByLabelText('Einträge im Verlauf');
      await user.clear(max);
      await user.type(max, '99');
      await user.click(within(dialog).getByRole('button', { name: 'Speichern' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'Verlauf: ganze Zahl von 100 bis 10000 Einträgen',
      );
      expect(api.saveSettings).toHaveBeenCalledWith({ intervalMinutes: 15, maxItems: 99 });
    });

    it('saves with Enter as numbers and closes', async () => {
      const { user, dialog, api } = await open();
      const interval = within(dialog).getByLabelText('Abruf-Intervall (Minuten)');
      await user.clear(interval);
      await user.type(interval, '5{Enter}');
      await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(api.saveSettings).toHaveBeenCalledWith({ intervalMinutes: 5, maxItems: 1000 });
    });

    it('a save that ends after the dialog was closed leaves a reopened dialog open', async () => {
      const { user, dialog, api } = await open();
      let finish!: () => void;
      api.saveSettings.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)));
      await user.click(within(dialog).getByRole('button', { name: 'Speichern' }));
      await user.keyboard('{Escape}');
      await user.click(screen.getByRole('button', { name: 'Einstellungen' }));
      await act(async () => finish());
      expect(screen.getByRole('dialog', { name: 'Einstellungen' })).toBeTruthy();
    });

    it('saves with the button as numbers and closes', async () => {
      const { user, dialog, api } = await open();
      const max = within(dialog).getByLabelText('Einträge im Verlauf');
      await user.clear(max);
      await user.type(max, '200');
      await user.click(within(dialog).getByRole('button', { name: 'Speichern' }));
      await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(api.saveSettings).toHaveBeenCalledWith({ intervalMinutes: 15, maxItems: 200 });
      expect(screen.getByRole('button', { name: 'Einstellungen' })).toHaveFocus();
    });
  });
});
