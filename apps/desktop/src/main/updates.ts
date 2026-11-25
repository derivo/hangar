import { app } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateChannel, UpdateStatus } from '../shared';

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
let timer: NodeJS.Timeout | undefined;
let status: UpdateStatus | undefined;
let listener: (status: UpdateStatus) => void = () => {};
let listening = false;

const warn = (e: unknown) => console.warn('Update:', e);
// The download runs on its own promise; its failure is not part of checkForUpdates().
const check = () =>
  void electronUpdater.autoUpdater
    .checkForUpdates()
    .then((result) => result?.downloadPromise?.catch(warn))
    .catch(warn);

function set(next: UpdateStatus): void {
  status = next;
  listener(next);
}

/** Mirrors the updater's events as one status for the settings. */
function listen(): void {
  if (listening) return;
  listening = true;
  const { autoUpdater } = electronUpdater;
  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => set({ state: 'current' }));
  autoUpdater.on('update-available', ({ version }) => set({ state: 'available', version }));
  autoUpdater.on('download-progress', ({ percent }) =>
    set({
      state: 'downloading',
      version: status && 'version' in status ? status.version : '',
      percent: Math.floor(percent),
    }),
  );
  autoUpdater.on('update-downloaded', ({ version }) => set({ state: 'ready', version }));
  autoUpdater.on('error', (e: Error) => set({ state: 'error', message: e.message }));
}

/**
 * Checks GitHub Releases in the background; a downloaded update installs on the next
 * quit (electron-updater defaults). Only in packaged builds.
 */
export function startUpdates(channel: UpdateChannel): void {
  if (!app.isPackaged) return;
  Object.assign(electronUpdater.autoUpdater, updaterOptions(channel));
  listen();
  clearInterval(timer);
  timer = setInterval(check, CHECK_EVERY_MS);
  check();
}

export function updateStatus(): UpdateStatus {
  return status ?? { state: app.isPackaged ? 'idle' : 'unsupported' };
}

export function onUpdateStatus(next: (status: UpdateStatus) => void): void {
  listener = next;
}

/** "Check for updates" in the settings; a found update downloads right away. */
export function checkForUpdates(): void {
  if (!app.isPackaged) return set({ state: 'unsupported' });
  if (status?.state === 'checking' || status?.state === 'downloading') return;
  check();
}

/** Quits and installs a downloaded update; a refusal (unsigned macOS build) comes as `error`. */
export function installUpdate(): void {
  if (status?.state === 'ready') electronUpdater.autoUpdater.quitAndInstall();
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
