import { sign, verify, type KeyObject } from 'node:crypto';
import { canonical } from '@hangar/relay';
import { z } from 'zod';

const IndexEntrySchema = z.object({
  // Both name folders under `<userData>/packages` (ADR 0034).
  id: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/),
  channel: z.enum(['stable', 'beta']),
  /** SHA-256 of the `.bay` file, hex. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().positive(),
  /** Ed25519 signature of the `.bay` file, base64. */
  signature: z.string().min(1),
  minHangarVersion: z.string().optional(),
  /** Path of the package relative to the index, e.g. `v1/bays/<id>/<version>.bay`. */
  url: z.string().min(1),
});

const BayIndexSchema = z.object({
  /** Counts up with every published index; an older one is refused (rollback). */
  version: z.number().int().min(0),
  /** After this date the index is refused (frozen updates). */
  expires: z.iso.datetime({ offset: true }),
  bays: z.array(IndexEntrySchema),
});

const SignedIndexSchema = z.object({ signed: BayIndexSchema, signature: z.string().min(1) });

/** One version of a bay in the index. */
export type BayIndexEntry = z.infer<typeof IndexEntrySchema>;
/** The content of `index.json` (ADR 0033). */
export type BayIndex = z.infer<typeof BayIndexSchema>;
/** `index.json` as published: the index and its Ed25519 signature over the canonical JSON. */
export interface SignedBayIndex {
  signed: BayIndex;
  signature: string;
}

/** Signs an index; for the release and for tests. */
export function signIndex(index: BayIndex, privateKey: KeyObject): SignedBayIndex {
  const signed = structuredClone(index);
  return {
    signed,
    signature: sign(null, Buffer.from(canonical(signed)), privateKey).toString('base64'),
  };
}

/**
 * Checks a downloaded `index.json`: shape, signature of `publicKey`, expiry at `now` and that
 * its version is not below `lastVersion`, the highest one seen before.
 */
export function verifyIndex(
  raw: unknown,
  publicKey: KeyObject,
  { now, lastVersion = 0 }: { now: Date; lastVersion?: number },
): BayIndex {
  const parsed = SignedIndexSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`Malformed index: ${issue.path.join('.') || 'index'}: ${issue.message}`);
  }
  const { signed, signature } = parsed.data;
  // The raw object is what was signed; zod drops unknown keys, which would change the bytes.
  const content = (raw as { signed: unknown }).signed;
  if (!verify(null, Buffer.from(canonical(content)), publicKey, Buffer.from(signature, 'base64'))) {
    throw new Error('Invalid index signature');
  }
  if (now.getTime() > Date.parse(signed.expires)) {
    throw new Error(`Index expired on ${signed.expires}`);
  }
  if (signed.version < lastVersion) {
    throw new Error(
      `Index version ${signed.version} is older than the last one seen (${lastVersion})`,
    );
  }
  return signed;
}
