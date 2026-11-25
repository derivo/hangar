// Trust of the proxy bay (ADR 0049, "Trust"): the CA per installation, the upstream roots
// for mitmproxy and the bundles that watched sessions trust.
import { execFileSync } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCACertificates } from 'node:tls';

/** Variables of the merged environment whose certificates a bundle keeps. */
export const CERT_VARS = [
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'CODEX_CA_CERTIFICATE',
  'GIT_SSL_CAINFO',
] as const;

const ROOT_FILES: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ['/etc/ssl/cert.pem'],
  linux: ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt'],
};

const PEM = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

const DENY = 3; // kSecTrustSettingsResultDeny
const APPLE_POLICY = '1.2.840.113635.100.1.';
// DER policy OIDs (base64) that SecPolicyCopy resolves, mapped to "is SSL": the PolicyCursor.cpp
// list as SecPolicySearchCopyNext vends it (iChat and PKINIT left out). Any other DER OID makes
// copyTrustSettings (TrustSettings.cpp) abort, so the certificate has no settings in that domain.
const DATA_OIDS = new Map(
  [2, 3, 6, 7, 8, 9, 10, 11, 16, 17, 18, 19, 20].map((arc) => [
    Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 1, arc]).toString('base64'),
    arc === 3,
  ]),
);
// String OIDs (arcs below APPLE_POLICY) that SecPolicyCreateWithProperties turns into a policy
// without properties (SecPolicy.c, SecPolicy.list); .3, .3.1 and .3.2 are SSL. Any other string
// leaves the entry without a policy.
const SSL_ARCS = new Set(['3', '3.1', '3.2']);
const OTHER_ARCS = new Set(
  `2 8 9 9.1 9.2 10 11 11.1 11.2 16 17 18 19 20 21 23 24 25 26 27 30 31 32 34 35 36 39 40 41 49 50
  51 52 53 54 55 56 57 58 59 60 61 64 65 66 71 72 75 76 80 81 82 83 84 85 86 87 88 89 90 91 92 95
  96 97 98 99 100 101 102 103 104 105 106 107 108 109 111 112 113 114 116 117 119 120 121`.split(
    /\s+/,
  ),
);

type Plist = { tag: string; text: string } | Plist[] | Map<string, Plist>;

/** Reads an XML plist: dictionaries, arrays and leaves (tag and raw text). */
function parsePlist(xml: string): Plist {
  const tags = [...xml.matchAll(/<(\/?)(\w+)[^>]*?(\/?)>([^<]*)/g)];
  let i = tags.findIndex((t) => t[2] === 'plist') + 1;
  const value = (): Plist => {
    const [, , tag, empty, text] = tags[i++]!;
    if (tag === 'dict') {
      const dict = new Map<string, Plist>();
      while (!empty && tags[i]![1] !== '/') {
        const key = tags[i]![4]!;
        i += 2; // <key> and </key>
        dict.set(key, value());
      }
      if (!empty) i++;
      return dict;
    }
    if (tag === 'array') {
      const array: Plist[] = [];
      while (!empty && tags[i]![1] !== '/') array.push(value());
      if (!empty) i++;
      return array;
    }
    if (empty) return { tag: tag!, text: '' };
    i++;
    return { tag: tag!, text: text! };
  };
  return value();
}

/**
 * Whether a key usage constraint applies, as in trustd (`SecPVCContainsTrustSettingsKeyUsage`):
 * kSecTrustSettingsKeyUseAny, or the low 32 bits of the 64-bit value equal the usage trustd
 * computes for an SSL server check: SignCert (8) for a certificate that signs the chain, none
 * (0) for the leaf.
 */
function keyUsageApplies(text: string, usage: bigint): boolean {
  // A real passes Apple's validation only when it is an exact SInt32.
  const n = BigInt(Math.trunc(Number(text)));
  return n === 0xffffffffn || (n === BigInt.asIntN(64, n) && BigInt.asUintN(32, n) === usage);
}

/**
 * Whether one certificate's settings deny a TLS server check, for the certificate as signer of
 * the chain and as leaf, or `undefined` when Security.framework drops all its settings. Entries
 * are converted as `copyTrustSettings` does (one without policy, application, host, allowed
 * error, result and key usage is dropped; options are not copied; the policy OID resolved),
 * then the first entry that applies decides, as in trustd (`SecPVCGetTrustSettingsResult`),
 * `Unspecified` included. An entry applies when it names no application or host, its policy
 * is absent, unresolved or SSL, its policy name absent or `sslServer` and its key usage absent
 * or matching. No entry that applies is no deny.
 */
