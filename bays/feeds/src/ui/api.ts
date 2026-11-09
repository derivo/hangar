import type { HangarUiApi } from '@hangar/sdk';
import type { Feed, FeedSettings, FeedState, Item, ParsedFeed } from '../main/feeds';

/** Typed wrapper around `window.hangar` for the feeds channels. */
export function feedsApi(hangar: HangarUiApi) {
  return {
    state: () => hangar.invoke<FeedState>('state'),
    add: (url: string) => hangar.invoke<Feed>('add', url),
    remove: (url: string) => hangar.invoke<void>('remove', url),
    fetch: (url: string) => hangar.invoke<string>('fetch', url),
    ingest: (url: string, parsed: ParsedFeed) => hangar.invoke<Item[]>('ingest', url, parsed),
    failed: (url: string, message: string) => hangar.invoke<void>('failed', url, message),
    onState: (l: (s: FeedState) => void) => hangar.on('state', (p) => l(p as FeedState)),
    saveSettings: (s: FeedSettings) => hangar.invoke<void>('settings', s),
  };
}

export type FeedsApi = ReturnType<typeof feedsApi>;

/** The message without the prefix Electron adds to errors of the main part. */
export function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
