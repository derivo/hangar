import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Caller, FunctionHandler, FunctionSpec } from '@hangar/bus';
import type {
  AgentAccess,
  BayBrowser,
  BayContext,
  BaySecrets,
  BayWorkspaces,
  BayMain,
  HangarNotification,
  SettingValue,
  UiLocale,
} from '@hangar/sdk';
import type { Scheduler } from '@hangar/scheduler';
import type { LoadedBay } from './bay-loader';
import { baySetting } from './settings';

/** Host capabilities a bay runtime needs; implemented with Electron in `host.ts`. */
export interface HostServices {
  dataRoot: string;
  hangarVersion: string;
  locale: UiLocale;
  pickFolder(options?: { title?: string; path?: string }): Promise<string | undefined>;
  notify(bayId: string, notification: HangarNotification): void;
  badgeChanged(bayId: string, count: number): void;
  /** The processes a bay runs on changed (`ctx.setRunning`); only the server counts them. */
  runningChanged?(bayId: string, count: number): void;
  sendToUi(bayId: string, channel: string, payload: unknown): void;
  provide(bayId: string, spec: FunctionSpec, handler: FunctionHandler): void;
  call(caller: Caller, target: string, args: unknown): Promise<unknown>;
  registerAgentSession(bayId: string, sessionId: string): AgentAccess;
  /** Ends a session of `bayId`; the host then calls `agentSessionEnded` on every runtime. */
  unregisterAgentSession(bayId: string, sessionId: string): void;
  scheduler: Scheduler;
  /** Web page tabs of a bay (host module `browser`, ADR 0015). */
  browser(bayId: string): BayBrowser;
  /** Sharing with other instances (host module `workspaces`, ADR 0030); absent without relay. */
  workspaces?(bayId: string): BayWorkspaces;
  /** Encryption with the system keychain (host module `secrets`, ADR 0021); only the desktop. */
  secrets?: BaySecrets;
  /** Stored values of a bay's settings (`settings.json` `baySettings`, ADR 0023). */
  baySettings(bayId: string): Record<string, SettingValue>;
}

/** One loaded bay: its context, UI handlers and badge. */
export class BayRuntime {
  readonly id: string;
  badge = 0;
  private readonly uiHandlers = new Map<string, (...args: unknown[]) => unknown>();
  private labeler?: (sessionId: string) => string | undefined;
  private readonly sessionEndListeners: ((s: { bayId: string; sessionId: string }) => void)[] = [];
  private readonly localeListeners: ((locale: UiLocale) => void)[] = [];
  private readonly settingListeners: ((change: { key: string; value: SettingValue }) => void)[] =
    [];
  private locale: UiLocale;
  private main?: BayMain;
  /** Agent sessions with a token; ended on deactivate, so no token outlives the bay. */
  private readonly sessions = new Set<string>();

  constructor(
    readonly bay: LoadedBay,
    private readonly services: HostServices,
  ) {
    this.id = bay.manifest.id;
    this.locale = services.locale;
  }

  async activate(): Promise<void> {
    const { manifest, dir } = this.bay;
    if (!manifest.main) return;
    const mod = (await import(/* @vite-ignore */ pathToFileURL(join(dir, manifest.main)).href)) as {
      default: Partial<BayMain> & { default?: BayMain };
    };
    // ESM `export default` and CJS `module.exports` both arrive as `default`;
    // a CJS-compiled `export default` arrives one level deeper.
    this.main = mod.default.activate ? (mod.default as BayMain) : mod.default.default!;
    await this.main.activate(this.createContext());
  }

  async deactivate(): Promise<void> {
    this.services.scheduler.unhandle(this.id);
    try {
      await this.main?.deactivate?.();
    } finally {
      // Also when the bay fails here: no token outlives it.
      for (const sessionId of this.sessions) {
        this.services.unregisterAgentSession(this.id, sessionId);
      }
      this.sessions.clear();
    }
  }

  async handleUi(channel: string, args: unknown[]): Promise<unknown> {
    const handler = this.uiHandlers.get(channel);
    if (!handler) throw new Error(`No handler for "${channel}"`);
    return handler(...args);
  }

  hasHostModule(name: 'browser' | 'workspaces' | 'secrets'): boolean {
    return this.bay.manifest.hostModules?.includes(name) ?? false;
  }

  /** An agent session of any bay ended (ADR 0016); a failing bay must not stop the others. */
  agentSessionEnded(session: { bayId: string; sessionId: string }): void {
    for (const listener of this.sessionEndListeners) {
      try {
        listener(session);
      } catch (e) {
        console.error(`Bay ${this.id}: onAgentSessionEnded failed`, e);
      }
    }
  }

