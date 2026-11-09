// Only `node:` imports: `scripts/pack-bay.ts` loads this file with plain Node.
import { createHash, sign, verify, type KeyObject } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

const BLOCK = 512;
/** Uncompressed size limit: a package is a bundled bay, a bigger one is refused. */
const MAX_UNPACKED = 256 * 1024 * 1024;
/** Limits for what the size limit misses: directories cost no bytes in the archive. */
const MAX_ENTRIES = 10_000;
const MAX_DEPTH = 32;

/** One entry of a tar archive (ustar). */
export interface TarEntry {
  /** Relative path with `/`. */
  path: string;
  data?: Buffer;
  /** Tar type flag: `0` file (default), `5` directory; `packBay` writes only files. */
  type?: string;
  linkname?: string;
  mode?: number;
}

/** A signed `.bay` package (ADR 0033). */
export interface BayPackage {
  id: string;
  version: string;
  /** The `.bay` file: tar.gz of `manifest.json`, the icon and `dist/`. */
  bytes: Buffer;
  /** SHA-256 of `bytes`, hex. */
  sha256: string;
  size: number;
  /** Ed25519 signature of `bytes`, base64; the content of `<version>.bay.sig`. */
  signature: string;
}

const octal = (n: number, length: number) => `${n.toString(8).padStart(length - 1, '0')}\0`;

function header(entry: TarEntry, size: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  // ASCII paths only (bundled bays); non-ASCII would need pax headers.
  let name = entry.path;
  let prefix = '';
  if (name.length > 100) {
    const cut = name.indexOf('/', name.length - 101);
    if (cut < 0 || cut > 155) throw new Error(`Path too long for the package: ${entry.path}`);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  h.write(name, 0, 100, 'ascii');
  h.write(octal(entry.mode ?? 0o644, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(0, 12), 136, 'ascii');
  h.write(entry.type ?? '0', 156, 1, 'ascii');
  h.write(entry.linkname ?? '', 157, 100, 'ascii');
  h.write('ustar\u000000', 257, 'ascii');
  h.write(prefix, 345, 155, 'ascii');
  h.fill(' ', 148, 156);
  h.write(octal(checksum(h), 7), 148, 'ascii');
  return h;
}

const checksum = (h: Buffer) => h.reduce((sum, byte) => sum + byte, 0);

/** Writes a tar archive; no times, owners or other variable fields. */
export function writeTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    parts.push(header(entry, data.length), data, Buffer.alloc(-data.length & (BLOCK - 1)));
  }
  parts.push(Buffer.alloc(2 * BLOCK));
  return Buffer.concat(parts);
}

const text = (h: Buffer, start: number, length: number) =>
  h
    .subarray(start, start + length)
    // latin1 keeps every byte as it is; 'ascii' would drop the high bit (0xAE → '.')
    .toString('latin1')
    .replace(/\0.*$/s, '');

