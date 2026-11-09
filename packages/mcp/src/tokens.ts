import { randomBytes } from 'node:crypto';
import type { Caller } from '@hangar/bus';

/** Maps the secret token of every agent session to its caller identity. */
export class TokenRegistry {
  private readonly byToken = new Map<string, Extract<Caller, { kind: 'session' }>>();

  /** Issues a new token for a session; an older token of the same session stops working. */
  issue(bayId: string, sessionId: string): string {
    this.revoke(sessionId);
    const token = randomBytes(32).toString('hex');
    this.byToken.set(token, { kind: 'session', bayId, sessionId });
    return token;
  }

  resolve(token: string | undefined): Caller | undefined {
    return token ? this.byToken.get(token) : undefined;
  }

  revoke(sessionId: string): void {
    for (const [token, caller] of this.byToken) {
      if (caller.sessionId === sessionId) this.byToken.delete(token);
    }
  }
}
