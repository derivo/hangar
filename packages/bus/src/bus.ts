import { MemoryPermissionStore } from './permissions';
import type {
  Caller,
  FunctionHandler,
  FunctionSpec,
  Grant,
  GrantMode,
  PermissionStore,
  Prompter,
  RemoteAccess,
  Transport,
} from './types';

/**
 * Subject of the grants of a caller; remote ones per instance, not per bay name (ADR 0011),
 * those of the local server apart from the app's bays (ADR 0036).
 */
export const subjectOf = (caller: Caller): string =>
  caller.kind === 'remote'
    ? `remote:${caller.instance}/${caller.bayId}`
    : caller.kind === 'local-server'
      ? `local-server:${caller.bayId}`
      : caller.bayId;

/** Thrown when the user (or a stored decision) denies a call. */
export class PermissionDeniedError extends Error {
  constructor(caller: Caller, target: string) {
    super(`Access denied: ${subjectOf(caller)} → ${target}`);
    this.name = 'PermissionDeniedError';
  }
}

/** A function as known to the bus. */
export interface RegisteredFunction {
  /** `<bay-id>/<name>` – also the MCP tool name. */
  id: string;
  bayId: string;
  spec: FunctionSpec;
}

interface Entry extends RegisteredFunction {
  transport: Transport;
}

export interface BusOptions {
  permissions?: PermissionStore;
  prompter: Prompter;
  /** Workspaces for remote callers; without it every remote call is denied. */
  remote?: RemoteAccess;
  /** Clock for `grantedAt` and `lastUsed` (tests). */
  now?: () => Date;
}

/**
 * Central message bus: bays register functions, callers (bays or agent sessions)
 * call them by `<bay-id>/<function>`. Every call is authorised first (spec §7).
 */
export class Bus {
  private readonly functions = new Map<string, Entry>();
  private readonly permissions: PermissionStore;
  private readonly prompter: Prompter;
  private readonly remote?: RemoteAccess;
  private sessionGrants: Grant[] = [];
  /** Ended sessions, so an answer that arrives after the end grants nothing. */
  // Grows by one id per session; prune if sessions ever number in the millions.
  private readonly endedSessions = new Set<string>();
  /** Last successful use per grant. Memory only, a file write per call is too much. */
  private readonly lastUsed = new Map<string, string>();
  private readonly now: () => Date;

  constructor(options: BusOptions) {
    this.permissions = options.permissions ?? new MemoryPermissionStore();
    this.prompter = options.prompter;
    this.remote = options.remote;
    this.now = options.now ?? (() => new Date());
  }

  /** Registers a function implemented in this process. */
  register(bayId: string, spec: FunctionSpec, handler: FunctionHandler): void {
    this.registerTransport(bayId, spec, {
      invoke: async (_target, args, info) => handler(args, info),
    });
  }

  /** Registers a function reached through any transport (e.g. a remote Hangar). */
  registerTransport(bayId: string, spec: FunctionSpec, transport: Transport): void {
    const id = `${bayId}/${spec.name}`;
    if (this.functions.has(id)) throw new Error(`Function is already registered: ${id}`);
    this.functions.set(id, { id, bayId, spec, transport });
  }

  unregisterBay(bayId: string): void {
    for (const [id, entry] of this.functions) if (entry.bayId === bayId) this.functions.delete(id);
  }

  list(): RegisteredFunction[] {
    return [...this.functions.values()].map(({ id, bayId, spec }) => ({ id, bayId, spec }));
  }

  /** `signal`: the caller went away (local server disconnected) – nothing runs after a dialog. */
  async call(
    caller: Caller,
    target: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const entry = this.functions.get(target);
    if (!entry) throw new Error(`Unknown function: ${target}`);
    await this.authorize(caller, entry);
    signal?.throwIfAborted();
    return entry.transport.invoke(target, args, { caller });
  }

  /** Stored grants plus the in-memory session grants. */
  grants(): Grant[] {
    return [...this.permissions.list(), ...this.sessionGrants].map((g) => {
      const lastUsed = this.lastUsed.get(grantKey(g.subject, g.target, g.sessionId));
      return lastUsed ? { ...g, lastUsed } : g;
    });
  }

  /**
   * Sets a stored grant from the settings, also before the first call. Allowed modes as in
   * ADR 0006: `allow` and `deny` always, `ask` only for sensitive functions; `session` grants
   * exist only as an answer in the dialog.
   */
  setMode(subject: string, target: string, mode: GrantMode): void {
    const entry = this.functions.get(target);
    if (!entry) throw new Error(`Unknown function: ${target}`);
    if (mode === 'session') throw new Error('Session grants are only given in the dialog');
    if (subject === entry.bayId && !entry.spec.sensitive) {
      throw new Error('A bay may always use its own non-sensitive functions');
    }
    if (mode === 'ask' && !entry.spec.sensitive) {
      throw new Error('Mode "ask" is only for sensitive functions');
    }
    this.permissions.set({ subject, target, mode, grantedAt: this.now().toISOString() });
  }

