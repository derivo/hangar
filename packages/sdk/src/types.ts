import type { CallInfo, Caller } from '@hangar/bus';
import type { Job, JobRun, JobView, NewJob } from '@hangar/scheduler';
import type { UiLocale } from './i18n';

export type { CallInfo, Caller, Job, JobRun, JobView, NewJob };

/** Value of a bay setting: `boolean` for a check box, `string` for a text field (ADR 0025). */
export type SettingValue = boolean | string;

/**
 * Implementation of a function a bay offers on the bus.
 *
 * @param args - Untrusted arguments from the caller (another bay or an agent via MCP).
 *   Validate them before use.
 * @param info - Who is calling.
 * @returns Any JSON-serialisable value; it is returned to the caller.
 */
export type BayFunction = (args: unknown, info: CallInfo) => unknown;

/** A system notification sent through Hangar. */
export interface HangarNotification {
  /** Short title, shown in bold. */
  title: string;
  /** Optional body text. */
  body?: string;
}

/** What an agent in a session terminal needs to reach Hangar. */
export interface AgentAccess {
  /** Secret token of the session (HANGAR_TOKEN). */
  token: string;
  /** Local MCP endpoint (HANGAR_MCP_URL). */
  mcpUrl: string;
  /** Folder containing the `hangar` CLI; prepend it to the shell's PATH. */
  cliDir: string;
}

/**
 * Scheduled jobs of a bay (ADR 0013). Jobs persist across restarts and run in the
 * main process while Hangar runs, also without the bay UI.
 */
export interface BayJobs {
  /**
   * Runs this bay's due jobs. Resolve with a short result text (shown in the job
   * list), throw to report a failure. Without a handler, the bay's jobs do not run.
   */
  onRun(handler: (job: Job) => unknown): void;
  /**
   * Adds a job.
   *
   * @param job - `schedule` is a five-field cron expression in local time, e.g.
   *   `0 2 * * 1-5`; `payload` is JSON data the handler gets back.
   * @throws If the schedule is invalid.
   */
  add(job: NewJob): Job;
  /** This bay's jobs with next run, last result and state. */
  list(): JobView[];
  /** Deletes one of this bay's jobs. */
  remove(id: string): void;
}

/**
 * Everything the host gives the main part of a bay.
 *
 * The main part runs in the Hangar main process and keeps running while the bay
 * UI is hidden or the window is closed.
 */
export interface BayContext {
  /** The bay's id from its manifest. */
  readonly bayId: string;
  /** A folder owned exclusively by this bay. The bay manages its own state in it. */
  readonly dataDir: string;
  /** Version of the running Hangar app. */
  readonly hangarVersion: string;
  /**
   * Language of the app. Pick texts with `catalogFor`; texts for agents (function
   * descriptions, errors of bus functions) stay English. In the app it is fixed until
   * Hangar restarts; on a Hangar server it follows the desktop that connected last.
   */
  readonly locale: UiLocale;
  /** Called with the new `locale` when it changes (only on a Hangar server). */
  onLocaleChange(listener: (locale: UiLocale) => void): void;
  /**
   * Settings the manifest declares in `settings` (ADR 0023), set by the person in the
   * app's settings. `get` returns the stored value or the declared default, of the
   * declared type (ADR 0025); an undeclared key is `false`.
   */
  readonly settings: {
    /** Current value of the setting `key`. */
    get(key: string): SettingValue;
    /** Called with the key and new value whenever a declared setting changes. */
    onChange(listener: (change: { key: string; value: SettingValue }) => void): void;
  };

  /**
   * Offers a function on the bus. The name must be declared in the manifest's
   * `functions`; it becomes callable as `<bay-id>/<name>` by other bays and as an
   * MCP tool of the same name.
   *
   * @param name - Function name as declared in the manifest, e.g. `session.setStatus`.
   * @param handler - Implementation.
   * @param schema - Optional JSON Schema of the arguments, published to MCP clients.
   */
  provide(name: string, handler: BayFunction, schema?: Record<string, unknown>): void;

