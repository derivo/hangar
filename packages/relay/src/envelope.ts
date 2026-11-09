import { diffieHellman, hkdfSync, randomBytes, sign, verify } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { canonical } from './canonical';
import { fingerprint, publicKey, type Identity, type IdentityDocument } from './identity';

export const PROTOCOL_VERSION = 1;

/** Readable by the relay, protected as associated data and by the signature. */
export interface Header {
  v: number;
  workspace: string;
  /** Fingerprint of the sender. */
  from: string;
  /** Fingerprint of the recipient. */
  to: string;
  /** Random per connection of the sender. */
  epoch: string;
  /** Counts up per sender, recipient and epoch. */
  seq: number;
  /** Milliseconds since 1970 at the sender. */
  ts: number;
}

export interface Envelope {
  header: Header;
  /** 24 bytes, base64url. */
  nonce: string;
  ciphertext: string;
  /** Ed25519 over header, nonce and ciphertext, base64url. */
  sig: string;
}

/** One key per direction: A→B never decrypts with the key of B→A. */
function directionKey(
  own: Identity,
  other: IdentityDocument,
  from: string,
  to: string,
  workspace: string,
) {
  const shared = diffieHellman({
    privateKey: own.dhKey,
    publicKey: publicKey('X25519', other.x25519),
  });
  const info = `hangar-relay/${PROTOCOL_VERSION}\n${workspace}\n${from}\n${to}`;
  return new Uint8Array(hkdfSync('sha256', shared, new Uint8Array(0), info, 32));
}

/** Signed bytes: length of the header first, so no bytes move between header and nonce. */
function signed(header: Header, nonce: Uint8Array, ciphertext: Uint8Array): Buffer {
  const head = Buffer.from(canonical(header));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(head.length);
  return Buffer.concat([length, head, nonce, ciphertext]);
}

export function seal(
  sender: Identity,
  recipient: IdentityDocument,
  header: Omit<Header, 'v' | 'from' | 'to'>,
  plaintext: string,
): Envelope {
  const full: Header = {
    v: PROTOCOL_VERSION,
    ...header,
    from: sender.fingerprint,
    to: fingerprint(recipient),
  };
  const key = directionKey(sender, recipient, full.from, full.to, full.workspace);
  const nonce = new Uint8Array(randomBytes(24));
  const aad = new Uint8Array(Buffer.from(canonical(full)));
  const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(
    new Uint8Array(Buffer.from(plaintext)),
  );
  const sig = sign(null, signed(full, nonce, ciphertext), sender.signKey);
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');
  return { header: full, nonce: b64(nonce), ciphertext: b64(ciphertext), sig: b64(sig) };
}

/** Verifies and decrypts a message from `sender` to `recipient`; throws on any mismatch. */
export function open(recipient: Identity, sender: IdentityDocument, envelope: Envelope): string {
  const { header } = envelope;
  if (header.v !== PROTOCOL_VERSION) throw new Error('Unsupported protocol version');
  if (header.to !== recipient.fingerprint) throw new Error('Message for another instance');
  if (header.from !== fingerprint(sender)) throw new Error('Message from another sender');
  const nonce = new Uint8Array(Buffer.from(envelope.nonce, 'base64url'));
  const ciphertext = new Uint8Array(Buffer.from(envelope.ciphertext, 'base64url'));
  if (nonce.length !== 24) throw new Error('Invalid nonce');
  const ok = verify(
    null,
    signed(header, nonce, ciphertext),
    publicKey('Ed25519', sender.ed25519),
    Buffer.from(envelope.sig, 'base64url'),
  );
  if (!ok) throw new Error('Invalid signature');
  const key = directionKey(recipient, sender, header.from, header.to, header.workspace);
  const aad = new Uint8Array(Buffer.from(canonical(header)));
  return Buffer.from(xchacha20poly1305(key, nonce, aad).decrypt(ciphertext)).toString();
}
