import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Catalog, CatalogEntry, PreparedBay } from '../shared';
import { BayCatalog } from './BayCatalog';

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id: 'dev.hangar.notes',
  available: '1.0.0',
  rollbackLosesData: false,
  canInstall: true,
  canRollback: false,
  ...over,
});

const prepared: PreparedBay = {
  token: 'tok',
  id: 'dev.hangar.notes',
  version: '1.1.0',
  name: 'Notizen',
  diff: {
    functions: ['note.list'],
    uses: ['dev.hangar.browser/page.open'],
    agentSessions: true,
    hostModules: ['browser'],
    sensitive: ['note.add'],
  },
  dataVersionChanged: true,
};

function api(bays: CatalogEntry[] | null, error?: string) {
  const catalog: Catalog | null = bays && { bays, ...(error ? { error } : {}) };
  return {
    getBayCatalog: vi.fn(async () => catalog),
    prepareBay: vi.fn(async () => prepared),
    confirmBay: vi.fn(async () => {}),
    cancelBay: vi.fn(async () => {}),
    rollbackBay: vi.fn(async () => {}),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('BayCatalog (ADR 0034)', () => {
  it('says when no index is set up, or the index is empty', async () => {
    const { unmount } = render(<BayCatalog api={api(null)} />);
    expect(await screen.findByText('Kein Bay-Index eingerichtet.')).toBeInTheDocument();
    unmount();
    render(<BayCatalog api={api([])} />);
    expect(await screen.findByText('Der Index enthält keine Bays.')).toBeInTheDocument();
  });

  it('installs after the person confirmed the permission diff', async () => {
    const a = api([entry()]);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<BayCatalog api={a} />);
    expect(await screen.findByText('Nicht installiert')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '1.0.0 installieren' }));
    await waitFor(() => expect(a.confirmBay).toHaveBeenCalledWith('tok'));
    expect(a.prepareBay).toHaveBeenCalledWith('dev.hangar.notes', '1.0.0');
    expect(confirm.mock.calls[0]![0]).toBe(
      [
        'Notizen 1.1.0 installieren?',
        '',
        'Neue Funktionen: note.list',
        'Ruft neu auf: dev.hangar.browser/page.open',
        'Startet Agent-Sessions mit eigenem Zugang',
        'Neue Fähigkeiten: browser',
        'Jetzt sensibel, fragt wieder nach: note.add',
        'Das Datenformat ändert sich; Hangar sichert die Daten vorher.',
        '',
        'Die neue Version läuft ab dem nächsten Start.',
      ].join('\n'),
    );
    expect(a.getBayCatalog).toHaveBeenCalledTimes(2);
  });

  it('drops the download when the person declines, and names a version without new rights', async () => {
    const a = api([entry({ current: '0.9.0' })]);
    a.prepareBay.mockResolvedValue({
      ...prepared,
      diff: { functions: [], uses: [], agentSessions: false, hostModules: [], sensitive: [] },
      dataVersionChanged: false,
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<BayCatalog api={a} />);
    expect(await screen.findByText('Installiert: 0.9.0')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Auf 1.0.0 aktualisieren' }));
    await waitFor(() => expect(a.cancelBay).toHaveBeenCalledWith('tok'));
    expect(a.confirmBay).not.toHaveBeenCalled();
    expect(confirm.mock.calls[0]![0]).toContain('Keine neuen Rechte.');
  });

  it('rolls back after confirmation and warns when data is lost', async () => {
    const a = api([
      entry({
        current: '2.0.0',
        previous: '1.0.0',
        canInstall: false,
        canRollback: true,
        rollbackLosesData: true,
      }),
    ]);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    render(<BayCatalog api={a} />);
    const button = await screen.findByRole('button', { name: 'Auf 1.0.0 zurückrollen' });
    expect(button).toHaveAccessibleDescription('dev.hangar.notes');
    await userEvent.click(button);
    await waitFor(() => expect(a.getBayCatalog).toHaveBeenCalledTimes(2));
    expect(a.rollbackBay).not.toHaveBeenCalled();
    await userEvent.click(button);
    await waitFor(() => expect(a.rollbackBay).toHaveBeenCalledWith('dev.hangar.notes'));
    expect(confirm.mock.calls[0]![0]).toContain('Änderungen seither gehen verloren.');
  });

  it('shows the next version and no button while it waits for the restart', async () => {
    render(<BayCatalog api={api([entry({ next: '1.0.0', canInstall: false })])} />);
    expect(await screen.findByText('Ab dem nächsten Start: 1.0.0')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows why loading or an action failed, without the IPC prefix', async () => {
    const failing = api(null);
    failing.getBayCatalog.mockRejectedValue(new Error('Index expired on 2026-01-01T00:00:00Z'));
    const { unmount } = render(<BayCatalog api={failing} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Fehlgeschlagen: Index expired on 2026-01-01T00:00:00Z',
    );
    unmount();
    const a = api([entry()]);
    a.prepareBay.mockRejectedValue(
      new Error(
        "Error invoking remote method 'shell:bay.prepare': Error: Package checksum mismatch",
      ),
    );
    render(<BayCatalog api={a} />);
    await userEvent.click(await screen.findByRole('button', { name: '1.0.0 installieren' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Fehlgeschlagen: Package checksum mismatch',
    );
  });

  it('runs one action at a time and ignores repeated clicks', async () => {
    const a = api([entry()]);
    let finish!: (p: PreparedBay) => void;
    a.prepareBay.mockReturnValue(new Promise((r) => (finish = r)));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<BayCatalog api={a} />);
    const button = await screen.findByRole('button', { name: '1.0.0 installieren' });
    await userEvent.click(button);
    await userEvent.click(button);
    await userEvent.dblClick(button);
    expect(a.prepareBay).toHaveBeenCalledTimes(1);
    finish(prepared);
    await waitFor(() => expect(a.confirmBay).toHaveBeenCalledTimes(1));
  });

  it('still lists installed bays when the index fails, so a rollback stays possible', async () => {
    render(
      <BayCatalog
        api={api(
          [entry({ current: '2.0.0', previous: '1.0.0', canInstall: false, canRollback: true })],
          'Index expired on 2026-01-01T00:00:00Z',
        )}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Fehlgeschlagen: Index expired on 2026-01-01T00:00:00Z',
    );
    expect(screen.getByRole('button', { name: 'Auf 1.0.0 zurückrollen' })).toBeVisible();
    expect(screen.queryByText('Der Index enthält keine Bays.')).toBeNull();
  });

  it('stays locked until the catalog is reloaded after an action', async () => {
    const a = api([entry()]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<BayCatalog api={a} />);
    const button = await screen.findByRole('button', { name: '1.0.0 installieren' });
    let reloaded!: (c: Catalog) => void;
    a.getBayCatalog.mockReturnValueOnce(new Promise((r) => (reloaded = r)));
    await userEvent.click(button);
    await waitFor(() => expect(a.getBayCatalog).toHaveBeenCalledTimes(2));
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(a.prepareBay).toHaveBeenCalledTimes(1);
    reloaded({ bays: [entry()] });
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(a.prepareBay).toHaveBeenCalledTimes(2));
  });
});
