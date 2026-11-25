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
// The SSL policy OID 1.2.840.113635.100.1.3 as the export stores it: DER data, or a string
// that SecPolicyCreateWithProperties turns into the SSL policy, server (.1) and client (.2)
// included (SecPolicyGetCompatibilityOidString).
const SSL_POLICY = new Set([
  'KoZIhvdjZAED',
  '1.2.840.113635.100.1.3',
  '1.2.840.113635.100.1.3.1',
  '1.2.840.113635.100.1.3.2',
]);

/**
 * Whether a key usage constraint applies to a root in a TLS server chain, as in trustd
 * (`SecPVCContainsTrustSettingsKeyUsage`): kSecTrustSettingsKeyUseAny, or the low 32 bits of
 * the 64-bit value equal the usage trustd computes, SignCert (8) for a non-leaf certificate.
 */
function keyUsageApplies(text: string): boolean {
  const n = BigInt(text.trim());
  return n === 0xffffffffn || (n === BigInt.asIntN(64, n) && BigInt.asUintN(32, n) === 8n);
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
 * Whether one certificate's settings deny a TLS server check: the first entry that applies
 * decides, as in trustd (`SecPVCGetTrustSettingsResult`), `Unspecified` included. An entry
 * applies when it names no application or host (`PolicyString`), its key usage is absent, any
 * or SignCert, its policy is absent or SSL and its policy name absent or `sslServer`. No
 * entry that applies (or none at all) is no deny.
 */
function deniesTls(cert: string): boolean {
  // The usage constraint dictionaries are flat (data, integer, string values only).
  const entries = (cert.match(/<dict>(?:(?!<dict>)[\s\S])*?<\/dict>/g) ?? []).filter((d) =>
    d.includes('<key>kSecTrustSettings'),
  );
  for (const entry of entries) {
    const value = (key: string) => {
      const m = new RegExp(`<key>${key}</key>\\s*<(\\w+)>([^<]*)<`).exec(entry);
      // Only base64 data may wrap; trustd compares strings as written.
      return m?.[1] === 'data' ? m[2]!.replace(/\s/g, '') : m?.[2];
    };
    if (/<key>kSecTrustSettings(Application|PolicyString)<\/key>/.test(entry)) continue;
    const usage = value('kSecTrustSettingsKeyUsage');
    if (usage !== undefined && !keyUsageApplies(usage)) continue;
    const policy = value('kSecTrustSettingsPolicy');
    if (policy !== undefined && !SSL_POLICY.has(policy)) continue;
    const name = value('kSecTrustSettingsPolicyName');
    if (name !== undefined && name !== 'sslServer') continue;
    return Number(value('kSecTrustSettingsResult') ?? 1) === DENY;
  }
  return false;
}

let warned = false;

/**
 * SHA-1 fingerprints (upper-case hex) of the certificates the keychain trust settings deny
 * for TLS. A certificate's admin settings overrule its user settings wholesale, as in trustd
 * (`SecLegacyAnchorSourceCopyUsageConstraints`); the system domain is Apple's read-only root
 * list and carries no denies. A domain without settings counts as empty.
 */
export function distrustedRoots(read = exportTrustSettings): Set<string> {
  const decided = new Map<string, boolean>();
  for (const domain of ['user', 'admin'] as const) {
    let xml: string;
    try {
      xml = read(domain);
    } catch (e) {
      const text = `${(e as { stderr?: unknown }).stderr ?? ''} ${(e as Error).message}`;
      if (!/No Trust Settings/i.test(text) && !warned) {
        warned = true;
        // shortcut: unreadable settings keep distrusted roots (warned once); show it in proxy.status if needed.
        console.warn(`[proxy] keychain trust settings not read, no root filtered: ${text.trim()}`);
      }
      continue;
    }
    const parts = xml.split(/<key>([0-9A-F]{40})<\/key>/);
    // Admin comes second and overwrites.
    for (let i = 1; i < parts.length; i += 2) decided.set(parts[i]!, deniesTls(parts[i + 1]!));
  }
  return new Set([...decided].filter(([, deny]) => deny).map(([sha1]) => sha1));
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
  distrusted: () => ReadonlySet<string> = distrustedRoots,
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
    const denied = distrusted();
    const sha1 = (c: string) => new X509Certificate(c).fingerprint.replaceAll(':', '');
    const kept = [...certs].filter((c) => !denied.size || !denied.has(sha1(c)));
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
