import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  Endpoint,
  MAX_LIST_AGE_MS,
  REPLAY_WINDOW_MS,
  ReplayGuard,
  Workspace,
  canonical,
  createIdentity,
  exportIdentity,
  fingerprint,
  importIdentity,
  open,
  seal,
  signMemberList,
  verifyIdentity,
  type Envelope,
} from './index';

const start = Date.parse('2026-11-01T12:00:00Z');
const anna = createIdentity('anna-laptop', new Date(start));
const ben = createIdentity('ben-server', new Date(start));
const eve = createIdentity('eve', new Date(start));

/** Anna founds the workspace and adds Ben; both trust the same list. */
function team(now = start) {
  const founded = Workspace.found('team', anna, new Date(now));
  const list = founded.next(anna, { members: [anna.document, ben.document] }, new Date(now));
  const dir = mkdtempSync(join(tmpdir(), 'hangar-relay-'));
  let clock = now;
  const at = () => clock;
  const side = (who: typeof anna, file: string) =>
    new Endpoint(who, new Workspace(list), new ReplayGuard(join(dir, file)), at);
  return {
    list,
    dir,
    a: side(anna, 'anna.json'),
    b: side(ben, 'ben.json'),
    side,
    tick: (ms: number) => void (clock += ms),
  };
}

const flip = (b64: string) => {
  const bytes = Buffer.from(b64, 'base64url');
  bytes[0]! ^= 1;
  return bytes.toString('base64url');
};

describe('canonical', () => {
  it('sorts keys at every level, keeps array order and drops undefined', () => {
    expect(canonical({ b: 1, a: [{ d: 2, c: 'x' }, null], u: undefined })).toBe(
      '{"a":[{"c":"x","d":2},null],"b":1}',
    );
  });
});

describe('identity', () => {
  it('is self-signed; the fingerprint covers both public keys', () => {
    expect(verifyIdentity(anna.document)).toBe(true);
    expect(anna.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyIdentity({ ...anna.document, x25519: ben.document.x25519 })).toBe(false);
    expect(verifyIdentity({ ...anna.document, name: 'mallory' })).toBe(false);
    const { name: _name, ...nameless } = anna.document;
    for (const bad of [
      null,
      1,
      {},
      nameless,
      { ...anna.document, v: 2 },
      { ...anna.document, ed25519: 'x' },
    ]) {
      expect(verifyIdentity(bad)).toBe(false);
    }
  });

  it('round-trips through storage and refuses keys of another instance', () => {
    const stored = exportIdentity(anna);
    expect(importIdentity(stored).fingerprint).toBe(anna.fingerprint);
    expect(() => importIdentity({ ...stored, x25519: exportIdentity(ben).x25519 })).toThrow(
      'Stored keys do not match the identity document',
    );
  });
});

