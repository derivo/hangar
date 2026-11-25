import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCACertificates } from 'node:tls';
import { Ca, distrustedRoots, systemRoots } from './ca';

const ROOTS = '-----BEGIN CERTIFICATE-----\nROOTS\n-----END CERTIFICATE-----\n';
const CA = '-----BEGIN CERTIFICATE-----\nHANGAR\n-----END CERTIFICATE-----\n';
const posix = process.platform !== 'win32';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'hangar-proxy-ca-'));
  const ca = new Ca(dataDir, () => ROOTS);
  // What mitmdump writes into confdir on its first start.
  const engineStarted = () => {
    writeFileSync(join(ca.confdir, 'mitmproxy-ca.pem'), 'KEY AND CERT', { mode: 0o644 });
    writeFileSync(join(ca.confdir, 'mitmproxy-ca.p12'), 'KEY', { mode: 0o644 });
    writeFileSync(ca.certFile, CA);
  };
  return { dataDir, ca, engineStarted };
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe('Ca', () => {
  it.runIf(posix)('keeps the CA folder at 0700 and the key files at 0600', () => {
    const { ca, engineStarted } = setup();
    ca.prepare();
    expect(mode(ca.confdir)).toBe(0o700);
    chmodSync(ca.confdir, 0o755);
    ca.prepare();
    expect(mode(ca.confdir)).toBe(0o700);
    engineStarted();
    ca.secure();
    expect(mode(join(ca.confdir, 'mitmproxy-ca.pem'))).toBe(0o600);
    expect(mode(join(ca.confdir, 'mitmproxy-ca.p12'))).toBe(0o600);
  });

  it('writes the upstream roots with the extra CA file', () => {
    const { dataDir, ca } = setup();
    const company = join(dataDir, 'company.pem');
    writeFileSync(company, 'COMPANY');
    expect(readFileSync(ca.upstream(''), 'utf8')).toBe(ROOTS);
    const path = ca.upstream(company);
    expect(path).toBe(join(dataDir, 'upstream.pem'));
    expect(readFileSync(path, 'utf8')).toBe(`${ROOTS}COMPANY\n`);
    expect(() => ca.upstream(join(dataDir, 'missing.pem'))).toThrow(
      /upstreamCaFile .*missing\.pem/,
    );
  });

  it('builds a bundle from the roots, the inherited certificates and the CA', () => {
    const { dataDir, ca, engineStarted } = setup();
    ca.prepare();
    engineStarted();
    const extra = join(dataDir, 'extra.pem');
    writeFileSync(extra, 'EXTRA');
    const path = ca.bundle('s/1', {
      NODE_EXTRA_CA_CERTS: extra,
      SSL_CERT_FILE: extra,
      GIT_SSL_CAINFO: join(dataDir, 'gone.pem'),
      HOME: extra,
    });
    expect(path).toMatch(/[/\\]bundles[/\\]1[/\\]s_1-[0-9a-f]{16}\.pem$/);
    expect(readFileSync(path, 'utf8')).toBe(`${ROOTS}EXTRA\n${CA}`);
    // Same content, same file; other certificates, a new file next to it.
    expect(ca.bundle('s/1', { NODE_EXTRA_CA_CERTS: extra, SSL_CERT_FILE: extra })).toBe(path);
    const other = ca.bundle('s/1', {});
    expect(other).not.toBe(path);
    expect(readFileSync(path, 'utf8')).toBe(`${ROOTS}EXTRA\n${CA}`);
  });

  it('starts a new generation path on renewal and removes the old CA', () => {
    const { ca, engineStarted } = setup();
    ca.prepare();
    engineStarted();
    const first = ca.bundle('s1', {});
    expect(ca.renew()).toBe(2);
    expect(readdirSync(ca.confdir)).toEqual([]);
    engineStarted();
    const second = ca.bundle('s1', {});
    expect(second).toMatch(/[/\\]bundles[/\\]2[/\\]s1-/);
    expect(new Ca(ca.dataDir, () => ROOTS).generation).toBe(2);
    expect(readFileSync(first, 'utf8')).toBe(`${ROOTS}${CA}`);
  });

  it('fails a bundle without the CA with the reason', () => {
    const { ca } = setup();
    expect(() => ca.bundle('s1', {})).toThrow('The proxy CA does not exist yet');
  });
});

