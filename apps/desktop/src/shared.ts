// Types shared between the main process and the shell renderer.
import type { Grant, GrantMode } from '@hangar/bus';
import type { JobView } from '@hangar/scheduler';
import type {
  AppSettings,
  Catalog,
  CatalogEntry,
  RightsDiff,
  LanguageSetting,
  ThemeSetting,
  UpdateChannel,
  WorkspacesView,
} from '@hangar/host';
import type { SettingValue } from '@hangar/sdk';
import type { UiLocale } from '@hangar/sdk/i18n';

export type { Catalog, CatalogEntry, Grant, RightsDiff, SettingValue };

/** A checked download waiting for the person's confirmation (ADR 0034). */
export interface PreparedBay {
  token: string;
  id: string;
  version: string;
  name: string;
  diff: RightsDiff;
  dataVersionChanged: boolean;
}

/** One entry in the sidebar. */
export interface SidebarBay {
  id: string;
  name: string;
  /** Icon as data URL. */
  icon: string;
  badge: number;
}

/** A bay that failed to load; listed in the sidebar so the user sees why. */
export interface SidebarBayError {
  label: string;
  error: string;
}

/** `'overview'` and `'settings'` show the shell's own pages instead of a bay. */
export type Selection = string | 'overview' | 'settings' | null;

/** A paired server and its bays in the sidebar (ADR 0019). */
export interface SidebarServer {
  id: string;
  name: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'failed';
  error?: string;
  /** `id` is the selection key `remote:<server>:<bay>`. */
  bays: SidebarBay[];
  /** Server bays without a matching local bundle. */
  errors: SidebarBayError[];
}

/** The server on this Mac (ADR 0036): its bays stand in the sidebar like the app's own. */
export interface SidebarLocalServer {
  status: SidebarServer['status'];
  error?: string;
  /** Selection keys `remote:<server>:<bay>`; while it is down, the bays it runs. */
  bays: SidebarBay[];
  /** The app is newer than the version the server runs until it is restarted. */
  update?: { running: string; ready: string };
  /** A restart runs; the old server may still be connected until it stops. */
  restarting?: true;
  /** Number of the reconnect attempt running or waiting while it is not connected. */
  retry?: number;
  /** The last lines of its log, followed while the page of a selected bay says it is down. */
  log?: string[];
}

/** Height of the hint „Neue Version bereit“ above a bay of the local server. */
export const UPDATE_HINT_HEIGHT = 48;

/** A program, folder, file or website in the sidebar (ADR 0027). */
export interface SidebarShortcut {
  id: string;
  name: string;
  target: string;
  url: boolean;
  /** System icon of a path as data URL; missing for websites and while it loads. */
  icon?: string;
}

export interface ShellState {
  bays: SidebarBay[];
  /** Ids of `bays` and of the local server's bays in sidebar order (ADR 0038). */
  order?: string[];
  servers: SidebarServer[];
  localServer?: SidebarLocalServer;
  errors: SidebarBayError[];
  shortcuts: SidebarShortcut[];
  selected: Selection;
  /** Found bays that are not in the sidebar (ADR 0017). */
  available: { id: string; name: string; icon: string }[];
}

/** Functions on the bus and the permissions granted for them (settings page). */
export interface PermissionsView {
  /** Loaded bays: callers and owners of functions. */
  bays: { id: string; name: string }[];
  functions: { id: string; bayId: string; sensitive: boolean; description?: string }[];
  /** Session grants carry the session's name, if its bay labels sessions. */
  grants: (Grant & { sessionLabel?: string })[];
}

/** Jobs of all bays for the settings (ADR 0013). */
export interface JobsView {
  bays: { id: string; name: string }[];
  jobs: JobView[];
  /** Jobs of the connected servers (phase 11d); `error` if listing them failed. */
  servers: { id: string; name: string; jobs: JobView[]; error?: string }[];
}

/** Global git identity; fields that are not set are left out. */
export interface GitIdentity {
  installed: boolean;
  name?: string;
  email?: string;
}

/** Content of the Hangar overview page. */
export interface OverviewView {
  /** Hangar's own version. */
  version: string;
  git: GitIdentity;
  bays: { id: string; name: string; version: string }[];
  errors: SidebarBayError[];
}

export type { AppSettings, LanguageSetting, ThemeSetting, UpdateChannel };

/** Settings a running bay declares (ADR 0023), texts in the app language. */
export interface BaySettingsView {
  bayId: string;
  name: string;
  settings: { key: string; label: string; description?: string; value: SettingValue }[];
}

/** Workspaces in the settings (ADR 0030), with the functions bays offer to other instances. */
export type WorkspacesSettingsView = WorkspacesView & {
  functions: { id: string; description?: string }[];
};

/** What the inviter hands over: all three go to the instance that joins. */
export interface WorkspaceInvite {
  workspace: string;
  token: string;
  fingerprint: string;
}

