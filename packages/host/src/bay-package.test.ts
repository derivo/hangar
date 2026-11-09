import { generateKeyPairSync } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { packBay, unpackBay, verifyPackage, writeTar } from './bay-package';

const keys = () => generateKeyPairSync('ed25519');
const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

function bayDir() {
  const dir = temp('hangar-pack-src-');
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      id: 'dev.hangar.notes',
      name: 'Notizen',
      version: '1.2.0',
      icon: 'icon.svg',
      ui: 'dist/ui/index.html',
      main: 'dist/main/index.js',
    }),
  );
  writeFileSync(join(dir, 'icon.svg'), '<svg/>');
  mkdirSync(join(dir, 'dist', 'ui'), { recursive: true });
  mkdirSync(join(dir, 'dist', 'main'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'ui', 'index.html'), '<!doctype html>');
  writeFileSync(join(dir, 'dist', 'main', 'index.js'), 'export default {}');
  // Sources and dependencies stay out of the package.
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'secret.ts'), 'nope');
  return dir;
}

const unpackTo = () => join(temp('hangar-unpack-'), 'bay');

describe('.bay packages (phase 19, ADR 0033)', () => {
  it('packs manifest, icon and dist, and unpacks them after the check', () => {
    const { privateKey, publicKey } = keys();
    const pkg = packBay(bayDir(), privateKey);
    expect(pkg).toMatchObject({ id: 'dev.hangar.notes', version: '1.2.0' });
    expect(pkg.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pkg.size).toBe(pkg.bytes.length);

    verifyPackage(pkg.bytes, pkg, publicKey);
    const dest = unpackTo();
    unpackBay(pkg.bytes, dest);
    expect(JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8')).id).toBe(
      'dev.hangar.notes',
    );
    expect(readFileSync(join(dest, 'dist', 'ui', 'index.html'), 'utf8')).toBe('<!doctype html>');
    expect(existsSync(join(dest, 'src'))).toBe(false);
  });

  it('packs only bays whose id starts with dev.hangar.', () => {
    const dir = bayDir();
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    for (const id of ['evil.com.hangar', 'dev.hangarx.notes', 'dev.hangar']) {
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, id }));
      expect(() => packBay(dir, keys().privateKey)).toThrow(`Invalid id in manifest: ${id}`);
    }
  });

  it('builds the same bytes twice', () => {
    const { privateKey } = keys();
    const dir = bayDir();
    expect(packBay(dir, privateKey).sha256).toBe(packBay(dir, privateKey).sha256);
  });

  it('refuses to pack a symbolic link', () => {
    const dir = bayDir();
    symlinkSync('/etc/hosts', join(dir, 'dist', 'hosts'));
    expect(() => packBay(dir, keys().privateKey)).toThrow('Symbolic link in bay: dist/hosts');
  });

  it('rejects a wrong signature', () => {
    const pkg = packBay(bayDir(), keys().privateKey);
    expect(() => verifyPackage(pkg.bytes, pkg, keys().publicKey)).toThrow(
      'Invalid package signature',
    );
  });

  it('rejects a wrong checksum', () => {
    const { privateKey, publicKey } = keys();
    const pkg = packBay(bayDir(), privateKey);
    const changed = Buffer.from(pkg.bytes);
    changed[changed.length - 1] ^= 1;
    expect(() => verifyPackage(changed, pkg, publicKey)).toThrow('Package checksum mismatch');
  });

  it.each([
    ['a parent path', '../escape.txt'],
    ['a nested parent path', 'dist/../../escape.txt'],
    ['an absolute path', '/tmp/escape.txt'],
    ['a backslash', 'dist\\..\\escape.txt'],
    ['a drive letter', 'C:/escape.txt'],
    ['an empty segment', 'dist//x'],
    // 'ascii' decoding would drop the high bit and read 0xAE 0xAE as '..'
    ['bytes outside ASCII', '\u00ae\u00ae/escape.txt'],
    // Harmless, yet 'ascii' decoding wrote it under another name (0xE9 as 'i': cafi.txt).
    ['a single byte outside ASCII', 'dist/caf\u00e9.txt'],
    ['a control character', 'dist/x\u0007.txt'],
  ])('rejects %s in the archive', (_label, path) => {
    const bytes = gzipSync(writeTar([{ path, data: Buffer.from('x') }]));
    const dest = unpackTo();
    expect(() => unpackBay(bytes, dest)).toThrow(`Unsafe path in package: ${path}`);
    expect(existsSync(join(dest, '..', 'escape.txt'))).toBe(false);
  });

  it.each([
    ['symbolic link', '2'],
    ['hard link', '1'],
    ['character device', '3'],
    ['pax header', 'x'],
  ])('rejects a %s in the archive', (_label, type) => {
    const bytes = gzipSync(
      writeTar([
        { path: 'manifest.json', data: Buffer.from('{}') },
        { path: 'link', type, linkname: '/etc/hosts' },
      ]),
    );
    expect(() => unpackBay(bytes, unpackTo())).toThrow(
      `Unsupported entry in package: link (type ${type})`,
    );
  });

  it('rejects the same path twice instead of following what the first wrote', () => {
    const bytes = gzipSync(
      writeTar([
        { path: 'a.txt', data: Buffer.from('1') },
        { path: 'a.txt', data: Buffer.from('2') },
      ]),
    );
    expect(() => unpackBay(bytes, unpackTo())).toThrow('Duplicate path in package: a.txt');
  });

  it('rejects a damaged header and a truncated archive', () => {
    const tar = writeTar([{ path: 'a.txt', data: Buffer.from('hello') }]);
    const damaged = Buffer.from(tar);
    damaged[0] ^= 1;
    expect(() => unpackBay(gzipSync(damaged), unpackTo())).toThrow('Damaged package');
    expect(() => unpackBay(Buffer.from('not gzip'), unpackTo())).toThrow('Damaged package');
    expect(() => unpackBay(gzipSync(tar.subarray(0, 600)), unpackTo())).toThrow('Damaged package');
  });

  it('rejects data cut off in the middle of a file', () => {
    const tar = writeTar([{ path: 'a.txt', data: Buffer.alloc(2000, 1) }]);
    expect(() => unpackBay(gzipSync(tar.subarray(0, 1024)), unpackTo())).toThrow('Damaged package');
  });

  // Windows has no executable bit.
  it.skipIf(process.platform === 'win32')('keeps executable files executable', () => {
    const { privateKey } = keys();
    const dir = bayDir();
    writeFileSync(join(dir, 'dist', 'run.sh'), '#!/bin/sh', { mode: 0o755 });
    const dest = unpackTo();
    unpackBay(packBay(dir, privateKey).bytes, dest);
    expect(statSync(join(dest, 'dist', 'run.sh')).mode & 0o777).toBe(0o755);
    expect(statSync(join(dest, 'manifest.json')).mode & 0o777).toBe(0o644);
  });

  it('refuses a path that does not fit a tar header', () => {
    expect(() => writeTar([{ path: 'x'.repeat(101) }])).toThrow(
      `Path too long for the package: ${'x'.repeat(101)}`,
    );
  });

  it('rejects a negative size instead of reading the same header forever (Codex review)', () => {
    const tar = writeTar([{ path: 'a.txt', data: Buffer.from('x') }]);
    tar.write('-0001000000\0', 124, 'ascii');
    tar.fill(' ', 148, 156);
    tar.write(
      `${tar
        .subarray(0, 512)
        .reduce((n, b) => n + b, 0)
        .toString(8)
        .padStart(6, '0')}\0`,
      148,
      'ascii',
    );
    expect(() => unpackBay(gzipSync(tar), unpackTo())).toThrow('Damaged package');
  });

  it('rejects deep paths and too many entries (Codex review)', () => {
    const deep = `${'d/'.repeat(32)}file`;
    expect(() =>
      unpackBay(gzipSync(writeTar([{ path: deep, data: Buffer.from('x') }])), unpackTo()),
    ).toThrow(`Path too deep in package: ${deep}`);
    const many = Array.from({ length: 10_001 }, (_, i) => ({ path: `f${i}`, type: '5' }));
    expect(() => unpackBay(gzipSync(writeTar(many)), unpackTo())).toThrow(
      'Too many entries in package',
    );
  });

  it('packs only files inside the bay (Codex review)', () => {
    const dir = bayDir();
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    writeFileSync(join(dir, '..', 'secret.pem'), 'secret');
    for (const icon of ['../secret.pem', '/etc/hosts']) {
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, icon }));
      expect(() => packBay(dir, keys().privateKey)).toThrow(`Unsafe path in bay: ${icon}`);
    }
    mkdirSync(join(dir, 'real'));
    writeFileSync(join(dir, 'real', 'icon.svg'), '<svg/>');
    symlinkSync(join(dir, 'real'), join(dir, 'linked'));
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ ...manifest, icon: 'linked/icon.svg' }),
    );
    expect(() => packBay(dir, keys().privateKey)).toThrow('Symbolic link in bay: linked');
  });

  it('refuses an id or version that is no safe file name (Codex review)', () => {
    const dir = bayDir();
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    for (const [field, value] of [
      ['version', '../../../../escape'],
      ['id', '../escape'],
    ] as const) {
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, [field]: value }));
      expect(() => packBay(dir, keys().privateKey)).toThrow(
        `Invalid ${field} in manifest: ${value}`,
      );
    }
  });

  it('unpacks only into a new folder', () => {
    const pkg = packBay(bayDir(), keys().privateKey);
    const dest = unpackTo();
    mkdirSync(dest);
    expect(() => unpackBay(pkg.bytes, dest)).toThrow(/EEXIST/);
  });

  it('keeps long paths and directories', () => {
    const long = `${'d'.repeat(80)}/${'e'.repeat(80)}/file.txt`;
    const bytes = gzipSync(
      writeTar([
        { path: 'empty', type: '5' },
        { path: long, data: Buffer.from('deep') },
      ]),
    );
    const dest = unpackTo();
    unpackBay(bytes, dest);
    expect(readFileSync(join(dest, long), 'utf8')).toBe('deep');
    expect(existsSync(join(dest, 'empty'))).toBe(true);
  });
});
