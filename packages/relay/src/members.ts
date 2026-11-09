import { sign, verify } from 'node:crypto';
import { canonical } from './canonical';
import {
  fingerprint,
  publicKey,
  verifyIdentity,
  type Identity,
  type IdentityDocument,
} from './identity';

/** Calls count only while the caller's list is at most this old (ADR 0011). */
export const MAX_LIST_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Signed, versioned state of a workspace; it has no key of its own. */
export interface MemberList {
  workspace: string;
  version: number;
  /** ISO time the signer issued this version. */
  issued: string;
  members: IdentityDocument[];
  /** Fingerprints removed for good; never shrinks. */
  revoked: string[];
  /** Fingerprint of the member that signed. */
  signer: string;
  sig: string;
}

export type MemberListContent = Omit<MemberList, 'signer' | 'sig'>;

export function signMemberList(content: MemberListContent, signer: Identity): MemberList {
  const unsigned = { ...content, signer: signer.fingerprint };
  const sig = sign(null, Buffer.from(canonical(unsigned)), signer.signKey).toString('base64url');
  return { ...unsigned, sig };
}

/** Lists come from the relay: a string as `revoked` would pass every `includes`. */
function wellFormed(list: MemberList): boolean {
  const l = list as unknown as Record<string, unknown> | null;
  return !(
    typeof l !== 'object' ||
    l === null ||
    typeof l.workspace !== 'string' ||
    typeof l.signer !== 'string' ||
    typeof l.sig !== 'string' ||
    typeof l.issued !== 'string' ||
    !Array.isArray(l.members) ||
    !Array.isArray(l.revoked) ||
    !l.revoked.every((fp) => typeof fp === 'string')
  );
}

/** Why `list` is no valid list signed by one of `signers`; `undefined` if it is. */
function invalid(list: MemberList, signers: IdentityDocument[]): string | undefined {
  if (!wellFormed(list)) return 'invalid list';
  if (!Number.isSafeInteger(list.version) || list.version < 1) return 'invalid version';
  if (Number.isNaN(Date.parse(list.issued))) return 'invalid issue time';
  if (!list.members.every(verifyIdentity)) return 'invalid identity document';
  if (list.members.some((m) => list.revoked.includes(fingerprint(m)))) {
    return 'a revoked instance is listed as member';
  }
  const signer = signers.find((m) => fingerprint(m) === list.signer);
  if (!signer) return 'signer is not a member';
  const { sig, ...unsigned } = list;
  const ok = verify(
    null,
    Buffer.from(canonical(unsigned)),
    publicKey('Ed25519', signer.ed25519),
    Buffer.from(sig, 'base64url'),
  );
  return ok ? undefined : 'invalid signature';
}

/**
 * The member list an instance trusts for one workspace. The first list is trusted because its
 * fingerprints were confirmed by people; every later one must be signed by a current member.
 */
export class Workspace {
  private current: MemberList;
  /**
   * Per member the issue time of the newest list another instance signed. A list never
   * extends its own signer: a revoked member whose revocation the relay withholds expires.
   */
  private vouched: Record<string, number>;

  /**
   * The first list, or a stored one with its `vouched` times. Without them every member
   * counts as vouched at `issued`, the people confirmed the fingerprints.
   */
  constructor(list: MemberList, now = new Date(), vouched?: Record<string, number>) {
    const reason = invalid(list, list.members) ?? future(list, now);
    if (reason) throw new Error(`Member list rejected: ${reason}`);
    this.current = list;
    const issued = Date.parse(list.issued);
    this.vouched = Object.fromEntries(
      list.members.map((m) => [fingerprint(m), vouched?.[fingerprint(m)] ?? issued]),
    );
  }

  /** A new workspace with `founder` as its only member. */
  static found(name: string, founder: Identity, now = new Date()): Workspace {
    return new Workspace(
      signMemberList(
        {
          workspace: name,
          version: 1,
          issued: now.toISOString(),
          members: [founder.document],
          revoked: [],
        },
        founder,
      ),
      now,
    );
  }

  get list(): MemberList {
    return this.current;
  }

  get name(): string {
    return this.current.workspace;
  }

  /** Issue times per member, to store with the list. */
  get vouchedTimes(): Record<string, number> {
    return { ...this.vouched };
  }

  /** Takes a newer list from the relay or another member; throws if it is not trustworthy. */
  accept(next: MemberList, now = new Date()): void {
    const reject = (reason: string) => {
      throw new Error(`Member list rejected: ${reason}`);
    };
    if (!wellFormed(next)) reject('invalid list');
    if (next.workspace !== this.current.workspace) reject('other workspace');
    if (next.version <= this.current.version) reject('not newer than the current version');
    if (!this.current.revoked.every((fp) => next.revoked.includes(fp))) {
      reject('a revocation was dropped');
    }
    const active = this.current.members.filter((m) => !next.revoked.includes(fingerprint(m)));
    const reason = invalid(next, active) ?? future(next, now);
    if (reason) reject(reason);
    const issued = Date.parse(next.issued);
    this.vouched = Object.fromEntries(
      next.members.map((m) => {
        const fp = fingerprint(m);
        const before = this.vouched[fp];
        // A new member counts from this list; the signer keeps what others vouched.
        return [
          fp,
          fp === next.signer && before !== undefined ? before : Math.max(before ?? 0, issued),
        ];
      }),
    );
    this.current = next;
  }

  /** Signs and takes the next version: members changed, or the same ones to renew the age. */
  next(
    signer: Identity,
    change: Partial<Pick<MemberList, 'members' | 'revoked'>>,
    now = new Date(),
  ): MemberList {
    const list = this.draft(signer, change, now);
    this.accept(list, now);
    return list;
  }

  /** Signs the next version without taking it, for one the relay must order first. */
  draft(
    signer: Identity,
    change: Partial<Pick<MemberList, 'members' | 'revoked'>>,
    now = new Date(),
  ): MemberList {
    const { members, revoked } = { ...this.current, ...change };
    return signMemberList(
      {
        workspace: this.name,
        version: this.current.version + 1,
        issued: now.toISOString(),
        members,
        revoked,
      },
      signer,
    );
  }

  /** Identity document of a member another instance vouched for within seven days. */
  member(instance: string, now = new Date()): IdentityDocument | undefined {
    const vouched = this.vouched[instance];
    if (vouched === undefined || now.getTime() - vouched > MAX_LIST_AGE_MS) return undefined;
    return this.current.members.find((m) => fingerprint(m) === instance);
  }

  isMember(instance: string, now = new Date()): boolean {
    return this.member(instance, now) !== undefined;
  }
}

/** Clocks may differ this much; a list from further ahead would never expire. */
export const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;
const future = (list: MemberList, now: Date) =>
  Date.parse(list.issued) > now.getTime() + CLOCK_TOLERANCE_MS ? 'issued in the future' : undefined;
