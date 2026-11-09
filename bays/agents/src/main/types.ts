import type { SessionStatus } from './status';

/** Every session gets a block of this many ports starting at HANGAR_PORT_BASE. */
export const PORT_BLOCK = 100;

/** A value, or a reference to a password of the secrets bay, resolved at each shell start (ADR 0021). */
export type EnvValue = string | { secret: string };

export interface Project {
  id: string;
  name: string;
  /** Repository root. */
  path: string;
  /** Env every new session of the project starts with (its own env wins). */
  env?: Record<string, EnvValue>;
  /** Sessions shown to the other instances of the workspaces (ADR 0030); absent: not shared. */
  shared?: boolean;
}

/** Git state of a session's worktree; `null` where it cannot be read. */
export interface WorktreeState {
  sessionId: string;
  changes: number | null;
  ahead: number | null;
}

/** A `hangar/*` branch whose session is gone. */
export interface OrphanBranch {
  branch: string;
  ahead: number;
}

/** What the project overview shows beyond the state. */
export interface ProjectDetails {
  worktrees: WorktreeState[];
  orphans: OrphanBranch[];
}

export type SegmentType = 'text' | 'path' | 'bar' | 'badge';

/** One segment of a session's status bar (spec §6). */
export interface StatusbarSegment {
  key: string;
  value: string;
  type: SegmentType;
  /** Maximum for `bar`; the value is then read as a number. */
  max?: number;
}

/** Colors a session tab can take; each is a `--hangar-color-tab-*` token. */
export const TAB_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
] as const;
export type TabColor = (typeof TAB_COLORS)[number];

/** A session as persisted in `state.json`. */
export interface SessionRecord {
  id: string;
  projectId: string;
  worktreePath: string;
  branch: string;
  description: string;
  status: SessionStatus;
  env: Record<string, EnvValue>;
  portBase: number;
  statusbar: StatusbarSegment[];
  createdAt: string;
  /** Tab color picked by the user; none keeps the default look. */
  color?: TabColor;
  /**
   * `project`: the shell runs in the project folder, without worktree and branch
   * (`worktreePath` is the project path, `branch` empty; ADR 0022). Absent: own worktree.
   */
  place?: 'project';
  /** Selecting in the terminal copies to the clipboard (ADR 0023); absent (older sessions): on. */
  copyOnSelect?: boolean;
  /** Work another session or instance handed over to this one (ADR 0031). */
  handover?: Handover;
}

/** A handover: text and Git references only, never files (ADR 0031). */
export interface Handover {
  /** `remote`: from another instance, shown as such. */
  origin: 'local' | 'remote';
  /** The sending session's description, or the instance and workspace. */
  from: string;
  task: string;
  branch?: string;
  /** Git remote of the branch (from another instance). */
  remote?: string;
  context?: string;
  at: string;
}

/** Where a new session runs (ADR 0022). */
export type SessionPlace = 'worktree' | 'project';

export interface BayState {
  projects: Project[];
  sessions: SessionRecord[];
}

/** What the UI sees of a session. */
export interface SessionView extends SessionRecord {
  running: boolean;
}

export interface StateView {
  projects: Project[];
  sessions: SessionView[];
}

/** 5-hour limit of a provider (ADR 0024). `resetsAt` in seconds since 1970. */
export interface QuotaWindow {
  usedPercent: number;
  resetsAt?: number;
}
/** The 5-hour limit, with the weekly one if the provider reports it. */
export interface Quota extends QuotaWindow {
  week?: QuotaWindow;
}
export const QUOTA_PROVIDERS = ['claude', 'codex'] as const;
export type QuotaProvider = (typeof QUOTA_PROVIDERS)[number];
export type Quotas = Partial<Record<QuotaProvider, Quota>>;
