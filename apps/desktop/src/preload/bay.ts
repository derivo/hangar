// Preload of every bay view: exposes `window.hangar` (see HangarUiApi in @hangar/sdk).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { HangarUiApi, UiLocale } from '@hangar/sdk';

const locale = ipcRenderer.sendSync('hangar:locale') as UiLocale;
window.addEventListener('DOMContentLoaded', () => (document.documentElement.lang = locale));

const server = ipcRenderer.sendSync('bay:server') as string | null;

const api: HangarUiApi = {
  locale,
  ...(server !== null && { server }),
  invoke: (channel, ...args) => ipcRenderer.invoke('bay:invoke', channel, args),
  on(channel, listener) {
    const handler = (_e: IpcRendererEvent, ch: string, payload: unknown) => {
      if (ch === channel) listener(payload);
    };
    ipcRenderer.on('bay:event', handler);
    return () => ipcRenderer.removeListener('bay:event', handler);
  },
  browser: {
    show: (id, rect) => ipcRenderer.invoke('bay:browser.show', id, rect),
  },
  windows: {
    current: new URLSearchParams(location.search).get('window') ?? undefined,
    open: (key, title) => ipcRenderer.invoke('bay:window.open', key, title),
    close: (key) => ipcRenderer.invoke('bay:window.close', key),
    list: () => ipcRenderer.invoke('bay:window.list'),
    onChange(listener) {
      const handler = (_e: IpcRendererEvent, keys: string[]) => listener(keys);
      ipcRenderer.on('bay:windows', handler);
      return () => ipcRenderer.removeListener('bay:windows', handler);
    },
  },
};

contextBridge.exposeInMainWorld('hangar', api);