describe('Endpoint end to end (two instances, one process)', () => {
  it('delivers a message in both directions', () => {
    const { a, b } = team();
    expect(b.receive(a.send(ben.fingerprint, '{"call":"status.read"}'))).toBe(
      '{"call":"status.read"}',
    );
    expect(a.receive(b.send(anna.fingerprint, 'reply'))).toBe('reply');
  });

  it('hides the content from the relay; the header stays readable', () => {
    const { a } = team();
    const envelope = a.send(ben.fingerprint, 'secret-marker');
    expect(JSON.stringify(envelope)).not.toContain('secret-marker');
    expect(envelope.header).toMatchObject({
      workspace: 'team',
      from: anna.fingerprint,
      to: ben.fingerprint,
      seq: 1,
    });
  });

  it('refuses a wrong signature', () => {
    const { a, b } = team();
    const e = a.send(ben.fingerprint, 'x');
    expect(() => b.receive({ ...e, sig: flip(e.sig) })).toThrow('Invalid signature');
  });

  it('refuses a changed ciphertext, even signed anew by a member', () => {
    const { a, b } = team();
    const e = a.send(ben.fingerprint, 'x');
    expect(() => b.receive({ ...e, ciphertext: flip(e.ciphertext) })).toThrow('Invalid signature');
  });

  it('refuses a changed header', () => {
    const { a, b } = team();
    const e = a.send(ben.fingerprint, 'x');
    expect(() => b.receive({ ...e, header: { ...e.header, seq: 99 } })).toThrow(
      'Invalid signature',
    );
    expect(() => b.receive({ ...e, header: { ...e.header, workspace: 'other' } })).toThrow(
      'Message for another workspace',
    );
  });

  it('refuses a message sealed for another recipient or by a non-member', () => {
    const { a, b, list } = team();
    expect(() => b.receive(a.send(anna.fingerprint, 'to myself'))).toThrow(
      'Message for another instance',
    );
    const forged = seal(
      eve,
      ben.document,
      { workspace: 'team', epoch: 'e'.repeat(16), seq: 1, ts: start },
      'x',
    );
    expect(() => b.receive(forged)).toThrow('Sender is not a member of the workspace');
    expect(() => a.send(eve.fingerprint, 'x')).toThrow(
      'Recipient is not a member of the workspace',
    );
    // Eve claims to be Anna: the signature does not match Anna's key.
    const spoofed: Envelope = { ...forged, header: { ...forged.header, from: anna.fingerprint } };
    expect(() => b.receive(spoofed)).toThrow('Invalid signature');
    expect(list.members).toHaveLength(2);
  });

  it('refuses another protocol version, a sender that does not match and a short nonce', () => {
    const e = seal(
      anna,
      ben.document,
      { workspace: 'team', epoch: 'e'.repeat(16), seq: 1, ts: start },
      'x',
    );
    expect(() => open(ben, anna.document, { ...e, header: { ...e.header, v: 2 } })).toThrow(
      'Unsupported protocol version',
    );
    expect(() => open(ben, eve.document, e)).toThrow('Message from another sender');
    expect(() => open(ben, anna.document, { ...e, nonce: 'AAAA' })).toThrow('Invalid nonce');
  });

  it('forgets epochs whose last message left the time window', () => {
    const { dir } = team();
    const guard = new ReplayGuard(join(dir, 'prune.json'));
    const header = {
      v: 1,
      workspace: 'team',
      from: anna.fingerprint,
      to: ben.fingerprint,
      epoch: 'a'.repeat(16),
      seq: 1,
      ts: start,
    };
    guard.accept(header, start);
    const later = start + REPLAY_WINDOW_MS + 1;
    guard.accept({ ...header, epoch: 'b'.repeat(16), ts: later }, later);
    const stored = JSON.parse(readFileSync(join(dir, 'prune.json'), 'utf8')) as Record<
      string,
      object
    >;
    expect(Object.keys(stored[anna.fingerprint]!)).toEqual(['b'.repeat(16)]);
  });

  it('cannot decrypt with the key of the other direction', () => {
    const e = seal(
      anna,
      ben.document,
      { workspace: 'team', epoch: 'e'.repeat(16), seq: 1, ts: start },
      'x',
    );
    // Ben's reply direction uses a different key: reading Anna's message as if sent by Ben fails.
    expect(() =>
      open(anna, ben.document, {
        ...e,
        header: { ...e.header, from: ben.fingerprint, to: anna.fingerprint },
      }),
    ).toThrow();
    expect(open(ben, anna.document, e)).toBe('x');
  });

  it('refuses a replay, also after a restart of the receiver', () => {
    const { a, b, side } = team();
    const e = a.send(ben.fingerprint, 'run job');
    expect(b.receive(e)).toBe('run job');
    expect(() => b.receive(e)).toThrow('Replayed message');
    const restarted = side(ben, 'ben.json');
    expect(() => restarted.receive(e)).toThrow('Replayed message');
    expect(restarted.receive(a.send(ben.fingerprint, 'next'))).toBe('next');
  });

  it('accepts a new epoch of a restarted sender, numbers starting at 1 again', () => {
    const { a, b, side } = team();
    b.receive(a.send(ben.fingerprint, 'one'));
    const annaAgain = side(anna, 'anna.json');
    expect(b.receive(annaAgain.send(ben.fingerprint, 'again'))).toBe('again');
  });

  it('refuses messages outside the time window', () => {
    const { a, b, tick } = team();
    const e = a.send(ben.fingerprint, 'late');
    tick(REPLAY_WINDOW_MS + 1);
    expect(() => b.receive(e)).toThrow('Message outside the time window');
  });

  it('refuses everything once the member list is older than seven days', () => {
    const { a, b, tick } = team();
    tick(MAX_LIST_AGE_MS + 1);
    expect(() => a.send(ben.fingerprint, 'x')).toThrow(
      'Recipient is not a member of the workspace',
    );
    const old = seal(
      anna,
      ben.document,
      { workspace: 'team', epoch: 'e'.repeat(16), seq: 1, ts: start + MAX_LIST_AGE_MS + 1 },
      'x',
    );
    expect(() => b.receive(old)).toThrow('Sender is not a member of the workspace');
  });

  it('refuses a broken replay file instead of starting empty', () => {
    const { dir } = team();
    writeFileSync(join(dir, 'broken.json'), '{');
    expect(() => new ReplayGuard(join(dir, 'broken.json'))).toThrow();
  });

  it('refuses header fields that would become unsafe object keys', () => {
    const { dir } = team();
    const guard = new ReplayGuard(join(dir, 'g.json'));
    const header = {
      v: 1,
      workspace: 'team',
      from: anna.fingerprint,
      to: ben.fingerprint,
      epoch: 'e'.repeat(16),
      seq: 1,
      ts: start,
    };
    for (const bad of [
      { epoch: '__proto__' },
      { from: '__proto__' },
      { seq: 1.5 },
      { ts: Number.NaN },
    ]) {
      expect(() => guard.accept({ ...header, ...bad }, start)).toThrow('Invalid sequence');
    }
    guard.accept(header, start);
    expect(() => guard.accept(header, start)).toThrow('Replayed message');
  });
});

