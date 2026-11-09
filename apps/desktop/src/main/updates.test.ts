import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updater = vi.hoisted(() => ({ checkForUpdates: vi.fn() }));
vi.mock('electron', () => ({ app: { isPackaged: true } }));
vi.mock('electron-updater', () => ({ default: { autoUpdater: updater } }));

import { startUpdates, updaterOptions } from './updates';

// The 4-hour re-check must not keep running after the test.
beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
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
