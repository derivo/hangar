/** Who issues a bus call. */
export type Caller =
  /**
   * A bay calling through its SDK context (bay-to-bay). `declared`: the target is in the
   * caller's manifest `uses`, set by the host, never by the caller (ADR 0032).
   */
  | { kind: 'bay'; bayId: string; declared?: boolean }
  /** An agent in a session terminal, authenticated via its MCP token. */
  | { kind: 'session'; bayId: string; sessionId: string }
  /**
   * A bay or agent of another Hangar instance (ADR 0011). `instance` is its fingerprint,
   * `workspace` comes from the authenticated header; `sessionId` is for display only.
   */
  | { kind: 'remote'; instance: string; workspace: string; bayId: string; sessionId?: string }
  /**
   * A bay or agent of the Hangar server on this machine calling a bay of the app (ADR 0036);
   * the server checked the call before, the app checks it again under its own subject.
   */
  | { kind: 'local-server'; bayId: string; sessionId?: string; declared?: boolean };

/** What the workspaces allow; the bus asks before every remote call (ADR 0011). */
export interface RemoteAccess {
  /** The instance is a member of the workspace by its current member list. */
  isMember(workspace: string, instance: string): boolean;
  /** The function `<bay-id>/<name>` is on the share list of the workspace. */
  isShared(workspace: string, target: string): boolean;
  /** Calls of inbox functions from this member run at once (ADR 0046); missing means never. */
  isTrusted?(workspace: string, instance: string): boolean;
  /** Display name of the member, for the activity log. */
  memberName?(workspace: string, instance: string): string | undefined;
}

/** A caller of another instance. */
export type RemoteCaller = Extract<Caller, { kind: 'remote' }>;

/**
 * A remote call of an inbox function waiting for the person (ADR 0046). `accepting` is
 * reserved with an execution id, so a run cut short by a crash repeats with the same id.
 */
export interface InboxEntry {
  id: string;
  /** ISO time it came in. */
  at: string;
  caller: RemoteCaller;
  target: string;
  args: unknown;
  preview: string;
  state: 'pending' | 'accepting';
  executionId?: string;
}

/** Keeps the inbox entries; the bus holds the logic. */
export interface InboxStore {
  load(): InboxEntry[];
  save(entries: InboxEntry[]): void;
}

/** One line of the activity log (ADR 0046): no arguments besides the preview, no results. */
export interface ActivityEvent {
  at: string;
  direction: 'in' | 'out';
  workspace: string;
  /** Fingerprint of the other instance. */
  instance: string;
  name?: string;
  target: string;
  outcome: 'ran' | 'queued' | 'accepted' | 'rejected' | 'denied' | 'failed';
  /** Inbox functions only: the text, cut and cleaned. */
  preview?: string;
  inboxId?: string;
}

/** Information a function handler receives about the current call. */
export interface CallInfo {
  caller: Caller;
  /** Accepted inbox entries only: handlers ignore a repeat of the same id (ADR 0046). */
  executionId?: string;
}

/** Implementation of a bay function. `args` is untrusted input and must be validated. */
export type FunctionHandler = (args: unknown, info: CallInfo) => unknown;

/** Static description of a function, as declared in the bay manifest. */
export interface FunctionSpec {
  /** Function name inside the bay, e.g. `session.setStatus`. */
  name: string;
  /** Sensitive functions are never auto-granted to agents (spec §7). */
  sensitive: boolean;
  /** Agents of every bay may call it without asking, unless denied (ADR 0016). Never sensitive. */
  openToAgents?: boolean;
  /** Other Hangar instances may call it if shared (ADR 0011). Never sensitive. */
  remote?: boolean;
  /** Only bays may call it: agents and other instances never, and it is no MCP tool (ADR 0021). */
  bayOnly?: boolean;
  /** Remote calls wait in the inbox for the person unless the member is trusted (ADR 0046). */
  inbox?: boolean;
  /** Human-readable description, shown as MCP tool description. */
  description?: string;
  /** JSON Schema of the arguments object, exposed as MCP `inputSchema`. */
  inputSchema?: Record<string, unknown>;
}

/**
 * Delivers a call to the bay that owns the function. The MVP only has the local
 * transport (handler in this process); a remote transport (Hangar Relay) implements
 * the same interface.
 */
export interface Transport {
  invoke(target: string, args: unknown, info: CallInfo): Promise<unknown>;
  /** The far side asks and keeps the rules itself; the bus only applies `bayOnly` and remote checks. */
  authorizes?: boolean;
}

/**
 * A stored permission.
 * - `allow` / `deny`: permanent decision.
 * - `session`: allowed for one agent session (kept in memory only).
 * - `ask`: confirm every single access.
 */
export type GrantMode = 'allow' | 'deny' | 'session' | 'ask';

export interface Grant {
  /**
   * Calling bay id. Agents act on behalf of the bay that owns their session. Remote
   * callers: `remote:<fingerprint>/<bay-id>`; the local server: `local-server:<bay-id>`.
   */
  subject: string;
  /** `<bay-id>/<function>`. */
  target: string;
  mode: GrantMode;
  /** Only for mode `session`. */
  sessionId?: string;
  /** ISO time the grant was given or last changed; missing in older grants. */
  grantedAt?: string;
  /** ISO time of the last allowed call through this grant since Hangar started. */
  lastUsed?: string;
}

/** What Hangar asks the user. */
export interface PermissionRequest {
  caller: Caller;
  target: string;
  sensitive: boolean;
  /**
   * `grant`: first access, the answer is stored.
   * `confirm`: the stored mode is `ask`; the answer applies to this call only.
   */
  kind: 'grant' | 'confirm';
}

/**
 * The user's answer. `allow`/`deny` for `confirm` and non-sensitive `grant`;
 * sensitive grants may also answer `session` or `ask`.
 */
export type Decision = 'allow' | 'deny' | 'session' | 'ask';

export interface Prompter {
  ask(request: PermissionRequest): Promise<Decision>;
}

export interface PermissionStore {
  list(): Grant[];
  get(subject: string, target: string): Grant | undefined;
  set(grant: Grant): void;
  remove(subject: string, target: string): void;
}
