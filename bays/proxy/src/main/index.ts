import { fileURLToPath } from 'node:url';
import type { BayContext, BayMain } from '@hangar/sdk';
import { Ca } from './ca';
import { MitmEngine, type Engine } from './engine';

/** The addon next to the built main part, outside `app.asar` so Python can read it. */
export const addonPath = (mainUrl: string) =>
  fileURLToPath(new URL('../addon/hangar_proxy.py', mainUrl)).replace(
    /([\\/])app\.asar([\\/])/,
    '$1app.asar.unpacked$2',
  );

/** Settings that change how mitmdump starts. */
const ENGINE_SETTINGS = ['mitmdumpPath', 'upstreamCaFile'];

export function createProxyBay(
  makeEngine = (ctx: BayContext): Engine =>
    new MitmEngine({
      ca: new Ca(ctx.dataDir),
      addonPath: addonPath(import.meta.url),
      mitmdumpPath: () => String(ctx.settings.get('mitmdumpPath')),
      upstreamCaFile: () => String(ctx.settings.get('upstreamCaFile')),
      log: (message) => console.warn(`[proxy] ${message}`),
    }),
): BayMain {
  let engine: Engine | undefined;
  return {
    activate(ctx) {
      // The engine starts with the first watched session (ADR 0049, step 3), not with Hangar.
      const current = (engine = makeEngine(ctx));
      const status = () => current.status();
      ctx.provide('proxy.status', status, { type: 'object', properties: {} });
      ctx.ui.handle('status', status);
      current.onStatus((s) => ctx.ui.send('status', s));
      ctx.settings.onChange(({ key }) => {
        if (!ENGINE_SETTINGS.includes(key) || current.status().state === 'stopped') return;
        current.restart().catch((e: Error) => console.warn(`[proxy] restart: ${e.message}`));
      });
    },
    async deactivate() {
      await engine?.stop();
    },
  };
}

export default createProxyBay();