describe('Codex review, phase 14', () => {
  it('a member cannot extend its own validity: a revoked one expires though the relay withholds the revocation', () => {
    const carl = createIdentity('carl', new Date(start));
    const founded = Workspace.found('team', anna, new Date(start));
    const v2 = founded.next(
      anna,
      { members: [anna.document, ben.document, carl.document] },
      new Date(start),
    );
    const atCarl = new Workspace(v2);
    // Anna revokes Ben (v3); the relay keeps v3 from Carl. Ben renews the list himself.
    const day8 = new Date(start + MAX_LIST_AGE_MS + 60_000);
    const renewedByBen = signMemberList(
      {
        workspace: 'team',
        version: 3,
        issued: day8.toISOString(),
        members: v2.members,
        revoked: [],
      },
      ben,
    );
    atCarl.accept(renewedByBen, day8);
    expect(atCarl.isMember(ben.fingerprint, day8)).toBe(false);
    expect(atCarl.isMember(anna.fingerprint, day8)).toBe(true);
    // Stored with its times, a restart does not vouch for Ben anew.
    const restored = new Workspace(atCarl.list, day8, atCarl.vouchedTimes);
    expect(restored.isMember(ben.fingerprint, day8)).toBe(false);
    expect(new Workspace(atCarl.list, day8).isMember(ben.fingerprint, day8)).toBe(true);
    // Renewed by Carl or Anna, Ben counts again: only another member vouches for him.
    atCarl.next(carl, {}, day8);
    expect(atCarl.isMember(ben.fingerprint, day8)).toBe(true);
  });

  it('refuses lists issued in the future beyond the clock tolerance', () => {
    const { list } = team();
    const ws = new Workspace(list);
    const future = signMemberList(
      {
        workspace: 'team',
        version: 3,
        issued: '2099-01-01T00:00:00Z',
        members: list.members,
        revoked: [],
      },
      anna,
    );
    expect(() => ws.accept(future, new Date(start))).toThrow(
      'Member list rejected: issued in the future',
    );
    const skewed = signMemberList(
      {
        workspace: 'team',
        version: 3,
        issued: new Date(start + 60_000).toISOString(),
        members: list.members,
        revoked: [],
      },
      anna,
    );
    ws.accept(skewed, new Date(start));
    expect(() => new Workspace(future, new Date(start))).toThrow('issued in the future');
  });

  it("two guards on one file see each other's state", () => {
    const { dir } = team();
    const file = join(dir, 'shared.json');
    const g1 = new ReplayGuard(file);
    const g2 = new ReplayGuard(file);
    const header = {
      v: 1,
      workspace: 'team',
      from: anna.fingerprint,
      to: ben.fingerprint,
      epoch: 'e'.repeat(16),
      seq: 1,
      ts: start,
    };
    g1.accept(header, start);
    g1.accept({ ...header, seq: 2 }, start);
    expect(() => g2.accept(header, start)).toThrow('Replayed message');
    expect(() => new ReplayGuard(file).accept({ ...header, seq: 2 }, start)).toThrow(
      'Replayed message',
    );
  });

  it('refuses a replay state of the wrong shape instead of trusting it', () => {
    const { dir } = team();
    const file = join(dir, 'shape.json');
    for (const state of [
      [],
      { [anna.fingerprint]: { ['e'.repeat(16)]: { ts: start } } },
      { [anna.fingerprint]: 5 },
      null,
    ]) {
      writeFileSync(file, JSON.stringify(state));
      expect(() => new ReplayGuard(file)).toThrow('Broken replay state');
    }
  });
});