function deniesTls(settings: Map<string, Plist>[]): { chain: boolean; leaf: boolean } | undefined {
  const entries = settings.map((entry) => {
    const get = (key: string) =>
      entry.get(`kSecTrustSettings${key}`) as { tag: string; text: string } | undefined;
    const oid = get('Policy');
    let policy: 'ssl' | 'other' | 'none' = 'none';
    if (oid?.tag === 'data') {
      const ssl = DATA_OIDS.get(oid.text.replace(/\s/g, ''));
      if (ssl === undefined) return undefined;
      policy = ssl ? 'ssl' : 'other';
    } else if (oid) {
      const arc = oid.text.startsWith(APPLE_POLICY) ? oid.text.slice(APPLE_POLICY.length) : '';
      policy = SSL_ARCS.has(arc) ? 'ssl' : OTHER_ARCS.has(arc) ? 'other' : 'none';
    }
    const kept = ['Policy', 'Application', 'PolicyString', 'AllowedError', 'Result', 'KeyUsage'];
    return {
      kept: kept.some((k) => get(k)),
      scoped: Boolean(get('Application') || get('PolicyString')),
      policy,
      name: get('PolicyName')?.text,
      usage: get('KeyUsage')?.text,
      result: Number(get('Result')?.text ?? 1),
    };
  });
  if (entries.includes(undefined)) return undefined;
  const decide = (usage: bigint) => {
    for (const e of entries) {
      if (!e!.kept || e!.scoped || e!.policy === 'other') continue;
      if (e!.name !== undefined && e!.name !== 'sslServer') continue;
      if (e!.usage !== undefined && !keyUsageApplies(e!.usage, usage)) continue;
      return e!.result === DENY;
    }
    return false;
  };
  return { chain: decide(8n), leaf: decide(0n) };
}