  /**
   * Calls a function of another bay. The first call asks the user for permission;
   * the decision is stored.
   *
   * @param target - `<bay-id>/<function>`, e.g. `dev.hangar.agents/session.setStatus`.
   * @param args - Arguments object.
   * @throws If the target is neither this bay's nor listed in the manifest's `uses`, the
   *   permission is denied or the function does not exist.
   */
  call<T = unknown>(target: string, args?: unknown): Promise<T>;

  /** Shows a system notification. Clicking it brings this bay to the front. */
  notify(notification: HangarNotification): void;

  /** Sets the badge on this bay's sidebar entry. `0` hides it. */
  setBadge(count: number): void;

  /**
   * How many processes of this bay run on (the agent bay's shells). A host that keeps bays
   * running without the app counts them for the person (tray, restart confirmation, ADR 0036).
   */
  setRunning(count: number): void;

  /**
   * Registers an agent session of this bay with the MCP server. Calls made with the
   * returned token run as `{ kind: 'session', bayId, sessionId }`. Registering again
   * issues a new token and invalidates the old one.
   * @throws Without `agentSessions: true` in the manifest (ADR 0032).
   */
  registerAgentSession(sessionId: string): AgentAccess;

  /**
   * Invalidates the session's token and drops its session-scoped permissions. All bays
   * learn about it through {@link BayContext.onAgentSessionEnded}.
   */
  unregisterAgentSession(sessionId: string): void;

  /**
   * Called when any bay ends one of its agent sessions (`unregisterAgentSession`), e.g. to
   * clean up what the session's agent left in this bay (ADR 0016). A restarted shell is no end.
   */
  onAgentSessionEnded(listener: (session: { bayId: string; sessionId: string }) => void): void;

  /**
   * Names this bay's agent sessions where Hangar lists them (e.g. permissions in the
   * settings), instead of their id. Return `undefined` for unknown sessions.
   */
  labelSessions(label: (sessionId: string) => string | undefined): void;

  /** Scheduled jobs of this bay. */
  readonly jobs: BayJobs;

  /**
   * Opens the native folder picker. Resolves to `undefined` if cancelled.
   *
   * @param options - `path`: where there is no dialog (server, ADR 0018), the host
   *   checks this folder against its allowed roots and resolves to its real path,
   *   or throws. The desktop ignores it.
   */
  pickFolder(options?: { title?: string; path?: string }): Promise<string | undefined>;

  /** Web page tabs; only for bays with `hostModules: ["browser"]` (ADR 0015). */
  readonly browser?: BayBrowser;

  /**
   * Shares state with the same bay of other Hangar instances in a workspace; only for bays
   * with `hostModules: ["workspaces"]` and only where the host has a relay (ADR 0030).
   */
  readonly workspaces?: BayWorkspaces;

  /** Encryption with the system keychain; only for bays with `hostModules: ["secrets"]` (ADR 0021). */
  readonly secrets?: BaySecrets;

  /** Channel to the bay's own UI. */
  readonly ui: {
    /** Answers `window.hangar.invoke(channel, ...args)` calls from the bay UI. */
    handle(channel: string, handler: (...args: unknown[]) => unknown): void;
    /** Sends an event to the bay UI (`window.hangar.on(channel, …)`). No-op if the UI is not loaded. */
    send(channel: string, payload: unknown): void;
  };
}

/** Encryption with the key of the system keychain (host module `secrets`, ADR 0021). */
export interface BaySecrets {
  /**
   * Encrypts `text` to base64.
   * @throws Where the system has no keychain (Linux without one): never stored as plain text.
   */
  encrypt(text: string): string;
  /** Decrypts what {@link BaySecrets.encrypt} returned. */
  decrypt(data: string): string;
}

