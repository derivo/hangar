import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { canonical } from './canonical';

/** Public, self-signed description of an instance (ADR 0011). */
export interface IdentityDocument {
  v: 1;
  name: string;
  /** ISO time of creation. */
  created: string;
  /** Raw Ed25519 public key (signatures), base64url. */
  ed25519: string;
  /** Raw X25519 public key (key agreement), base64url. */
  x25519: string;
  /** Ed25519 signature over the other fields in canonical form, base64url. */
  sig: string;
}

/** An instance with its private keys. */
export interface Identity {
  document: IdentityDocument;
  fingerprint: string;
  signKey: KeyObject;
  dhKey: KeyObject;
}

/** Private keys as stored by the host (encrypted with `safeStorage` on the desktop). */
export interface StoredIdentity {
  document: IdentityDocument;
  /** PKCS#8 DER, base64. */
  ed25519: string;
  x25519: string;
}

const raw = (key: KeyObject) => key.export({ format: 'jwk' }).x!;

export const publicKey = (crv: 'Ed25519' | 'X25519', x: string) =>
  createPublicKey({ key: { kty: 'OKP', crv, x }, format: 'jwk' });

/** SHA-256 of the signed document; confirming it covers both public keys. */
export const fingerprint = (doc: IdentityDocument) =>
  createHash('sha256').update(canonical(doc)).digest('hex');

export function createIdentity(name: string, now = new Date()): Identity {
  const sig = generateKeyPairSync('ed25519');
  const dh = generateKeyPairSync('x25519');
  const unsigned = {
    v: 1 as const,
    name,
    created: now.toISOString(),
    ed25519: raw(sig.publicKey),
    x25519: raw(dh.publicKey),
  };
  const document = {
    ...unsigned,
    sig: sign(null, Buffer.from(canonical(unsigned)), sig.privateKey).toString('base64url'),
  };
  return {
    document,
    fingerprint: fingerprint(document),
    signKey: sig.privateKey,
    dhKey: dh.privateKey,
  };
}

/** Shape and self-signature of an identity document from another instance. */
export function verifyIdentity(doc: unknown): doc is IdentityDocument {
  const d = doc as Record<string, unknown> | null;
  if (typeof d !== 'object' || d === null || d.v !== 1) return false;
  if (!['name', 'created', 'ed25519', 'x25519', 'sig'].every((k) => typeof d[k] === 'string')) {
    return false;
  }
  const { sig, ...unsigned } = d as unknown as IdentityDocument;
  try {
    publicKey('X25519', unsigned.x25519);
    return verify(
      null,
      Buffer.from(canonical(unsigned)),
      publicKey('Ed25519', unsigned.ed25519),
      Buffer.from(sig, 'base64url'),
    );
  } catch {
    return false;
  }
}

export function exportIdentity(identity: Identity): StoredIdentity {
  const der = (key: KeyObject) => key.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  return {
    document: identity.document,
    ed25519: der(identity.signKey),
    x25519: der(identity.dhKey),
  };
}

/** Restores an identity; refuses keys that do not belong to the document. */
export function importIdentity(stored: StoredIdentity): Identity {
  const key = (b64: string) =>
    createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });
  const signKey = key(stored.ed25519);
  const dhKey = key(stored.x25519);
  const { document } = stored;
  if (
    !verifyIdentity(document) ||
    raw(createPublicKey(signKey)) !== document.ed25519 ||
    raw(createPublicKey(dhKey)) !== document.x25519
  ) {
    throw new Error('Stored keys do not match the identity document');
  }
  return { document, fingerprint: fingerprint(document), signKey, dhKey };
}
