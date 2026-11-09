import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BayInfo, OfferedFunction } from '@hangar/bridge';
import { attachBridge } from './bridge';
import { startServer } from './server';

/** Folder with the job test bay (`dev.hangar.jobtest`). */
export const fixtureBays = join(import.meta.dirname, '../fixtures');

/** A data folder with one job of the test bay that was due a minute ago. */
export function dataWithDueJob(): string {
  const data = mkdtempSync(join(tmpdir(), 'hangar-server-'));
  const twoMinutesAgo = Date.now() - 120_000;
  writeFileSync(
    join(data, 'jobs.json'),
    JSON.stringify([
      {
        id: 'nightly',
        bayId: 'dev.hangar.jobtest',
        label: 'Nightly',
        schedule: '* * * * *',
        payload: { n: 1 },
        paused: false,
        createdAt: twoMinutesAgo,
        since: twoMinutesAgo,
      },
    ]),
  );
  return data;
}

/**
 * Bays with host modules: `browser`, which the server does not have, and `workspaces`, which
 * is optional – without relay the bay has no `ctx.workspaces`.
 */
export function hostModuleBayRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hangar-server-bays-'));
  for (const module of ['browser', 'workspaces']) {
    const dir = join(root, module);
    mkdirSync(dir);
    writeFileSync(join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        id: `dev.hangar.uses${module}`,
        name: `Uses ${module}`,
        version: '0.1.0',
        minHangarVersion: '0.1.0',
        icon: 'icon.svg',
        ui: 'index.html',
        hostModules: [module],
        functions: [],
      }),
    );
  }
  return root;
}

export interface Health {
  version: string;
  bays: { id: string; version: string }[];
  errors: { dir: string; id?: string; error: string }[];
  jobs: { id: string; bayId: string; label: string; lastRun?: { ok: boolean; at: number } }[];
}

/** Polls `/health` until `done` holds (at most 10 s). */
export async function waitForHealth(url: string, done: (h: Health) => boolean): Promise<Health> {
  const until = Date.now() + 10_000;
  for (;;) {
    const health = (await (await fetch(`${url}/health`)).json()) as Health;
    if (done(health) || Date.now() > until) return health;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Writes a bay with `main.mjs` (source `main`) into a new bays folder. */
export function bayRoot(id: string, main: string, manifest: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'hangar-server-bays-'));
  const dir = join(root, id);
  mkdirSync(dir);
  writeFileSync(join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(dir, 'index.html'), '<!doctype html>');
  writeFileSync(join(dir, 'main.mjs'), main);
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      id,
      name: id,
      version: '0.1.0',
      minHangarVersion: '0.1.0',
      icon: 'icon.svg',
      ui: 'index.html',
      main: 'main.mjs',
      agentSessions: true,
      functions: [],
      ...manifest,
    }),
  );
  return root;
}

/** A bay that echoes `echo` and reports it as the event `echoed`, and tells its `locale`; on start it notifies and sets badge 1. */
const echoBay = () =>
  bayRoot(
    'dev.echo',
    `export default {
      activate(ctx) {
        ctx.notify({ title: 'started' });
        ctx.setBadge(1);
        ctx.ui.handle('echo', (value) => {
          ctx.ui.send('echoed', value);
          return value;
        });
        ctx.ui.handle('fail', () => { throw new Error('kaputt'); });
        ctx.ui.handle('locale', () => ctx.locale);
      },
    };`,
  );

/** A server with the echo bay; fingerprint and pairing code come from its log. */
export async function startEchoServer(
  data = mkdtempSync(join(tmpdir(), 'hangar-bridge-')),
  port = 0,
) {
  const log: string[] = [];
  const server = await startServer({
    data,
    host: '127.0.0.1',
    port,
    roots: [],
    bays: [echoBay()],
    log: (line) => log.push(line),
  });
  const value = (prefix: string) => log.findLast((l) => l.startsWith(prefix))!.slice(prefix.length);
  return {
    server,
    data,
    /** `127.0.0.1:<port>`, as typed into the pairing dialog. */
    address: server.url.slice('http://'.length),
    url: server.url.replace('http', 'ws') + '/connect',
    fingerprint: value('fingerprint '),
    code: () => value('pairing code '),
  };
}

/** Only the bridge on a bare HTTP server, to ask desktops questions (`bridge.ask`). */
export async function startBridge(
  askTimeoutMs?: number,
  bays: BayInfo[] = [],
  jobs: () => unknown = () => [],
  offer?: (functions: OfferedFunction[]) => void,
  workspaces?: (action: string, args: unknown[]) => Promise<unknown>,
) {
  const log: string[] = [];
  const http = createServer();
  const dataDir = mkdtempSync(join(tmpdir(), 'hangar-bridge-'));
  const bridge = attachBridge(http, {
    offer,
    workspaces,
    dataDir,
    log: (line) => log.push(line),
    bays: () => bays,
    invoke: async () => undefined,
    jobs: jobs as () => [],
    job: async () => {},
    askTimeoutMs,
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const { port } = http.address() as AddressInfo;
  return {
    bridge,
    dataDir,
    port,
    url: `ws://127.0.0.1:${port}/connect`,
    code: () => log.findLast((l) => l.startsWith('pairing code '))!.slice('pairing code '.length),
    close: () => {
      bridge.close();
      http.close();
    },
  };
}