/** A web page tab of the `browser` host module (ADR 0015). */
export interface BrowserTab {
  /** Id of the tab, unique within the host. */
  id: string;
  /** Address of the current page. */
  url: string;
  /** Title of the current page. */
  title: string;
  /** A page is loading. */
  loading: boolean;
  /** {@link BayBrowser.back} has a page to go to. */
  canGoBack: boolean;
  /** {@link BayBrowser.forward} has a page to go to. */
  canGoForward: boolean;
  /** Message of the last failed load, cleared by the next successful one. */
  error?: string;
  /** Partition name given to {@link BayBrowser.open}. */
  partition: string;
  /** Tab whose page opened this one (`window.open`, links with `target`). */
  openerId?: string;
  /** Page zoom in percent; absent at 100 %. */
  zoom?: number;
  /** HTTP status of the main document; absent before the first response (ADR 0042). */
  status?: number;
  /** Number of {@link PageError} entries of level `error`; absent at 0. */
  errors?: number;
  /** Result of the running {@link BayBrowser.find}. */
  find?: {
    /** The highlighted match, counted from 1; 0 without matches. */
    active: number;
    /** All matches in the page. */
    matches: number;
  };
  /** Certificate the page was refused with, until the next load (ADR 0043). */
  certificate?: {
    /** Host name of the page, without port. */
    host: string;
    /** SHA-256 fingerprint, as Electron gives it (`sha256/…`). */
    fingerprint: string;
  };
}

/** An error or warning of a page, collected by the host per tab (ADR 0042). */
export interface PageError {
  /** Milliseconds since the epoch. */
  time: number;
  /** `load`: the page itself; `console`: a console message; `request`: another request. */
  kind: 'load' | 'console' | 'request';
  /** Console warnings are `warning`; everything else is `error`. */
  level: 'error' | 'warning';
  /** Error text, e.g. `HTTP 404`, `net::ERR_CONNECTION_REFUSED` or the console message. */
  message: string;
  /** Script or request address. */
  source?: string;
  /** Line in `source`. */
  line?: number;
}

/** Where a tab keeps cookies and storage; always inside the bay's own namespace. */
export interface BrowserTabOptions {
  /** Tabs with the same name share cookies. Defaults to `default`. */
  partition?: string;
  /** Keep cookies and storage across restarts. Defaults to `false`. */
  persist?: boolean;
}

/** What the same bay of another instance shares, and where it comes from (ADR 0030). */
export interface RemoteBayState {
  /** Workspace the state came through. */
  workspace: string;
  /** Fingerprint of the other instance. */
  instance: string;
  /** Name of the other instance. */
  name: string;
  /** What that bay published; untrusted input. */
  state: unknown;
}

/** Sharing state with other instances (ADR 0030). The relay sees none of it. */
export interface BayWorkspaces {
  /** Shares this bay's state with every member instance; replaces the last one. */
  publish(state: unknown): void;
  /** What the same bay of other instances shares now. */
  states(): RemoteBayState[];
  /** Called with all states whenever one changes, arrives or leaves. */
  onState(listener: (states: RemoteBayState[]) => void): void;
}

/**
 * Web page tabs, created and owned by the host. Only `http:`, `https:` and
 * `about:blank` load; pages get no permissions (camera, location, …).
 */
export interface BayBrowser {
  /** Opens a tab and resolves with its id once the first load ended (at most 30 s). */
  open(url: string, options?: BrowserTabOptions): Promise<string>;
  /** Loads a URL; resolves once loading ended (at most 30 s). Failures end up in `error`. */
  navigate(id: string, url: string): Promise<void>;
  /** Goes back in the tab's history. */
  back(id: string): void;
  /** Goes forward in the tab's history. */
  forward(id: string): void;
  /** Loads the tab's page again. */
  reload(id: string): void;
  /** Sets the page zoom back to 100 % (Cmd/Ctrl +, - and 0 change it in the page). */
  resetZoom(id: string): void;
  /** Closes the tab. */
  close(id: string): void;
  /** All open tabs of this bay. */
  list(): BrowserTab[];
  /** Called with all tabs whenever one opens, closes, loads, zooms or changes its title. */
  onChange(listener: (tabs: BrowserTab[]) => void): void;
  /** PNG of the visible part of the page. */
  screenshot(id: string): Promise<Uint8Array>;
  /** Runs a script in the page and resolves with its (JSON-serialisable) result. */
  evaluate(id: string, script: string): Promise<unknown>;
  /** Errors and warnings of the current page, oldest first (at most 200). */
  errors(id: string): PageError[];
  /**
   * Finds `text` in the page; the result arrives as `find` of the tab. `next` goes to the
   * next (or with `forward: false` the previous) match of the running search.
   */
  find(id: string, text: string, options?: { forward?: boolean; next?: boolean }): void;
  /** Ends finding and clears the highlight. */
  stopFind(id: string): void;
  /** Gives the page the keyboard focus, e.g. after the find bar closed. */
  focus(id: string): void;
  /** Called with the tab id when the person presses Cmd/Ctrl+F in a page. */
  onFindRequest(listener: (id: string) => void): void;
  /**
   * Trusts the certificate the tab's page was refused with (`BrowserTab.certificate`) for its
   * host in every tab until Hangar quits, and loads the page again (ADR 0043). Only for the
   * person: offer it in the bay UI, never as a function for agents.
   * @param shown Host and fingerprint the person saw; binds the click to them.
   * @throws Without a refused certificate, or when the tab's host or certificate is another
   *   one now.
   */
  trustCertificate(id: string, shown: { host: string; fingerprint: string }): Promise<void>;
}

