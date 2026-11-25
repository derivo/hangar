import { useEffect, useState } from 'react';
import { t } from '../messages';
import { RELEASES_URL, type ShellApi, type UpdateStatus } from '../shared';

interface Props {
  api: Pick<ShellApi, 'getUpdate' | 'onUpdate' | 'checkForUpdates' | 'installUpdate'>;
}

const text = (s: UpdateStatus) => {
  switch (s.state) {
    case 'unsupported':
      return t.updateUnsupported;
    case 'checking':
      return t.updateChecking;
    case 'current':
      return t.updateCurrent;
    case 'available':
      return t.updateAvailable(s.version);
    case 'downloading':
      return t.updateDownloading(s.version, s.percent);
    case 'ready':
      return t.appUpdateReady(s.version);
    case 'manual':
      return t.updateManual;
    default:
      return '';
  }
};

/** "Check for updates" and its progress, up to "Restart and install". */
export function UpdateCheck({ api }: Props) {
  const [status, setStatus] = useState<UpdateStatus>();
  useEffect(() => {
    void api.getUpdate().then(setStatus);
    return api.onUpdate(setStatus);
  }, [api]);
  if (!status) return null;
  const busy = ['unsupported', 'checking', 'available', 'downloading', 'ready'].includes(
    status.state,
  );

  return (
    <>
      <p className="notification-actions">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={(e) => e.detail <= 1 && api.checkForUpdates()}
        >
          {t.checkUpdates}
        </button>
        {status.state === 'ready' && (
          <button
            type="button"
            className="button"
            onClick={(e) => e.detail <= 1 && api.installUpdate()}
          >
            {t.restartAndInstall}
          </button>
        )}
      </p>
      {/* Live, but not a second `status` role next to the workspaces section. */}
      <p aria-live="polite">{text(status)}</p>
      {status.state === 'downloading' && (
        <progress max={100} value={status.percent} aria-label={t.updateDownload} />
      )}
      {status.state === 'manual' && (
        <p>
          {/* The shell window's open handler checks it: a release page, no `%`, no dot segments. */}
          <a href={`${RELEASES_URL}tag/v${status.version}`} target="_blank" rel="noreferrer">
            {t.downloadVersion(status.version)}
          </a>
        </p>
      )}
      {status.state === 'error' && (
        <p className="error" role="alert">
          {t.updateFailed(status.message)}
        </p>
      )}
    </>
  );
}