/** One domain's trust settings as `security trust-settings-export` writes them (XML plist). */
function exportTrustSettings(domain: 'user' | 'admin'): string {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-trust-'));
  try {
    const file = join(dir, 'trust.plist');
    const args = ['trust-settings-export', ...(domain === 'admin' ? ['-d'] : []), file];
    execFileSync('security', args, { stdio: 'pipe' });
    return readFileSync(file, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Whether `DisableUserTrustSettings` in the system's `com.apple.security` preferences turns the
 * user domain off (`tsUserTrustSettingsDisabled`), read as `Dictionary::getBoolValue` does: a
 * boolean, the string YES in any case, or a number whose char value is not 0.
 */
export function userTrustSettingsDisabled(
  file = '/Library/Preferences/com.apple.security.plist',
): boolean {
  try {
    const args = ['-extract', 'DisableUserTrustSettings', 'xml1', '-o', '-', file];
    const xml = execFileSync('plutil', args, { stdio: 'pipe', encoding: 'utf8' });
    const { tag, text } = parsePlist(xml) as { tag: string; text: string };
    if (tag === 'string') return /^yes$/iu.test(text);
    if (tag === 'integer') return BigInt.asIntN(8, BigInt(text.trim())) !== 0n;
    if (tag !== 'real') return tag === 'true';
    // As the arm64 conversion: NaN is 0, values beyond 64 bits saturate.
    const n = Number(text.replace(/inf(inity)?/i, 'Infinity'));
    const max = 2n ** 63n;
    const int = Number.isNaN(n)
      ? 0n
      : n >= 2 ** 63
        ? max - 1n
        : n < -(2 ** 63)
          ? -max
          : BigInt(Math.trunc(n));
    return BigInt.asIntN(8, int) !== 0n;
  } catch {
    return false;
  }
}

let warned = false;

/** SHA-1 fingerprints (upper-case hex) the keychain denies, as signer of a chain and as leaf. */
export interface Distrusted {
  chain: ReadonlySet<string>;
  leaf: ReadonlySet<string>;
}

/**
 * The certificates the keychain trust settings deny for TLS. A certificate's admin settings
 * overrule its user settings wholesale, as in trustd (`SecLegacyAnchorSourceCopyUsageConstraints`);
 * the user domain counts only while `DisableUserTrustSettings` is off; the system domain is
 * Apple's read-only root list and carries no denies. A domain without settings counts as empty.
 */
export function distrustedRoots(
  read = exportTrustSettings,
  userDisabled = userTrustSettingsDisabled,
): Distrusted {
  const decided = new Map<string, { chain: boolean; leaf: boolean }>();
  for (const domain of ['user', 'admin'] as const) {
    if (domain === 'user' && userDisabled()) continue;
    const found = new Map<string, { chain: boolean; leaf: boolean }>();
    try {
      const list = (parsePlist(read(domain)) as Map<string, Plist>).get('trustList');
      for (const [sha1, cert] of list as Map<string, Map<string, Plist>>) {
        const denies = deniesTls((cert.get('trustSettings') ?? []) as Map<string, Plist>[]);
        if (denies) found.set(sha1, denies);
      }
    } catch (e) {
      const text = `${(e as { stderr?: unknown }).stderr ?? ''} ${(e as Error).message}`;
      if (!/No Trust Settings/i.test(text) && !warned) {
        warned = true;
        // shortcut: unreadable settings keep distrusted roots (warned once); show it in proxy.status if needed.
        console.warn(`[proxy] keychain trust settings not read, no root filtered: ${text.trim()}`);
      }
      continue;
    }
    // Admin comes second and overwrites.
    for (const [sha1, denies] of found) decided.set(sha1, denies);
  }
  const pick = (role: 'chain' | 'leaf') =>
    new Set([...decided].filter(([, d]) => d[role]).map(([sha1]) => sha1));
  return { chain: pick('chain'), leaf: pick('leaf') };
}

/**
 * The system's root certificates as PEM; Windows exports its `ROOT` store through Node.
 * macOS: `cert.pem` alone can lack roots the keychain and browsers trust (CI runners), so it
 * adds the keychain (`system`, enterprise CAs too) and Node's Mozilla roots, each once, and
 * drops every root the keychain trust settings deny (`distrustedRoots()`).
 */
export function systemRoots(
  platform: NodeJS.Platform = process.platform,
  files = ROOT_FILES[platform] ?? [],
  store: (type: 'system' | 'bundled') => readonly string[] = getCACertificates,
  distrusted: () => Distrusted = distrustedRoots,
): string {
  if (platform === 'win32') return store('system').join('\n');
  const file = files.find((f) => existsSync(f));
  if (platform === 'darwin') {
    const certs = new Set(
      [
        ...(file ? (readFileSync(file, 'utf8').match(PEM) ?? []) : []),
        ...store('system'),
        ...store('bundled'),
      ].map((c) => c.trim()),
    );
    const { chain, leaf } = distrusted();
    const kept = [...certs].filter((c) => {
      if (!chain.size && !leaf.size) return true;
      const x = new X509Certificate(c);
      const sha1 = x.fingerprint.replaceAll(':', '');
      // A self-signed root may also be a server's own certificate, which trustd checks as leaf.
      // Self-signed as Apple decides it (`_SecCertificateIsSelfSigned`): same names, own signature;
      // key usage does not count. shortcut: names compared case- and space-insensitively.
      const name = (n: string) => n.toLowerCase().replace(/\s+/g, ' ');
      const selfSigned = name(x.subject) === name(x.issuer) && x.verify(x.publicKey);
      return !chain.has(sha1) && !(leaf.has(sha1) && selfSigned);
    });
    return `${kept.join('\n')}\n`;
  }
  if (!file) throw new Error(`No system root certificates found (${files.join(', ')})`);
  return readFileSync(file, 'utf8');
}

const joined = (parts: string[]) => parts.map((p) => (p.endsWith('\n') ? p : `${p}\n`)).join('');

export class Ca {
  /** mitmproxy's `confdir`: the CA with its key. */
  readonly confdir: string;
  /** The CA certificate alone, without the key. */
  readonly certFile: string;
  private readonly generationFile: string;

  constructor(
    readonly dataDir: string,
    private readonly roots: () => string = systemRoots,
  ) {
    this.confdir = join(dataDir, 'ca');
    this.certFile = join(this.confdir, 'mitmproxy-ca-cert.pem');
    this.generationFile = join(dataDir, 'generation');
  }

  /** Current CA generation, 1 until the first renewal. */
  get generation(): number {
    return existsSync(this.generationFile)
      ? Number(readFileSync(this.generationFile, 'utf8')) || 1
      : 1;
  }

  /** Before mitmdump starts: the CA folder exists and only the user can enter it. */
  prepare(): void {
    mkdirSync(this.confdir, { recursive: true, mode: 0o700 });
    chmodSync(this.confdir, 0o700);
  }

  /** After mitmdump started: the files holding the key are 0600. */
  secure(): void {
    for (const name of ['mitmproxy-ca.pem', 'mitmproxy-ca.p12']) {
      const path = join(this.confdir, name);
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }

  /** Writes `upstream.pem` for `ssl_verify_upstream_trusted_ca`: system roots plus `extraFile`. */
  upstream(extraFile: string): string {
    const parts = [this.roots()];
    if (extraFile) {
      try {
        parts.push(readFileSync(extraFile, 'utf8'));
      } catch (e) {
        throw new Error(`upstreamCaFile ${extraFile}: ${(e as Error).message}`, { cause: e });
      }
    }
    const path = join(this.dataDir, 'upstream.pem');
    writeFileSync(path, joined(parts));
    return path;
  }

  /**
   * The bundle a session trusts: system roots, the certificates its environment named and
   * the CA. One file per content, never rewritten, below the current generation.
   */
  bundle(sessionId: string, env: Record<string, string | undefined>): string {
    if (!existsSync(this.certFile)) throw new Error('The proxy CA does not exist yet');
    const inherited = new Set(CERT_VARS.map((v) => env[v]).filter((p) => p && existsSync(p)));
    const content = joined([
      this.roots(),
      ...[...inherited].map((p) => readFileSync(p!, 'utf8')),
      readFileSync(this.certFile, 'utf8'),
    ]);
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
    const dir = join(this.dataDir, 'bundles', String(this.generation));
    const path = join(dir, `${sessionId.replace(/[^\w-]/g, '_')}-${hash}.pem`);
    if (!existsSync(path)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, content);
    }
    return path;
  }

  /**
   * Removes the CA and starts the next generation; mitmdump creates the new CA on its next
   * start. The caller blocks `proxy.env` and restarts the engine (ADR 0049, "Trust").
   */
  renew(): number {
    for (const name of readdirSync(this.confdir)) rmSync(join(this.confdir, name));
    const next = this.generation + 1;
    writeFileSync(this.generationFile, String(next));
    return next;
  }
}