function readTar(tar: Buffer): TarEntry[] {
  const damaged = () => new Error('Damaged package');
  const entries: TarEntry[] = [];
  for (let offset = 0; ;) {
    if (offset + BLOCK > tar.length) throw damaged();
    const h = tar.subarray(offset, offset + BLOCK);
    if (h.every((b) => b === 0)) return entries;
    const stored = parseInt(text(h, 148, 8).trim(), 8);
    const blank = Buffer.from(h);
    blank.fill(' ', 148, 156);
    const sizeField = text(h, 124, 12).trim();
    const size = /^[0-7]{1,11}$/.test(sizeField) ? parseInt(sizeField, 8) : NaN;
    if (stored !== checksum(blank) || Number.isNaN(size)) throw damaged();
    const start = offset + BLOCK;
    if (start + size > tar.length) throw damaged();
    const prefix = text(h, 345, 155);
    const name = text(h, 0, 100);
    entries.push({
      path: prefix ? `${prefix}/${name}` : name,
      data: tar.subarray(start, start + size),
      type: text(h, 156, 1),
      mode: parseInt(text(h, 100, 8).trim(), 8),
    });
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
}

const unsafePath = (p: string) =>
  // Packages carry ASCII paths only: no other bytes, no control characters.
  /[^\x20-\x7e]/.test(p) ||
  p.startsWith('/') ||
  p.includes('\\') ||
  /^[a-zA-Z]:/.test(p) ||
  p.split('/').some((s) => s === '' || s === '.' || s === '..');

/**
 * Unpacks a checked package into `dest`, which must not exist yet. Only files and
 * directories inside `dest`; links, devices and every other entry are refused before
 * anything is written.
 */
export function unpackBay(bytes: Buffer, dest: string): void {
  let tar: Buffer;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED });
  } catch {
    throw new Error('Damaged package');
  }
  const entries = readTar(tar);
  if (entries.length > MAX_ENTRIES) throw new Error('Too many entries in package');
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.type === '5') entry.path = entry.path.replace(/\/$/, '');
    if (entry.type !== '0' && entry.type !== '5') {
      throw new Error(`Unsupported entry in package: ${entry.path} (type ${entry.type})`);
    }
    if (unsafePath(entry.path)) throw new Error(`Unsafe path in package: ${entry.path}`);
    if (entry.path.split('/').length > MAX_DEPTH) {
      throw new Error(`Path too deep in package: ${entry.path}`);
    }
    if (seen.has(entry.path)) throw new Error(`Duplicate path in package: ${entry.path}`);
    seen.add(entry.path);
  }
  mkdirSync(dirname(dest), { recursive: true });
  mkdirSync(dest);
  for (const entry of entries) {
    const target = join(dest, entry.path);
    if (entry.type === '5') {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    // `wx`: never through something that is already there.
    writeFileSync(target, entry.data!, { flag: 'wx', mode: entry.mode! & 0o111 ? 0o755 : 0o644 });
  }
}

function files(root: string, rel: string): string[] {
  if (unsafePath(rel)) throw new Error(`Unsafe path in bay: ${rel}`);
  // Every folder on the way, not only the end: `icon` may name a file below a link.
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const folder = parts.slice(0, i).join('/');
    if (lstatSync(join(root, folder)).isSymbolicLink()) {
      throw new Error(`Symbolic link in bay: ${folder}`);
    }
  }
  const stat = lstatSync(join(root, rel));
  if (stat.isSymbolicLink()) throw new Error(`Symbolic link in bay: ${rel}`);
  if (!stat.isDirectory()) return [rel];
  return readdirSync(join(root, rel)).flatMap((name) => files(root, `${rel}/${name}`));
}

/** Packs `manifest.json`, the icon and `dist/` of a built bay and signs the result. */
export function packBay(dir: string, privateKey: KeyObject): BayPackage {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
    id: string;
    version: string;
    icon: string;
  };
  // Both name the output file (`dist/bays/<id>/<version>.bay`). Only Hangar's own bays are
  // packed, so a package can never claim an id that looks like another publisher's.
  if (!/^dev\.hangar(\.[a-z][a-z0-9-]*)+$/.test(manifest.id)) {
    throw new Error(`Invalid id in manifest: ${manifest.id}`);
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/.test(manifest.version)) {
    throw new Error(`Invalid version in manifest: ${manifest.version}`);
  }
  const paths = [
    ...new Set(['manifest.json', manifest.icon, 'dist'].flatMap((p) => files(dir, p))),
  ].sort();
  const tar = writeTar(
    paths.map((path) => ({
      path,
      data: readFileSync(join(dir, path)),
      mode: lstatSync(join(dir, path)).mode & 0o111 ? 0o755 : 0o644,
    })),
  );
  const bytes = gzipSync(tar, { level: 9 });
  return {
    id: manifest.id,
    version: manifest.version,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    signature: sign(null, bytes, privateKey).toString('base64'),
  };
}

/** Throws unless `bytes` match the checksum and carry a valid signature of `publicKey`. */
export function verifyPackage(
  bytes: Buffer,
  expected: { sha256: string; signature: string },
  publicKey: KeyObject,
): void {
  if (createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
    throw new Error('Package checksum mismatch');
  }
  if (!verify(null, bytes, publicKey, Buffer.from(expected.signature, 'base64'))) {
    throw new Error('Invalid package signature');
  }
}