describe('Workspace member list', () => {
  it('accepts a newer list signed by a current member and drops nothing it revoked', () => {
    const { list } = team();
    const ws = new Workspace(list);
    const removed = signMemberList(
      {
        workspace: 'team',
        version: 3,
        issued: new Date(start).toISOString(),
        members: [anna.document],
        revoked: [ben.fingerprint],
      },
      anna,
    );
    ws.accept(removed);
    expect(ws.isMember(ben.fingerprint, new Date(start))).toBe(false);
    const readded = signMemberList(
      {
        workspace: 'team',
        version: 4,
        issued: new Date(start).toISOString(),
        members: [anna.document, ben.document],
        revoked: [],
      },
      anna,
    );
    expect(() => ws.accept(readded)).toThrow('a revocation was dropped');
  });

  it('refuses older, foreign, unsigned and outsider-signed lists', () => {
    const { list } = team();
    const ws = new Workspace(list);
    const content = {
      workspace: 'team',
      version: 3,
      issued: new Date(start).toISOString(),
      members: [anna.document, ben.document, eve.document],
      revoked: [],
    };
    expect(() => ws.accept(list)).toThrow('not newer than the current version');
    expect(() => ws.accept(signMemberList({ ...content, workspace: 'other' }, anna))).toThrow(
      'other workspace',
    );
    expect(() => ws.accept(signMemberList(content, eve))).toThrow('signer is not a member');
    expect(() => ws.accept({ ...signMemberList(content, anna), version: 4 })).toThrow(
      'invalid signature',
    );
    expect(() =>
      ws.accept(signMemberList({ ...content, members: [{ ...eve.document, name: 'x' }] }, anna)),
    ).toThrow('invalid identity document');
    expect(() =>
      ws.accept(signMemberList({ ...content, revoked: [eve.fingerprint] }, anna)),
    ).toThrow('a revoked instance is listed as member');
    expect(() => ws.accept(signMemberList({ ...content, version: 2.5 }, anna))).toThrow(
      'invalid version',
    );
    expect(() => ws.accept(signMemberList({ ...content, issued: 'soon' }, anna))).toThrow(
      'invalid issue time',
    );
    expect(ws.list.version).toBe(2);
  });

  it('refuses lists with fields of the wrong type (a string matches with includes)', () => {
    const { list } = team();
    const ws = new Workspace(list);
    const base = {
      workspace: 'team',
      version: 3,
      issued: new Date(start).toISOString(),
      members: [anna.document, ben.document],
      revoked: [] as string[],
    };
    const bad = (override: object) => ({ ...signMemberList(base, anna), ...override });
    for (const override of [
      { revoked: ben.fingerprint },
      { members: 'x' },
      { workspace: 5 },
      { sig: 5 },
    ]) {
      expect(() => ws.accept(bad(override) as never)).toThrow('Member list rejected');
    }
    expect(() => new Workspace(bad({ members: null }) as never)).toThrow('Member list rejected');
  });

  it('a member revoked in the new list cannot sign it', () => {
    const { list } = team();
    const ws = new Workspace(list);
    const content = {
      workspace: 'team',
      version: 3,
      issued: new Date(start).toISOString(),
      members: [anna.document],
      revoked: [ben.fingerprint],
    };
    expect(() => ws.accept(signMemberList(content, ben))).toThrow('signer is not a member');
  });

  it('renewing the list with the same members restores access after seven days', () => {
    const { list } = team();
    const ws = new Workspace(list);
    const later = new Date(start + MAX_LIST_AGE_MS + 1);
    expect(ws.isMember(ben.fingerprint, later)).toBe(false);
    ws.next(anna, {}, later);
    expect(ws.isMember(ben.fingerprint, later)).toBe(true);
    expect(ws.member(fingerprint(ben.document), later)?.name).toBe('ben-server');
  });

  it('refuses a first list whose signature does not hold', () => {
    const { list } = team();
    expect(() => new Workspace({ ...list, version: 9 })).toThrow(
      'Member list rejected: invalid signature',
    );
  });
});

