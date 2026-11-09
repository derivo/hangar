import { createPublicKey } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyPackage } from '../packages/host/src/bay-package';
import { packCommand } from './pack-bay';

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'hangar-pack-repo-'));
  const bay = join(root, 'bays', 'notes');
  mkdirSync(join(bay, 'dist'), { recursive: true });
  writeFileSync(
    join(bay, 'manifest.json'),
    JSON.stringify({ id: 'dev.hangar.notes', version: '1.0.0', icon: 'icon.svg' }),
  );
  writeFileSync(join(bay, 'icon.svg'), '<svg/>');
  writeFileSync(join(bay, 'dist', 'index.html'), '<!doctype html>');
  return root;
}

describe('pnpm pack:bay (phase 19)', () => {
  it('creates a key, then packs and signs a bay by its id', () => {
    const root = repo();
    const keyFile = join(root, 'bay-key.pem');
    const [line] = packCommand(['--keygen', keyFile], {}, root);
    // Windows has no POSIX file modes.
    if (process.platform !== 'win32') expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: line!.replace('public key: ', '') },
      format: 'jwk',
    });
    expect(() => packCommand(['--keygen', keyFile], {}, root)).toThrow(/EEXIST/);

    const out = JSON.parse(
      packCommand(['dev.hangar.notes'], { HANGAR_BAY_KEY: keyFile }, root)[0]!,
    );
    expect(out).toMatchObject({ id: 'dev.hangar.notes', version: '1.0.0' });
    const bytes = readFileSync(join(root, out.file));
    const signature = readFileSync(join(root, `${out.file}.sig`), 'utf8');
    expect(out.file).toBe('dist/bays/dev.hangar.notes/1.0.0.bay');
    expect(() => verifyPackage(bytes, { sha256: out.sha256, signature }, publicKey)).not.toThrow();
  });

  it('names what is missing', () => {
    const root = repo();
    expect(() => packCommand([], {}, root)).toThrow('Usage: pnpm pack:bay');
    expect(() => packCommand(['dev.hangar.notes'], {}, root)).toThrow(
      'No signing key: --key <file> or HANGAR_BAY_KEY',
    );
    expect(() => packCommand(['dev.hangar.none', '--key', 'k'], {}, root)).toThrow(
      'No bay with the id dev.hangar.none under bays/',
    );
  });
});
