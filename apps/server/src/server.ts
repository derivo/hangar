import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  BayRuntime,
  discoverBays,
  keysWithoutKeychain,
  takePassphrase,
  readSettings,
  startCore,
  uiLocale,
  workspaceAction,
  Workspaces,
  type BayLoadError,
  type HostServices,
} from '@hangar/host';
import { isUiLocale } from '@hangar/sdk/i18n';
import pkg from '../package.json' with { type: 'json' };
import { attachBridge, offered, writePrivate } from './bridge';
import type { OfferedFunction } from '@hangar/bridge';
import { messages } from './messages';
import { checkedFolder, type ServerOptions } from './options';

export interface RunningServer {
  /** e.g. `http://127.0.0.1:7420`; `GET /health` lives here. */
  url: string;
  close(): Promise<void>;
}

/** Loads the bays, starts MCP, scheduler and `/health`; nothing here needs a display. */
export async function startServer(
  options: ServerOptions & { tickMs?: number; log?: (line: string) => void },
): Promise<RunningServer> {
  const log = options.log ?? ((line: string) => console.log(line));
  // Set by the LaunchAgent to run Electron as Node (ADR 0036); shells and jobs inherit this
  // environment, and the CLI launcher sets it for itself.
  delete process.env.ELECTRON_RUN_AS_NODE;
  // Relay keys without a keychain: `plain:` (the app moves them here decrypted), new ones
  // `pass:` with the passphrase; `safe:` only the app's keychain reads. Agents must not get it.
  const keys = keysWithoutKeychain(takePassphrase().passphrase);
  const version = pkg.version;
  // The language of the desktop that connected last, unless HANGAR_LOCALE fixes it (ADR 0019).
  const localeFile = join(options.data, 'desktop-locale');
  const settingsFile = join(options.data, 'settings.json');
  const fixed = isUiLocale(process.env.HANGAR_LOCALE);
  let stored = existsSync(localeFile) ? readFileSync(localeFile, 'utf8') : undefined;
  let locale = uiLocale(readSettings(settingsFile), fixed ? process.env.HANGAR_LOCALE : stored, [
    Intl.DateTimeFormat().resolvedOptions().locale,
  ]);
  const runtimes = new Map<string, BayRuntime>();
  const failed: BayLoadError[] = [];
  const bayInfos = () =>
    [...runtimes.values()].map((r) => ({ id: r.id, version: r.bay.manifest.version }));
  const core = await startCore({
    dataDir: options.data,
    version,
    // A connected desktop answers; without one only stored rules count (ADR 0018, 0019).
    prompter: { ask: (request) => bridge.ask(request) },
    cli: {
      execPath: process.execPath,
      // Bundled at apps/server/dist, next to packages/cli/dist.
      cliPath: options.cli ?? join(import.meta.dirname, '../../../packages/cli/dist/hangar.mjs'),
    },
    onJobsChanged: () => bridge.jobsChanged(),
    remote: {
      isMember: (w, i) => workspaces?.isMember(w, i) === true,
      isShared: (w, t) => workspaces?.isShared(w, t) === true,
    },
  });
  // The relay of the local server's agent bay (ADR 0036, point 11). No keychain here: the
  // keys lie in a file with mode 600, like the bridge key in identity.json.
  let workspaces: Workspaces | undefined;
  try {
    workspaces = new Workspaces({
      dir: join(options.data, 'workspaces'),
      name: hostname(),
      bus: core.bus,
      protect: keys,
      onChange: () => bridge.workspacesChanged(),
    });
  } catch (e) {
    log(`workspaces not available: ${(e as Error).message}`);
  }
  const http = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    const health = {
      version,
      bays: bayInfos(),
      errors: failed,
      // Without `output`: it may hold terminal content.
      jobs: core.scheduler.list().map((j) => ({
        id: j.id,
        bayId: j.bayId,
        label: j.label,
        nextRun: j.nextRun,
        running: j.running,
        ...(j.lastRun && {
          lastRun: { at: j.lastRun.at, ok: j.lastRun.ok, durationMs: j.lastRun.durationMs },
        }),
      })),
    };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(health));
  });
  let bayStart = () => {};
  const started = new Promise<void>((resolve) => (bayStart = resolve));
  const bridge = attachBridge(http, {
    ready: started,
    dataDir: options.data,
    log,
    bays: bayInfos,
    invoke: (bay, channel, args) => {
      const runtime = runtimes.get(bay);
      if (!runtime) throw new Error(`Unknown bay: ${bay}`);
      return runtime.handleUi(channel, args);
    },
    locale: (desktop) => {
      if (fixed) return;
      // Also when it matches the current fallback: the next start may fall back to another.
      if (desktop !== stored) writeFileSync(localeFile, (stored = desktop));
      locale = desktop;
      for (const r of runtimes.values()) r.localeChanged(locale);
    },
    offer: (functions) => {
      offer(functions);
      writePrivate(offeredFile, JSON.stringify(functions));
    },
    desktopClosed: () => messages(locale).desktopClosed,
    ...(workspaces && {
      workspaces: (action: string, args: unknown[]) =>
        workspaceAction(workspaces, core.bus, action, args),
    }),
    jobs: () => core.scheduler.list(),
    job: async (action, id) => {
      const { scheduler } = core;
      if (action === 'run') await scheduler.runNow(id);
      else if (action === 'remove') scheduler.remove(id);
      else scheduler.setPaused(id, action === 'pause');
    },
  });
  /** Agent sessions that run, for the tray of the desktop (ADR 0036). */
  // Shells per bay (`ctx.setRunning`): the tray and the restart confirmation of the app.
  const running = new Map<string, number>();
  const services: HostServices = {
    ...core.services,
    locale,
    pickFolder: (o) => checkedFolder(o?.path, options.roots, locale),
    // Settings of the server's own settings.json; the desktop does not show them (ADR 0023).
    baySettings: (bayId) => readSettings(settingsFile).baySettings[bayId] ?? {},
    ...(workspaces && { workspaces: (bayId: string) => workspaces.forBay(bayId) }),
    notify: (bayId, n) => bridge.notify(bayId, n),
    badgeChanged: (bayId, count) => bridge.badge(bayId, count),
    runningChanged: (bayId, count) => {
      running.set(bayId, count);
      bridge.sessions([...running.values()].reduce((a, b) => a + b, 0));
    },
    sendToUi: (bayId, channel, payload) => bridge.event(bayId, channel, payload),
    browser: () => {
      throw new Error('Host module "browser" is not available on the server');
    },
    registerAgentSession: (bayId, sessionId) => {
      const access = core.services.registerAgentSession(bayId, sessionId);
      return access;
    },
    unregisterAgentSession: (bayId, sessionId) => {
      core.services.unregisterAgentSession(bayId, sessionId);
      for (const r of runtimes.values()) r.agentSessionEnded({ bayId, sessionId });
      bridge.sessionEnded(bayId, sessionId);
    },
  };

  // Bays that run only in the desktop app, called there (ADR 0036). Kept in a file, so their
  // tools are listed from the start and fail with a reason while the app is closed.
  const offeredFile = join(options.data, 'desktop-functions.json');
  const desktopBays = new Set<string>();
  const offer = (functions: OfferedFunction[]) => {
    for (const id of desktopBays) core.bus.unregisterBay(id);
    desktopBays.clear();
    const taken = new Set(core.bus.list().map((f) => f.id));
    for (const { bayId, spec } of functions) {
      // A bay of the server keeps its functions.
      if (runtimes.has(bayId) || taken.has(`${bayId}/${spec.name}`)) continue;
      desktopBays.add(bayId);
      taken.add(`${bayId}/${spec.name}`);
      core.bus.registerTransport(bayId, spec, {
        invoke: (target, args, { caller }) =>
          bridge.call(target, args, {
            bayId: caller.bayId,
            ...(caller.kind === 'session' && { sessionId: caller.sessionId }),
          }),
        // The app asks and keeps the rules (ADR 0036, Nachtrag): one dialog, not two.
        authorizes: true,
      });
    }
  };

  // Listening before the bays start: a bay that restores shells must not wait for a port,
  // and a taken port must not make the service restart them in a loop (ADR 0036).
  const listenFile = join(options.data, 'listen.json');
  const before = options.port === 0 && existsSync(listenFile) ? readListen(listenFile) : 0;
  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(port, options.host, () => {
        http.off('error', reject);
        resolve();
      });
    });
  await listen(before || options.port).catch((e: NodeJS.ErrnoException) => {
    if (!before || e.code !== 'EADDRINUSE') throw e;
    return listen(0);
  });
  const { port } = http.address() as AddressInfo;
  const host = options.host.includes(':') ? `[${options.host}]` : options.host;
  const url = `http://${host}:${port}`;
  writePrivate(listenFile, JSON.stringify({ port, fingerprint: bridge.fingerprint }));
  log(`listening on ${url}`);

  const { bays, errors } = discoverBays(options.bays, version);
  failed.push(...errors);
  for (const bay of bays) {
    const { id, name } = bay.manifest;
    // `workspaces` is optional: without relay the bay simply has no `ctx.workspaces`.
    const missing = bay.manifest.hostModules?.find((m) => m !== 'workspaces');
    if (missing) {
      failed.push({
        dir: bay.dir,
        id,
        name,
        error: `Host module "${missing}" is not available on the server`,
      });
      continue;
    }
    const runtime = new BayRuntime(bay, services);
    try {
      await runtime.activate();
      runtimes.set(id, runtime);
      log(`bay ${id} ${bay.manifest.version} loaded`);
    } catch (e) {
      await runtime.deactivate().catch(() => undefined);
      core.bus.unregisterBay(id);
      failed.push({ dir: bay.dir, id, name, error: `Start failed: ${(e as Error).message}` });
    }
  }
  for (const e of failed) log(`bay ${e.id ?? e.dir} not loaded: ${e.error}`);
  offer(readOffered(offeredFile));
  bayStart();
  core.scheduler.start(options.tickMs);
  void workspaces?.start();

  return {
    url,
    close: async () => {
      bridge.close();
      workspaces?.close();
      await new Promise((resolve) => http.close(resolve));
      for (const r of runtimes.values()) await r.deactivate();
      await core.close();
    },
  };
}

/** What the desktop offered last; nothing if the file is missing or damaged. */
function readOffered(file: string): OfferedFunction[] {
  try {
    const functions = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    // Checked like an offer: a broken entry must not stop the start (Codex).
    return Array.isArray(functions)
      ? functions.map(offered).filter((f): f is OfferedFunction => !!f)
      : [];
  } catch {
    return [];
  }
}

/** The port of the last start; 0 if the file is damaged. */
function readListen(file: string): number {
  try {
    const { port } = JSON.parse(readFileSync(file, 'utf8')) as { port?: unknown };
    return Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536
      ? (port as number)
      : 0;
  } catch {
    return 0;
  }
}
