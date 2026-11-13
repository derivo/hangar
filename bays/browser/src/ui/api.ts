import type { HangarUiApi, PageError, ViewRect } from '@hangar/sdk';
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
    errors: (id: string) => hangar.invoke<PageError[]>('tab.errors', id),
    find: (id: string, text: string, options?: { forward: boolean; next: boolean }) =>
      hangar.invoke<void>('tab.find', id, text, options),
    stopFind: (id: string) => hangar.invoke<void>('tab.stopFind', id),
    /** Gives the page of the tab the keyboard focus. */
    focus: (id: string) => hangar.invoke<void>('tab.focus', id),
    /** The person pressed Cmd/Ctrl+F in the page of a tab. */
    onFind: (l: (id: string) => void) => hangar.on('find', (id) => l(id as string)),
    /** The host hands http(s) links of bay UIs to the system browser. */
    openExternal: (url: string): void => void window.open(url),
    /** Trusts the refused certificate of the tab's host until Hangar quits (ADR 0043). */
    trustCertificate: (id: string, shown: { host: string; fingerprint: string }) =>
      hangar.invoke<void>('tab.trustCertificate', id, shown),
  };
}

export type BrowserApi = ReturnType<typeof browserApi>;
