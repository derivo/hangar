import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../messages';
import type { NotificationStatus, NotificationTest, ShellApi } from '../shared';

interface Props {
  api: Pick<
    ShellApi,
    'getNotifications' | 'onNotifications' | 'testNotification' | 'openNotificationSettings'
  >;
}

const answerText = (answer: NotificationTest) =>
  answer.result === 'shown'
    ? t.notificationShown
    : answer.result === 'failed'
      ? t.notificationRefused(answer.error ?? '')
      : answer.result === 'unknown'
        ? t.notificationUnknown
        : t.notificationsUnsupported;

/** Hangar wraps errors of the main process; people only need the message. */
const shown = (e: Error) =>
  String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** System notifications: check them, and where the system switches them on (ADR 0044). */
export function Notifications({ api }: Props) {
  const [status, setStatus] = useState<NotificationStatus>();
  const [answer, setAnswer] = useState<NotificationTest | 'waiting'>();
  const [error, setError] = useState<string>();
  /** The status could not be read; gone with the next read that works (Codex). */
  const [readError, setReadError] = useState<string>();
  const busy = useRef(new Set<string>());
  const load = useCallback(
    () =>
      api.getNotifications().then(
        (s) => {
          setStatus(s);
          setReadError(undefined);
        },
        (e: Error) => setReadError(shown(e)),
      ),
    [api],
  );
  // Again whenever the system answers a notification, also after the test gave up (Codex).
  useEffect(() => {
    void load();
    return api.onNotifications(() => void load());
  }, [api, load]);
  if (!status && !readError) return null;

  // One run per action at a time (ADR 0028); a failed call shows its message.
  const run = async (key: string, action: () => Promise<void>) => {
    if (busy.current.has(key)) return;
    busy.current.add(key);
    setError(undefined);
    try {
      await action();
    } catch (e) {
      setError(shown(e as Error));
    } finally {
      busy.current.delete(key);
    }
  };
  const test = () =>
    run('test', async () => {
      setAnswer('waiting');
      try {
        setAnswer(await api.testNotification());
      } catch (e) {
        setAnswer(undefined);
        throw e;
      }
      // The same read as any other, so its error behaves alike (Codex).
      await load();
    });

  // A refused test names its reason itself: not again as "the last notification" (OpenCode);
  // a later refusal with another reason shows (Codex).
  const lastError =
    answer !== 'waiting' && answer?.result === 'failed' && answer.error === status?.error
      ? undefined
      : status?.error;

  return (
    <>
      <h2>{t.notifications}</h2>
      <p className="muted">{t.notificationsHint}</p>
      {status && !status.supported && <p>{t.notificationsUnsupported}</p>}
      {lastError && <p>{t.notificationsFailed(lastError)}</p>}
      {status && (
        <p className="notification-actions">
          <button
            type="button"
            className="button"
            disabled={!status.supported}
            onClick={(e) => e.detail <= 1 && void test()}
          >
            {t.notificationTest}
          </button>
          {status.settings && (
            <button
              type="button"
              className="button"
              onClick={(e) =>
                e.detail <= 1 && void run('settings', () => api.openNotificationSettings())
              }
            >
              {t.notificationSettings}
            </button>
          )}
        </p>
      )}
      {/* Live, but not a second `status` role next to the workspaces section. */}
      <p aria-live="polite" data-testid="notification-answer">
        {answer === 'waiting' ? t.notificationWaiting : answer && answerText(answer)}
      </p>
      {(error ?? readError) && (
        <p className="error" role="alert">
          {error ?? readError}
        </p>
      )}
      {status && (
        <p className="muted">
          {t.notificationsWhere[status.platform] ?? t.notificationsWhere.linux}
        </p>
      )}
    </>
  );
}
