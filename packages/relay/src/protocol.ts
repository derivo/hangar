import type { Envelope } from './envelope';
import type { IdentityDocument } from './identity';
import type { MemberList } from './members';

/**
 * Messages between an instance and the relay (ADR 0011), JSON over WebSocket. The relay
 * sees workspaces, fingerprints and sizes, never the content of an envelope.
 */
export const RELAY_PROTOCOL_VERSION = 1;
/** Versions the relay accepts: the current one and the previous one. */
export const RELAY_VERSIONS = [RELAY_PROTOCOL_VERSION];
/** Upper bound for one message, also enforced by the relay (`maxPayload`). */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

/**
 * What an instance signs to prove its key; a fixed prefix, so the key signs nothing else. The
 * relay's origin (`wss://host:port`) binds the proof to that relay: a malicious relay cannot pass
 * it on to log in elsewhere (review of phase 15).
 */
export const signedChallenge = (nonce: string, origin: string): Buffer =>
  Buffer.concat([
    Buffer.from(`hangar-relay-auth-v1:${new URL(origin).origin}\n`),
    Buffer.from(nonce, 'base64url'),
  ]);

export type ToRelay =
  | { type: 'hello'; versions: number[]; identity: IdentityDocument }
  | { type: 'prove'; sig: string }
  /** Creating a workspace needs the token of the relay's operator. */
  | { type: 'create'; id: number; workspace: string; token: string; list: MemberList }
  /** A single-use invitation; only members of the workspace get one. */
  | { type: 'invite'; id: number; workspace: string }
  | { type: 'join'; id: number; workspace: string; token: string }
  /** A newer signed member list for the members of the workspace. */
  | { type: 'list'; id: number; list: MemberList }
  | { type: 'send'; envelope: Envelope };

export type FromRelay =
  | { type: 'challenge'; version: number; nonce: string }
  /** Workspaces the instance belongs to on this relay, with their latest member list. */
  | { type: 'ready'; workspaces: { workspace: string; list: MemberList }[] }
  | { type: 'result'; id: number; ok: true; value?: unknown }
  | { type: 'result'; id: number; ok: false; error: string }
  | { type: 'deliver'; envelope: Envelope }
  | { type: 'list'; list: MemberList }
  /**
   * An instance joined with an invitation; a member confirms its fingerprint and adds it to
   * the member list. Repeated after `ready` while it is not in the list. `inviter` is the
   * member whose invitation it used: only that one's list is trusted by the new instance.
   */
  | { type: 'joined'; workspace: string; identity: IdentityDocument; inviter?: string }
  /**
   * The envelope did not reach its recipient, and the sender learns it at once: `offline`, it
   * is not connected; `refused`, sender or recipient is no member of the workspace here.
   */
  | {
      type: 'undeliverable';
      to: string;
      workspace: string;
      seq: number;
      reason: 'offline' | 'refused';
    }
  | { type: 'error'; message: string };