describe('systemRoots', () => {
  it('reads the first existing file of the platform', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-proxy-roots-'));
    const file = join(dir, 'ca-bundle.crt');
    writeFileSync(file, 'LINUX ROOTS');
    expect(systemRoots('linux', [join(dir, 'missing.crt'), file])).toBe('LINUX ROOTS');
  });

  it('fails with the reason when no source exists', () => {
    expect(() => systemRoots('linux', ['/nonexistent/a.crt'])).toThrow(
      'No system root certificates found (/nonexistent/a.crt)',
    );
  });

  it('exports the Windows store through Node', () => {
    expect(systemRoots('win32')).toContain('-----BEGIN CERTIFICATE-----');
  });

  it('joins cert.pem, the keychain and the bundled roots on macOS, each certificate once', () => {
    const pem = (name: string) => `-----BEGIN CERTIFICATE-----\n${name}\n-----END CERTIFICATE-----`;
    const dir = mkdtempSync(join(tmpdir(), 'hangar-proxy-roots-'));
    const file = join(dir, 'cert.pem');
    writeFileSync(file, `# comment\n${pem('FILE')}\n${pem('SHARED')}\n`);
    const store = (type: string) =>
      type === 'system' ? [`${pem('KEYCHAIN')}\n`, `${pem('SHARED')}\n`] : [`${pem('BUNDLED')}\n`];
    const none = () => new Set<string>();
    const roots = systemRoots('darwin', [file], store, none);
    expect(roots).toBe(`${['FILE', 'SHARED', 'KEYCHAIN', 'BUNDLED'].map(pem).join('\n')}\n`);
    expect(systemRoots('darwin', [join(dir, 'missing.pem')], store, none)).toBe(
      `${['KEYCHAIN', 'SHARED', 'BUNDLED'].map(pem).join('\n')}\n`,
    );
  });

  it('drops a root the keychain distrusts from cert.pem, the keychain and the bundled roots', () => {
    const [a, b, c, denied] = getCACertificates('bundled').map((p) => p.trim());
    const sha1 = (p: string) => new X509Certificate(p).fingerprint.replaceAll(':', '');
    const dir = mkdtempSync(join(tmpdir(), 'hangar-proxy-roots-'));
    const file = join(dir, 'cert.pem');
    writeFileSync(file, `${a}\n${denied}\n`);
    const store = (type: string) => (type === 'system' ? [b, denied] : [denied, c]);
    expect(systemRoots('darwin', [file], store, () => new Set([sha1(denied!)]))).toBe(
      `${[a, b, c].join('\n')}\n`,
    );
    expect(systemRoots('darwin', [file], store, () => new Set(['00'.repeat(20)]))).toBe(
      `${[a, denied, b, c].join('\n')}\n`,
    );
  });

  it.runIf(process.platform === 'darwin')(
    "includes cert.pem and Node's bundled roots on macOS",
    () => {
      const roots = systemRoots('darwin');
      // A root this keychain denies is dropped on purpose.
      const denied = distrustedRoots();
      const kept = (c: string) =>
        !denied.has(new X509Certificate(c).fingerprint.replaceAll(':', ''));
      const first = readFileSync('/etc/ssl/cert.pem', 'utf8').match(
        /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/,
      )![0];
      if (kept(first)) expect(roots).toContain(first);
      for (const cert of getCACertificates('bundled').filter(kept))
        expect(roots).toContain(cert.trim());
    },
  );
});

// What `security trust-settings-export` writes; certificates without `trustSettings` are
// "always trust" (an empty settings array), as in a real admin export.
const plist = (certs: Record<string, string[] | null>) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>trustList</key>
\t<dict>
${Object.entries(certs)
  .map(
    ([sha1, entries]) => `\t\t<key>${sha1}</key>
\t\t<dict>
\t\t\t<key>issuerName</key>
\t\t\t<data>
\t\t\tMBUxEzARBgNVBAMMCkhvbWVsYWIgQ0E=
\t\t\t</data>
\t\t\t<key>modDate</key>
\t\t\t<date>2026-07-30T14:32:57Z</date>
${
  entries
    ? `\t\t\t<key>trustSettings</key>
\t\t\t<array>
${entries.map((e) => `\t\t\t\t<dict>\n${e}\t\t\t\t</dict>\n`).join('')}\t\t\t</array>\n`
    : ''
}\t\t</dict>`,
  )
  .join('\n')}