  revoke(subject: string, target: string, sessionId?: string): void {
    if (sessionId) {
      this.sessionGrants = this.sessionGrants.filter(
        (g) => !(g.subject === subject && g.target === target && g.sessionId === sessionId),
      );
    } else {
      this.permissions.remove(subject, target);
    }
  }

  /** Drops the session grants of an ended session. */
  endSession(sessionId: string): void {
    this.sessionGrants = this.sessionGrants.filter((g) => g.sessionId !== sessionId);
    this.endedSessions.add(sessionId);
  }

  /** A session that ended runs again (shell restarted after a failed restore). */
  startSession(sessionId: string): void {
    this.endedSessions.delete(sessionId);
  }

  private async authorize(caller: Caller, entry: Entry): Promise<void> {
    const { id: target, spec } = entry;
    const sensitive = spec.sensitive;
    const deny = () => {
      throw new PermissionDeniedError(caller, target);
    };
    // Checked before every call and again after a dialog, so leaving the workspace or the
    // share list blocks at once.
    const remoteClosed = () =>
      caller.kind === 'remote' &&
      !(
        spec.remote === true &&
        !sensitive &&
        this.remote?.isMember(caller.workspace, caller.instance) === true &&
        this.remote.isShared(caller.workspace, target)
      );
    // Only for bays (ADR 0021): before any rule, so no grant and no dialog opens it to agents.
    if (
      spec.bayOnly &&
      caller.kind !== 'bay' &&
      (caller.kind !== 'local-server' || caller.sessionId)
    )
      return deny();
    if (caller.kind === 'remote') {
      if (remoteClosed()) return deny();
    } else if (
      caller.kind !== 'local-server' &&
      caller.bayId === entry.bayId &&
      !(sensitive && caller.kind === 'session')
    ) {
      // Own bay: a bay may always use its own functions, its agents the non-sensitive ones.
      return;
    }
    // The far side asks and keeps the rules (desktop functions of the local server, ADR 0036
    // Nachtrag); `bayOnly` and remote callers were checked above.
    if (entry.transport.authorizes) return;

    const subject = subjectOf(caller);
    const sessionId =
      caller.kind === 'session' || caller.kind === 'local-server' ? caller.sessionId : undefined;
    const used = (grantSession?: string) =>
      void this.lastUsed.set(grantKey(subject, target, grantSession), this.now().toISOString());
    const stored = this.permissions.get(subject, target);
    // A denial from the settings beats every other rule, a session grant too.
    if (stored?.mode === 'deny') return deny();
    if (
      sessionId &&
      this.sessionGrants.some(
        (g) => g.subject === subject && g.target === target && g.sessionId === sessionId,
      )
    ) {
      return used(sessionId);
    }
    const grantedAt = this.now().toISOString();

    // The dialog may stay open while the session ends or a denial is set in the settings;
    // its answer then counts for nothing.
    const ask = async (kind: 'confirm' | 'grant') => {
      const answer = await this.prompter.ask({ caller, target, sensitive, kind });
      const ended = sessionId && this.endedSessions.has(sessionId);
      return ended || remoteClosed() || this.permissions.get(subject, target)?.mode === 'deny'
        ? deny()
        : answer;
    };
    // Open to agents (ADR 0016): no dialog for agents.
    if (spec.openToAgents && !sensitive && sessionId) return used();
    // Declared in the manifest's `uses` (ADR 0032, Nachtrag): the bay's own consent, no dialog.
    const declared = (caller.kind === 'bay' || caller.kind === 'local-server') && caller.declared;
    if (declared && !sensitive && !sessionId) return used();
    if (stored?.mode === 'allow') return used();
    if (stored?.mode === 'ask') {
      return (await ask('confirm')) === 'allow' ? used() : deny();
    }

    const answer = await ask('grant');
    if (!sensitive || answer === 'allow' || answer === 'deny') {
      const mode = answer === 'allow' ? 'allow' : 'deny';
      this.permissions.set({ subject, target, mode, grantedAt });
      return mode === 'allow' ? used() : deny();
    }
    if (answer === 'ask') {
      this.permissions.set({ subject, target, mode: 'ask', grantedAt });
      return used();
    }
    // answer === 'session': remembered for an agent session; for a bay it is a one-off.
    if (sessionId) {
      this.sessionGrants.push({ subject, target, mode: 'session', sessionId, grantedAt });
      used(sessionId);
    }
  }
}

const grantKey = (subject: string, target: string, sessionId?: string) =>
  `${subject}\n${target}\n${sessionId ?? ''}`;