  /** The server follows the language of the desktop that connected last (ADR 0019). */
  localeChanged(locale: UiLocale): void {
    if (locale === this.locale) return;
    this.locale = locale;
    for (const listener of this.localeListeners) {
      try {
        listener(locale);
      } catch (e) {
        console.error(`Bay ${this.id}: onLocaleChange failed`, e);
      }
    }
  }

  /** A stored setting of this bay changed (ADR 0023); undeclared keys are not reported. */
  settingChanged(key: string): void {
    if (!this.bay.manifest.settings?.some((s) => s.key === key)) return;
    const value = this.setting(key);
    for (const listener of this.settingListeners) {
      try {
        listener({ key, value });
      } catch (e) {
        console.error(`Bay ${this.id}: settings.onChange failed`, e);
      }
    }
  }

  private setting(key: string): SettingValue {
    return baySetting(this.services.baySettings(this.id), this.bay.manifest.settings, key);
  }

  /** Name of an agent session of this bay, if the bay labels its sessions. */
  sessionLabel(sessionId: string): string | undefined {
    return this.labeler?.(sessionId);
  }

  private createContext(): BayContext {
    const { services, id } = this;
    const locale = () => this.locale;
    const dataDir = join(services.dataRoot, id);
    mkdirSync(dataDir, { recursive: true });
    const declared = new Map(this.bay.manifest.functions.map((f) => [f.name, f]));

    return {
      bayId: id,
      dataDir,
      hangarVersion: services.hangarVersion,
      get locale() {
        return locale();
      },
      onLocaleChange: (listener) => void this.localeListeners.push(listener),
      settings: {
        get: (key) => this.setting(key),
        onChange: (listener) => void this.settingListeners.push(listener),
      },
      provide: (name, handler, inputSchema) => {
        const fn = declared.get(name);
        if (!fn) throw new Error(`Function "${name}" is not declared in the manifest`);
        services.provide(id, { ...fn, ...(inputSchema && { inputSchema }) }, handler);
      },
      call: async <T>(target: string, args?: unknown) => {
        // Declared calls only, so an install can show what a bay reaches (ADR 0012).
        if (!target.startsWith(`${id}/`) && !this.bay.manifest.uses?.includes(target)) {
          throw new Error(`Access denied: ${id} → ${target} (not in the manifest's "uses")`);
        }
        const declared = !target.startsWith(`${id}/`);
        const caller = { kind: 'bay' as const, bayId: id, ...(declared && { declared }) };
        return (await services.call(caller, target, args)) as T;
      },
      notify: (n) => services.notify(id, n),
      setBadge: (count) => {
        this.badge = Math.max(0, Math.floor(count));
        services.badgeChanged(id, this.badge);
      },
      setRunning: (count) => services.runningChanged?.(id, Math.max(0, Math.floor(count))),
      registerAgentSession: (sessionId) => {
        // A token lets its holder call as an agent, past `uses` (ADR 0012).
        if (this.bay.manifest.agentSessions !== true) {
          throw new Error('registerAgentSession needs "agentSessions": true in the manifest');
        }
        this.sessions.add(sessionId);
        return services.registerAgentSession(id, sessionId);
      },
      unregisterAgentSession: (sessionId) => {
        this.sessions.delete(sessionId);
        services.unregisterAgentSession(id, sessionId);
      },
      onAgentSessionEnded: (listener) => void this.sessionEndListeners.push(listener),
      pickFolder: (options) => services.pickFolder(options),
      ...(this.hasHostModule('browser') && { browser: services.browser(id) }),
      ...(this.hasHostModule('workspaces') &&
        services.workspaces && { workspaces: services.workspaces(id) }),
      ...(this.hasHostModule('secrets') && services.secrets && { secrets: services.secrets }),
      jobs: {
        onRun: (handler) => services.scheduler.handle(id, handler),
        add: (job) => services.scheduler.add(id, job),
        list: () => services.scheduler.list(id),
        remove: (jobId) => {
          if (!services.scheduler.list(id).some((j) => j.id === jobId))
            throw new Error(`Unknown job "${jobId}"`);
          services.scheduler.remove(jobId);
        },
      },
      labelSessions: (label) => (this.labeler = label),
      ui: {
        handle: (channel, handler) => this.uiHandlers.set(channel, handler),
        send: (channel, payload) => services.sendToUi(id, channel, payload),
      },
    };
  }
}
