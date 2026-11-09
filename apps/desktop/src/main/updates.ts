import { app } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateChannel } from '../shared';

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
let timer: NodeJS.Timeout | undefined;

/**
 * Checks GitHub Releases in the background; a downloaded update installs on the next
 * quit (electron-updater defaults). Only in packaged builds.
 */
export function startUpdates(channel: UpdateChannel): void {
  if (!app.isPackaged) return;
  const { autoUpdater } = electronUpdater;
  Object.assign(autoUpdater, updaterOptions(channel));
  const warn = (e: unknown) => console.warn('Update:', e);
  // The download runs on its own promise; its failure is not part of checkForUpdates().
  const check = () =>
    void autoUpdater
      .checkForUpdates()
      .then((result) => result?.downloadPromise?.catch(warn))
      .catch(warn);
  clearInterval(timer);
  timer = setInterval(check, CHECK_EVERY_MS);
  check();
}

/**
 * electron-updater reads `latest*.yml` for stable and `beta*.yml` (prereleases) for beta.
 * Its `channel` setter turns `allowDowngrade` on, so `allowDowngrade` must come after it.
 */
export function updaterOptions(channel: UpdateChannel) {
  return channel === 'beta'
    ? { channel: 'beta', allowPrerelease: true, allowDowngrade: false }
    : { channel: 'latest', allowPrerelease: false, allowDowngrade: false };
}