\t</dict>
\t<key>trustVersion</key>
\t<integer>1</integer>
</dict>
</plist>
`;
const result = (n: number) =>
  `\t\t\t\t\t<key>kSecTrustSettingsResult</key>\n\t\t\t\t\t<integer>${n}</integer>\n`;
const policy = (oid: string) =>
  `\t\t\t\t\t<key>kSecTrustSettingsPolicy</key>\n\t\t\t\t\t<data>\n\t\t\t\t\t${oid}\n\t\t\t\t\t</data>\n`;
const SSL = 'KoZIhvdjZAED';
const SMIME = 'KoZIhvdjZAEI';
const DENY = 3;
const sha = (c: string) => c.repeat(40);

describe('distrustedRoots', () => {
  it('denies only what the first entry that applies to TLS denies', () => {
    const admin = plist({
      [sha('A')]: [result(DENY)],
      [sha('B')]: [policy(SSL) + result(DENY)],
      [sha('C')]: [policy(SMIME) + result(DENY)],
      [sha('D')]: [
        `\t\t\t\t\t<key>kSecTrustSettingsApplication</key>\n\t\t\t\t\t<data>AA==</data>\n${result(DENY)}`,
      ],
      [sha('E')]: [
        `\t\t\t\t\t<key>kSecTrustSettingsPolicyString</key>\n\t\t\t\t\t<string>example.com</string>\n${policy(SSL)}${result(DENY)}`,
      ],
      [sha('F')]: [result(1), result(DENY)],
      [sha('1')]: [policy(SMIME) + result(1), policy(SSL) + result(DENY)],
      [sha('2')]: null,
      [sha('3')]: [policy(SMIME) + result(DENY)],
    });
    expect(
      [...distrustedRoots((domain) => (domain === 'admin' ? admin : plist({})))].sort(),
    ).toEqual([sha('1'), sha('A'), sha('B')]);
  });

  it('stops at the first entry that applies to an SSL server check, as trustd does', () => {
    const key = (k: string, tag: string, v: string) =>
      `\t\t\t\t\t<key>kSecTrustSettings${k}</key>\n\t\t\t\t\t<${tag}>${v}</${tag}>\n`;
    const name = (n: string) => key('PolicyName', 'string', n);
    const BASIC = 'KoZIhvdjZAEC';
    const admin = plist({
      // Unspecified ends the search like any other result; AllowedError does not scope an entry.
      [sha('A')]: [key('AllowedError', 'integer', '-2147409654') + result(4), result(DENY)],
      // Basic X.509 is not SSL.
      [sha('B')]: [policy(BASIC) + result(1), policy(SSL) + result(DENY)],
      [sha('C')]: [policy(BASIC) + result(DENY)],
      // The policy name scopes an SSL entry to client or server.
      [sha('D')]: [
        policy(SSL) + name('sslClient') + result(1),
        policy(SSL) + name('sslServer') + result(DENY),
      ],
      [sha('E')]: [policy(SSL) + name('sslClient') + result(DENY)],
      // The OID may be a string; only kSecTrustSettingsKeyUseAny leaves the key usage open.
      [sha('F')]: [key('Policy', 'string', '1.2.840.113635.100.1.3') + result(DENY)],
      [sha('0')]: [key('KeyUsage', 'integer', '4294967295') + policy(SSL) + result(DENY)],
      [sha('1')]: [key('KeyUsage', 'integer', '1') + result(DENY)],
    });
    expect(
      [...distrustedRoots((domain) => (domain === 'admin' ? admin : plist({})))].sort(),
    ).toEqual([sha('0'), sha('B'), sha('D'), sha('F')]);
  });

  it('lets admin settings of a certificate overrule its user settings', () => {
    const admin = plist({
      [sha('A')]: [result(DENY)],
      [sha('B')]: [result(DENY)],
      [sha('C')]: null,
    });
    const user = plist({
      [sha('A')]: null,
      [sha('B')]: [policy(SMIME) + result(DENY)],
      [sha('C')]: [result(DENY)],
      [sha('D')]: [result(DENY)],
    });
    expect([...distrustedRoots((domain) => (domain === 'admin' ? admin : user))].sort()).toEqual([
      sha('A'),
      sha('B'),
      sha('D'),
    ]);
  });

  it('keeps everything without trust settings', () => {
    const empty = Object.assign(new Error('Command failed'), {
      stderr: 'SecTrustSettingsCreateExternalRepresentation: No Trust Settings were found.',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(distrustedRoots(() => plist({})).size).toBe(0);
    expect(
      distrustedRoots(() => {
        throw empty;
      }).size,
    ).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('falls back to no filter and warns once when the settings cannot be read', async () => {
    vi.resetModules();
    const fresh = await import('./ca');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fail = () => {
      throw new Error('spawnSync security ENOENT');
    };
    expect(fresh.distrustedRoots(fail).size).toBe(0);
    expect(fresh.distrustedRoots(fail).size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/^\[proxy\] .*spawnSync security ENOENT/);
    warn.mockRestore();
  });

  // Reads the real trust settings (macOS) or fails over to none (no `security`); changes nothing.
  it('reads the trust settings of this system without throwing', async () => {
    // A fresh module: an earlier warning must not hide a failed export here.
    vi.resetModules();
    const fresh = await import('./ca');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const denied = fresh.distrustedRoots();
    for (const sha1 of denied) expect(sha1).toMatch(/^[0-9A-F]{40}$/);
    if (process.platform === 'darwin') expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