/** API the shell preload exposes as `window.hangarShell`. */
export interface ShellApi {
  /** Language of the app, fixed until Hangar restarts. */
  readonly locale: UiLocale;
  getState(): Promise<ShellState>;
  getOverview(): Promise<OverviewView>;
  getPermissions(): Promise<PermissionsView>;
  revoke(grant: Grant): Promise<void>;
  /** Sets a stored grant (`allow`, `deny`, or `ask` for sensitive functions). */
  setGrant(subject: string, target: string, mode: GrantMode): Promise<void>;
  getJobs(): Promise<JobsView>;
  /** `server`: a job of that connected server instead of one here. */
  setJobPaused(id: string, paused: boolean, server?: string): Promise<void>;
  /** Runs a job now; resolves after the run (its result is in the next `getJobs`). */
  runJob(id: string, server?: string): Promise<void>;
  removeJob(id: string, server?: string): Promise<void>;
  /** Called whenever a job or its result changed. */
  onJobs(listener: () => void): () => void;
  getSettings(): Promise<AppSettings>;
  setUpdateChannel(channel: UpdateChannel): Promise<void>;
  /** Saves the language; it takes effect on the next start. */
  setLanguage(language: LanguageSetting): Promise<void>;
  /** Saves the color scheme and applies it at once to the shell and all bays. */
  setTheme(theme: ThemeSetting): Promise<void>;
  /** Settings of the running bays that declare some (ADR 0023). */
  getBaySettings(): Promise<BaySettingsView[]>;
  /** Saves a bay setting and tells the bay at once. */
  setBaySetting(bayId: string, key: string, value: SettingValue): Promise<void>;
  select(selection: Selection): void;
  /** Starts a bay, puts it at the end of the sidebar and selects it (ADR 0017). */
  addBay(id: string): Promise<void>;
  /** Opens the native context menu of a bay in the sidebar ("remove"). */
  bayMenu(id: string): void;
  /** Puts a bay of the app or of the local server at `index` of the sidebar (ADR 0038). */
  moveBay(id: string, index: number): void;
  /** Hides the bay views while a shell modal is open. */
  setModal(open: boolean): void;
  /** Height of the hint „Neue Version bereit“ in CSS pixels; the bay view moves below it. */
  setHintHeight(px: number): void;
  /** Opens an unpaired connection; resolves to the fingerprint to confirm. */
  probeServer(address: string): Promise<{ id: string; fingerprint: string }>;
  pairServer(probeId: string, name: string, code: string): Promise<void>;
  cancelProbe(probeId: string): void;
  /** Native menu of a server: connect or disconnect, remove. */
  serverMenu(id: string): void;
  /** Starts the local server anew in the version of this app; asks first while shells run. */
  restartLocalServer(): Promise<void>;
  openLocalServerLog(): void;
  /** The switch in the settings (ADR 0036, step 4b): `null` where there is no local server;
   * `active` is this run, `enabled` the next start; `forced`: `HANGAR_LOCAL_SERVER` decides. */
  getLocalServer(): Promise<{ enabled: boolean; active: boolean; forced?: boolean } | null>;
  setLocalServer(enabled: boolean): Promise<void>;
  relaunch(): void;
  /** Adds a path from the file dialog; resolves to false if it was cancelled (ADR 0027). */
  pickShortcut(kind: 'file' | 'folder'): Promise<boolean>;
  /** Adds a website; rejects with `Invalid URL` unless it is http or https. */
  addUrlShortcut(url: string): Promise<void>;
  /** Opens the target of a shortcut with the system. */
  openShortcut(id: string): void;
  /** Native menu of a shortcut ("remove"). */
  shortcutMenu(id: string): void;
  moveShortcut(id: string, index: number): void;
  /** Relay, workspaces and the functions that can be shared (ADR 0030). */
  getWorkspaces(): Promise<WorkspacesSettingsView>;
  /** Connects to a relay and keeps its address; rejects if it cannot be reached. */
  connectRelay(url: string): Promise<void>;
  /** Founds a workspace; needs the relay operator's token. */
  createWorkspace(name: string, operatorToken: string): Promise<void>;
  inviteToWorkspace(name: string): Promise<WorkspaceInvite>;
  /** `waiting`: joined, until the inviter adds this instance. */
  joinWorkspace(name: string, token: string, inviter: string): Promise<'trusted' | 'waiting'>;
  /** Adds an instance that joined, after comparing its fingerprint. */
  acceptMember(name: string, instance: string): Promise<void>;
  rejectMember(name: string, instance: string): Promise<void>;
  removeMember(name: string, instance: string): Promise<void>;
  /** Puts a function `<bay-id>/<name>` on the share list of a workspace, or takes it off. */
  setWorkspaceShare(name: string, target: string, on: boolean): Promise<void>;
  /** Called whenever relay, workspaces or members changed. */
  onWorkspaces(listener: () => void): () => void;
  /** Bays of the index and installed ones; `null` without an index (ADR 0034). */
  getBayCatalog(): Promise<Catalog | null>;
  /** Downloads and checks a version; nothing changes until `confirmBay`. */
  prepareBay(id: string, version: string): Promise<PreparedBay>;
  /** Keeps a prepared version for the next start; a new bay goes into the sidebar. */
  confirmBay(token: string): Promise<void>;
  cancelBay(token: string): Promise<void>;
  /** The previous version runs from the next start. */
  rollbackBay(id: string): Promise<void>;
  onState(listener: (state: ShellState) => void): () => void;
}
