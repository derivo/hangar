/** Status of a session (spec §4); `background`: the agent's turn ended, a background task runs. */
export type SessionStatus = 'working' | 'waiting' | 'background' | 'done' | 'idle';

export const SESSION_STATUSES: readonly SessionStatus[] = [
  'working',
  'waiting',
  'background',
  'done',
  'idle',
];

/** Fallback heuristic: no output for this long turns `working` into `idle`. */
export const IDLE_AFTER_MS = 30_000;

export function isSessionStatus(value: unknown): value is SessionStatus {
  return SESSION_STATUSES.includes(value as SessionStatus);
}

/**
 * Output only wakes an idle session. `waiting`, `background` and `done` are reported by the agent
 * and stay until the agent (or the user) reports something else.
 */
export function afterOutput(status: SessionStatus): SessionStatus {
  return status === 'idle' ? 'working' : status;
}

export function afterQuiet(
  status: SessionStatus,
  lastOutputAt: number,
  now: number,
): SessionStatus {
  return status === 'working' && now - lastOutputAt >= IDLE_AFTER_MS ? 'idle' : status;
}