/**
 * Module shape of a bay's `main` entry (`manifest.main`).
 *
 * @example
 * ```ts
 * import type { BayMain } from '@hangar/sdk';
 * const bay: BayMain = {
 *   activate(ctx) {
 *     ctx.provide('hello.say', () => 'hi');
 *   },
 * };
 * export default bay;
 * ```
 */
export interface BayMain {
  /** Called once when Hangar starts and the bay is loaded. */
  activate(ctx: BayContext): void | Promise<void>;
  /** Called before Hangar quits; persist state here. */
  deactivate?(): void | Promise<void>;
}

/**
 * API exposed to every bay UI as `window.hangar` by the Hangar preload script.
 */
export interface HangarUiApi {
  /** Language of the app, fixed until Hangar restarts; `<html lang>` is set to it. */
  readonly locale: UiLocale;
  /**
   * Name of the server this bay runs on when the UI shows a server's bay (ADR 0019);
   * `undefined` when the bay runs in this app. A server has no folder dialog: ask for a path.
   */
  readonly server?: string;
  /** Calls a handler the bay's main part registered with `ctx.ui.handle`. */
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  /** Subscribes to events sent with `ctx.ui.send`. Returns an unsubscribe function. */
  on(channel: string, listener: (payload: unknown) => void): () => void;
  /** Extra windows of this bay, e.g. a terminal taken out of the main view (ADR 0010). */
  readonly windows: BayWindows;
  /** Shows browser tabs in this UI; only for bays with `hostModules: ["browser"]`. */
  readonly browser: BayBrowserView;
}

/** A rectangle in CSS pixels of the bay UI. */
export interface ViewRect {
  /** Distance from the left edge. */
  x: number;
  /** Distance from the top edge. */
  y: number;
  /** Width. */
  width: number;
  /** Height. */
  height: number;
}

/**
 * Places a tab of {@link BayBrowser} over a part of this UI (ADR 0015). The tab is
 * shown in the view or window that calls, and hidden everywhere else.
 */
export interface BayBrowserView {
  /** Shows the tab over `rect`, or hides the tab shown here when `id` is `undefined`. */
  show(id: string | undefined, rect?: ViewRect): Promise<void>;
}

/**
 * Windows of a bay besides its view in the main window. Each loads the bay UI again with
 * `?window=<key>`, shares its storage and its `ctx.ui` events, and is reopened after a restart.
 *
 * @example
 * ```ts
 * if (window.hangar.windows.current) renderDetached(window.hangar.windows.current);
 * else await window.hangar.windows.open('session-1', 'Login');
 * ```
 */
export interface BayWindows {
  /** Key of the window this UI runs in; `undefined` in the bay's main view. */
  readonly current: string | undefined;
  /** Opens the window with this key, or brings it to the front if it is open. */
  open(key: string, title: string): Promise<void>;
  /** Closes the window with this key, if open. */
  close(key: string): Promise<void>;
  /** Keys of the open windows of this bay. */
  list(): Promise<string[]>;
  /** Called with the open keys whenever a window opens or closes. Returns an unsubscribe function. */
  onChange(listener: (keys: string[]) => void): () => void;
}

declare global {
  interface Window {
    /** Present in every bay UI loaded by Hangar. */
    hangar: HangarUiApi;
  }
}
