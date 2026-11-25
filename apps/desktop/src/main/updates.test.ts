import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { updater, electron } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  return {
    updater: Object.assign(new EventEmitter(), {
      checkForUpdates: vi.fn(),
      quitAndInstall: vi.fn(),
    }),
    electron: { app: { isPackaged: true } },
  };
});
vi.mock('electron', () => electron);
vi.mock('electron-updater', () => ({ default: { autoUpdater: updater } }));

import {
  checkForUpdates,
  installUpdate,
  onUpdateStatus,
  startUpdates,
  updateStatus,
  updaterOptions,
} from './updates';

// The 4-hour re-check must not keep running after the test.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  electron.app.isPackaged = true;
  updater.checkForUpdates.mockReset().mockResolvedValue(null);
  updater.quitAndInstall.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('startUpdates', () => {
  it('handles a failed download instead of leaving an unhandled rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failed = Promise.reject(new Error('Verbindung abgebrochen'));
    updater.checkForUpdates.mockResolvedValue({ downloadPromise: failed });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    startUpdates('stable');
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'Update:',
      expect.objectContaining({ message: 'Verbindung abgebrochen' }),
    );
    warn.mockRestore();
  });

  it('maps channels to electron-updater options', () => {
    expect(updaterOptions('stable')).toEqual({
      channel: 'latest',
      allowPrerelease: false,
      allowDowngrade: false,
    });
    expect(updaterOptions('beta')).toEqual({
      channel: 'beta',
      allowPrerelease: true,
      allowDowngrade: false,
    });
  });

  it('keeps downgrades off although electron-updater turns them on with the channel', () => {
    // Same behaviour as electron-updater's `channel` setter.
    const updater = {
      allowDowngrade: false,
      set channel(_: string) {
        this.allowDowngrade = true;
      },
    };
    Object.assign(updater, updaterOptions('stable'));
    expect(updater.allowDowngrade).toBe(false);
  });
});

describe('update status', () => {
  it('follows the updater from the check to the download and reports every step', () => {
    const seen: unknown[] = [];
    onUpdateStatus((s) => seen.push(s));
    startUpdates('stable');
    // A second start (new channel) must not listen twice.
    startUpdates('beta');
    updater.emit('checking-for-update');
    updater.emit('update-not-available', { version: '0.9.0' });
    updater.emit('checking-for-update');
    updater.emit('update-available', { version: '1.0.0' });
    updater.emit('download-progress', { percent: 41.7 });
    updater.emit('update-downloaded', { version: '1.0.0' });
    expect(seen).toEqual([
      { state: 'checking' },
      { state: 'current' },
      { state: 'checking' },
      { state: 'available', version: '1.0.0' },
      { state: 'downloading', version: '1.0.0', percent: 41 },
      { state: 'ready', version: '1.0.0' },
    ]);
    expect(updateStatus()).toEqual({ state: 'ready', version: '1.0.0' });
  });

  it('installs only a downloaded update and shows the error of the updater', () => {
    startUpdates('stable');
    updater.emit('update-downloaded', { version: '1.0.0' });
    installUpdate();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    // Unsigned macOS builds: Squirrel refuses the update; its message is shown as is.
    updater.emit('error', new Error('Could not get code signature for running application'));
    expect(updateStatus()).toEqual({
      state: 'error',
      message: 'Could not get code signature for running application',
    });
    installUpdate();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('checks on demand, but not while a check or download runs', () => {
    startUpdates('stable');
    updater.emit('update-not-available', { version: '0.9.0' });
    updater.checkForUpdates.mockClear();
    checkForUpdates();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    updater.emit('checking-for-update');
    checkForUpdates();
    updater.emit('download-progress', { percent: 3 });
    checkForUpdates();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('says that updates exist only in the packaged app', () => {
    electron.app.isPackaged = false;
    updater.checkForUpdates.mockClear();
    checkForUpdates();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updateStatus()).toEqual({ state: 'unsupported' });
  });
});
