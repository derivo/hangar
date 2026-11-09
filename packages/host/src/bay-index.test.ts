import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signIndex, verifyIndex, type BayIndex } from './bay-index';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const now = new Date('2026-11-02T12:00:00Z');
const index: BayIndex = {
  version: 7,
  expires: '2026-11-16T12:00:00Z',
  bays: [
    {
      id: 'dev.hangar.notes',
      version: '1.2.0',
      channel: 'stable',
      sha256: 'a'.repeat(64),
      size: 1234,
      signature: 'c2ln',
      url: 'v1/bays/dev.hangar.notes/1.2.0.bay',
    },
  ],
};

describe('signed bay index (phase 19, ADR 0033)', () => {
  it('accepts a signed, current index that is not older than the last one', () => {
    const signed = signIndex(index, privateKey);
    expect(verifyIndex(signed, publicKey, { now, lastVersion: 7 })).toEqual(index);
    expect(verifyIndex(JSON.parse(JSON.stringify(signed)), publicKey, { now })).toEqual(index);
  });

  it('rejects a wrong signature and a changed index', () => {
    const other = generateKeyPairSync('ed25519').privateKey;
    expect(() => verifyIndex(signIndex(index, other), publicKey, { now })).toThrow(
      'Invalid index signature',
    );
    const changed = signIndex(index, privateKey);
    changed.signed.bays[0]!.sha256 = 'b'.repeat(64);
    expect(() => verifyIndex(changed, publicKey, { now })).toThrow('Invalid index signature');
  });

  it('rejects an expired index', () => {
    const signed = signIndex(index, privateKey);
    expect(() => verifyIndex(signed, publicKey, { now: new Date('2026-11-16T12:00:01Z') })).toThrow(
      'Index expired on 2026-11-16T12:00:00Z',
    );
  });

  it('rejects an index older than the last one seen', () => {
    const signed = signIndex(index, privateKey);
    expect(() => verifyIndex(signed, publicKey, { now, lastVersion: 8 })).toThrow(
      'Index version 7 is older than the last one seen (8)',
    );
  });

  it.each([
    ['no object', 'index'],
    ['no signature', { signed: index }],
    ['a fractional version', { signed: { ...index, version: 1.5 }, signature: 'x' }],
    ['no expiry date', { signed: { ...index, expires: 'soon' }, signature: 'x' }],
    [
      'a bay without checksum',
      { signed: { ...index, bays: [{ ...index.bays[0], sha256: 'x' }] }, signature: 'x' },
    ],
    [
      'an id that is no folder name',
      { signed: { ...index, bays: [{ ...index.bays[0], id: '../x' }] }, signature: 'x' },
    ],
    [
      'a version that is no folder name',
      { signed: { ...index, bays: [{ ...index.bays[0], version: '../1.0.0' }] }, signature: 'x' },
    ],
    [
      'an unknown channel',
      { signed: { ...index, bays: [{ ...index.bays[0], channel: 'nightly' }] }, signature: 'x' },
    ],
  ])('rejects %s', (_label, raw) => {
    expect(() => verifyIndex(raw, publicKey, { now })).toThrow(/^Malformed index/);
  });
});
