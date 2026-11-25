// Trust of the proxy bay (ADR 0049, "Trust"): the CA per installation, the upstream roots
// for mitmproxy and the bundles that watched sessions trust.
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

/** The system's root certificates as PEM; Windows exports its `ROOT` store through Node. */
export function systemRoots(
  platform: NodeJS.Platform = process.platform,
  files = ROOT_FILES[platform] ?? [],
): string {
  if (platform === 'win32') return getCACertificates('system').join('\n');
  const file = files.find((f) => existsSync(f));
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
