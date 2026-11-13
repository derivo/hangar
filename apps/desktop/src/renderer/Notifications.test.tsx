import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Notifications } from './Notifications';
import type { NotificationStatus, NotificationTest } from '../shared';

const api = (status: NotificationStatus, answer: NotificationTest = { result: 'shown' }) => ({
  getNotifications: vi.fn(async () => status),
  testNotification: vi.fn(async () => answer),
  openNotificationSettings: vi.fn(async () => {}),
  changed: () => {},
  onNotifications(listener: () => void) {
    this.changed = listener;
    return () => {};
  },
});

describe('Notifications (ADR 0044)', () => {
  it('sends a test notification and opens the settings of macOS', async () => {
    const a = api({ supported: true, platform: 'darwin', settings: true });
    render(<Notifications api={a} />);
    expect(await screen.findByRole('heading', { name: 'Mitteilungen' })).toBeVisible();
    expect(screen.getByText(/^Systemeinstellungen → Mitteilungen → Hangar/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Testmitteilung senden' }));
    expect(a.testNotification).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('notification-answer')).toHaveTextContent(
      'Das System hat die Testmitteilung angenommen. Ist sie erschienen? Wenn nicht, unterdrückt sie vermutlich „Nicht stören“ oder ein Fokus.',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Mitteilungen im System einschalten' }),
    );
    expect(a.openNotificationSettings).toHaveBeenCalled();
  });

  it('says why the system refused, at the test and from the last notification', async () => {
    const a = api(
      { supported: true, platform: 'win32', settings: true, error: 'blocked' },
      { result: 'failed', error: 'not allowed' },
    );
    render(<Notifications api={a} />);
    expect(
      await screen.findByText('Das System hat die letzte Mitteilung abgelehnt: blocked'),
    ).toBeVisible();
    expect(screen.getByText(/^Einstellungen → System → Benachrichtigungen/)).toBeVisible();
    // As the host answers: the refused test is the last refusal now (OpenCode).
    a.getNotifications.mockResolvedValue({
      supported: true,
      platform: 'win32',
      settings: true,
      error: 'not allowed',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Testmitteilung senden' }));
    expect(screen.getByTestId('notification-answer')).toHaveTextContent(
      'Das System hat die Testmitteilung abgelehnt: not allowed. Schalte Mitteilungen für Hangar in den Systemeinstellungen ein.',
    );
    // The reason once, not again as "the last notification".
    expect(screen.queryByText(/letzte Mitteilung abgelehnt/)).toBeNull();
  });

  it('asks the person when the system does not answer', async () => {
    render(
      <Notifications api={api({ supported: true, platform: 'linux' }, { result: 'unknown' })} />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Testmitteilung senden' }));
    expect(screen.getByTestId('notification-answer')).toHaveTextContent(
      'Das System hat nicht geantwortet. Ist die Testmitteilung oder eine Abfrage erschienen?',
    );
  });

  it('names a missing notification service and offers no settings page on Linux', async () => {
    render(<Notifications api={api({ supported: false, platform: 'linux' })} />);
    expect(
      await screen.findByText(
        'Dieses System zeigt keine Mitteilungen von Hangar (unter Linux fehlt meist libnotify).',
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Testmitteilung senden' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Mitteilungen im System einschalten' })).toBeNull();
    expect(
      screen.getByText(/^Einstellungen der Desktop-Umgebung → Benachrichtigungen/),
    ).toBeVisible();
  });

  it('sends one test for a double click and shows a failed call', async () => {
    const a = api({ supported: true, platform: 'darwin', settings: true });
    let finish: (t: NotificationTest) => void = () => {};
    a.testNotification.mockImplementation(() => new Promise((r) => (finish = r)));
    render(<Notifications api={a} />);
    const button = await screen.findByRole('button', { name: 'Testmitteilung senden' });
    await userEvent.dblClick(button);
    await userEvent.click(button);
    expect(a.testNotification).toHaveBeenCalledTimes(1);
    finish({ result: 'shown' });
    a.openNotificationSettings.mockImplementation(() => Promise.reject(new Error('kaputt')));
    await userEvent.click(
      screen.getByRole('button', { name: 'Mitteilungen im System einschalten' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('kaputt');
  });

  it('reads the status again when the host reports a change (Codex)', async () => {
    const a = api({ supported: true, platform: 'darwin', settings: true });
    render(<Notifications api={a} />);
    await screen.findByRole('heading', { name: 'Mitteilungen' });
    // A refusal after the test answered `unknown`, or of an agent's notification.
    a.getNotifications.mockResolvedValue({ supported: true, platform: 'darwin', error: 'denied' });
    await act(async () => a.changed());
    expect(
      await screen.findByText('Das System hat die letzte Mitteilung abgelehnt: denied'),
    ).toBeVisible();
  });

  it('opens the system settings while a test still waits for its answer (Codex)', async () => {
    const a = api({ supported: true, platform: 'darwin', settings: true });
    a.testNotification.mockImplementation(() => new Promise(() => {}));
    render(<Notifications api={a} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Testmitteilung senden' }));
    await userEvent.click(
      screen.getByRole('button', { name: 'Mitteilungen im System einschalten' }),
    );
    expect(a.openNotificationSettings).toHaveBeenCalledTimes(1);
  });

  it('announces the answer politely without a second status role (E2E workspaces)', async () => {
    render(<Notifications api={api({ supported: true, platform: 'darwin' })} />);
    await screen.findByRole('heading', { name: 'Mitteilungen' });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByTestId('notification-answer')).toHaveAttribute('aria-live', 'polite');
  });

  it('says that it waits while the system has not answered (OpenCode)', async () => {
    const a = api({ supported: true, platform: 'linux' });
    a.testNotification.mockImplementation(() => new Promise(() => {}));
    render(<Notifications api={a} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Testmitteilung senden' }));
    expect(screen.getByTestId('notification-answer')).toHaveTextContent(
      'Warte auf die Antwort des Systems …',
    );
  });

  it('shows the section with the error when the status cannot be read (OpenCode)', async () => {
    const a = api({ supported: true, platform: 'darwin' });
    a.getNotifications.mockImplementation(() =>
      Promise.reject(new Error("Error invoking remote method 'shell:notifications': Error: weg")),
    );
    render(<Notifications api={a} />);
    expect(await screen.findByRole('heading', { name: 'Mitteilungen' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('weg');
  });

  it('tells where to go when Hangar is missing from the macOS list (OpenCode)', async () => {
    render(<Notifications api={api({ supported: true, platform: 'darwin', settings: true })} />);
    expect(
      await screen.findByText(
        /Fehlt Hangar in der Liste, hat macOS noch nicht gefragt: Testmitteilung senden\. Builds ohne Signatur \(Entwicklung\) zeigen unter macOS keine Mitteilungen\.$/,
      ),
    ).toBeVisible();
  });

  it('shows a later refusal with another reason after a refused test (Codex)', async () => {
    const a = api({ supported: true, platform: 'darwin' }, { result: 'failed', error: 'A' });
    render(<Notifications api={a} />);
    a.getNotifications.mockResolvedValue({ supported: true, platform: 'darwin', error: 'A' });
    await userEvent.click(await screen.findByRole('button', { name: 'Testmitteilung senden' }));
    a.getNotifications.mockResolvedValue({ supported: true, platform: 'darwin', error: 'B' });
    await act(async () => a.changed());
    expect(
      await screen.findByText('Das System hat die letzte Mitteilung abgelehnt: B'),
    ).toBeVisible();
  });

  it('stops waiting when the test call fails, and drops a read error once a read works (Codex)', async () => {
    const a = api({ supported: true, platform: 'darwin' });
    a.getNotifications.mockRejectedValueOnce(new Error('weg'));
    render(<Notifications api={a} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('weg');
    await act(async () => a.changed());
    expect(screen.queryByRole('alert')).toBeNull();
    a.testNotification.mockRejectedValueOnce(new Error('kaputt'));
    await userEvent.click(screen.getByRole('button', { name: 'Testmitteilung senden' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('kaputt');
    expect(screen.getByTestId('notification-answer')).toHaveTextContent('');
  });

  it('reads the status after a test like any other read (Codex)', async () => {
    const a = api({ supported: true, platform: 'darwin' }, { result: 'unknown' });
    render(<Notifications api={a} />);
    await screen.findByRole('button', { name: 'Testmitteilung senden' });
    a.getNotifications.mockRejectedValueOnce(new Error('weg'));
    await act(async () => a.changed());
    expect(screen.getByRole('alert')).toHaveTextContent('weg');
    // The read after the test works: the old read error goes.
    await userEvent.click(screen.getByRole('button', { name: 'Testmitteilung senden' }));
    expect(screen.queryByRole('alert')).toBeNull();
    // The read after the test fails: the next read that works drops it.
    a.getNotifications.mockRejectedValueOnce(new Error('wieder weg'));
    await userEvent.click(screen.getByRole('button', { name: 'Testmitteilung senden' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('wieder weg');
    await act(async () => a.changed());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
