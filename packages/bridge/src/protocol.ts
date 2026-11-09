import { createHash } from 'node:crypto';
import type { Decision, FunctionSpec, PermissionRequest } from '@hangar/bus';
import type { JobView } from '@hangar/scheduler';

/**
 * Messages between a desktop and a Hangar server (ADR 0019), JSON over WebSocket at
 * `/connect`. The client says `hello` with a nonce, the server signs it; only then does
 * the client send its token (`auth`) or a pairing code (`pair`).
 */
// 2: the desktop asks for the server's jobs (phase 11d); a server that speaks only 1 would
// close the connection on `jobs`, so it rejects the desktop at `hello` instead.
// 3: the desktop offers its bays to the local server (`offer`, `reply`, ADR 0036).
// 4: the desktop manages the local server's workspaces (`workspaces`, ADR 0036, point 11).
export const PROTOCOL_VERSION = 4;

/** Versions a server accepts: the current one and the previous one. */
export const SUPPORTED_VERSIONS = [PROTOCOL_VERSION, PROTOCOL_VERSION - 1].filter((v) => v >= 1);

export interface BayInfo {
  id: string;
  version: string;
}

/** A bay's system notification (as `HangarNotification` in `@hangar/sdk`). */
export interface Notification {
  title: string;
  body?: string;
}

/** A function of a bay that runs only in the desktop app, offered to the local server (ADR 0036). */
export interface OfferedFunction {
  bayId: string;
  spec: FunctionSpec;
}

/** Who on the local server calls an offered function: a bay, or an agent of its session. */
export interface LocalCaller {
  bayId: string;
  sessionId?: string;
}

export type ClientMessage =
  | { type: 'hello'; version: number; nonce: string }
  /** `locale`: the desktop's language; the server's bays follow it (ADR 0019). */
  | { type: 'auth'; id: number; token: string; locale?: string }
  | { type: 'pair'; id: number; code: string; name: string; locale?: string }
  | { type: 'invoke'; id: number; bay: string; channel: string; args: unknown[] }
  /** The desktop's answer to `ask` (phase 11b). */
  | { type: 'answer'; id: number; decision: Decision }
  /** The server's jobs (phase 11d); the result is `JobView[]`. */
  | { type: 'jobs'; id: number }
  | { type: 'job'; id: number; action: JobAction; job: string }
  /** The functions of the desktop's own bays, for the local server only; replaces the last offer. */
  | { type: 'offer'; id: number; functions: OfferedFunction[] }
  /** What Settings → Workspaces does, on the server's workspaces (`workspaceAction` of `@hangar/host`). */
  | { type: 'workspaces'; id: number; action: string; args: (string | boolean)[] }
  /** The answer to `call`. */
  | { type: 'reply'; id: number; ok: true; value: unknown }
  | { type: 'reply'; id: number; ok: false; error: string };

/** What the desktop's job list does with a server job. */
export type JobAction = 'pause' | 'resume' | 'run' | 'remove';
export const JOB_ACTIONS: readonly JobAction[] = ['pause', 'resume', 'run', 'remove'];
export type { JobView };

export type ServerMessage =
  | { type: 'welcome'; version: number; publicKey: string; signature: string }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: string }
  | { type: 'event'; bay: string; channel: string; payload: unknown }
  /** A permission question for the person at the desktop (phase 11b); ids only increase. */
  | { type: 'ask'; id: number; request: PermissionRequest }
  /** The server gave up on a question (timeout): close its dialog, drop it if waiting. */
  | { type: 'withdraw'; id: number }
  /** A bay's notification (phase 11c); kept on the server while no desktop is connected. */
  | { type: 'notify'; bay: string; notification: Notification }
  /** A bay's badge (phase 11c); all current ones follow `auth` and `pair`. */
  | { type: 'badge'; bay: string; count: number }
  /** A job or its result changed: list them again (phase 11d). */
  | { type: 'jobs' }
  /** An offered function called on the server (ADR 0036); the desktop answers with `reply`. */
  | { type: 'call'; id: number; target: string; args: unknown; caller: LocalCaller }
  /** An agent session on the server ended: its tabs and session grants on the desktop go. */
  | { type: 'sessionEnded'; bayId: string; sessionId: string }
  /** How many agent sessions run on the server (tray, ADR 0036); also right after auth. */
  | { type: 'sessions'; count: number }
  /** The server's workspaces, members or relay connection changed: ask again. */
  | { type: 'workspaces' }
  | { type: 'error'; message: string };

/** What the server signs in `welcome`: a fixed prefix, so the key signs nothing else. */
export const signedHello = (nonce: string): Buffer =>
  Buffer.concat([Buffer.from('hangar-bridge-v1:'), Buffer.from(nonce, 'base64')]);

/** `SHA256:<base64>` of the server's public key (DER, SPKI), as in OpenSSH. */
export const fingerprint = (publicKey: string): string =>
  'SHA256:' +
  createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('base64').replace(/=+$/, '');
