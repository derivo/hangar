import type { HangarUiApi, ViewRect } from '@hangar/sdk';
import type { BrowserState } from '../main/types';

/** Typed wrapper around `window.hangar` for the browser bay's channels. */
export function browserApi(hangar: HangarUiApi) {
  return {
    state: () => hangar.invoke<BrowserState>('state'),
    open: (url: string) => hangar.invoke<string>('tab.open', url),
    navigate: (id: string, url: string) => hangar.invoke<void>('tab.navigate', id, url),
    back: (id: string) => hangar.invoke<void>('tab.back', id),
    forward: (id: string) => hangar.invoke<void>('tab.forward', id),
    reload: (id: string) => hangar.invoke<void>('tab.reload', id),
    resetZoom: (id: string) => hangar.invoke<void>('tab.resetZoom', id),
    close: (id: string) => hangar.invoke<void>('tab.close', id),
    onState: (l: (s: BrowserState) => void) => hangar.on('state', (p) => l(p as BrowserState)),
    /** Shows the tab over `rect` of this view; `undefined` hides the shown one. */
    show: (id: string | undefined, rect?: ViewRect) => hangar.browser.show(id, rect),
  };
}

export type BrowserApi = ReturnType<typeof browserApi>;