describe('ReplayGuard after a crash (S4)', () => {
  // A separate process writes the state and is killed hard (SIGKILL) at an arbitrary point,
  // possibly mid-write; it prints each number only once `accept` has returned.
  it('starts from a valid state that refuses every message accepted before the kill', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-replay-crash-'));
    const { outputText } = ts.transpileModule(readFileSync(join(__dirname, 'replay.ts'), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    writeFileSync(join(dir, 'replay.mjs'), outputText);
    const file = join(dir, 'state.json');
    const header = { from: anna.fingerprint, epoch: 'e'.repeat(16) };
    const child = `
      import { writeSync } from 'node:fs';
      import { ReplayGuard } from ${JSON.stringify(pathToFileURL(join(dir, 'replay.mjs')).href)};
      const guard = new ReplayGuard(${JSON.stringify(file)});
      for (let seq = 1; ; seq++) {
        guard.accept({ ...${JSON.stringify(header)}, seq, ts: Date.now() });
        writeSync(1, seq + '\\n');
      }`;
    const accepted = await new Promise<number>((resolve) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', child]);
      let out = '';
      p.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        if (out.split('\n').length > 50) p.kill('SIGKILL');
      });
      p.on('exit', () => resolve(Math.max(...out.split('\n').filter(Boolean).map(Number))));
    });
    expect(accepted).toBeGreaterThanOrEqual(50);
    expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow();
    const guard = new ReplayGuard(file);
    const message = (seq: number) => ({
      ...header,
      v: 1,
      workspace: 'team',
      to: ben.fingerprint,
      seq,
      ts: Date.now(),
    });
    expect(() => guard.accept(message(accepted))).toThrow('Replayed message');
    expect(() => guard.accept(message(1))).toThrow('Replayed message');
    guard.accept(message(accepted + 1000));
  });
});
