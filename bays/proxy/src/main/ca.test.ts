import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCACertificates } from 'node:tls';
import { Ca, systemRoots } from './ca';

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
    const roots = systemRoots('darwin', [file], store);
    expect(roots).toBe(`${['FILE', 'SHARED', 'KEYCHAIN', 'BUNDLED'].map(pem).join('\n')}\n`);
    expect(systemRoots('darwin', [join(dir, 'missing.pem')], store)).toBe(
      `${['KEYCHAIN', 'SHARED', 'BUNDLED'].map(pem).join('\n')}\n`,
    );
  });

  it.runIf(process.platform === 'darwin')(
    "includes cert.pem and Node's bundled roots on macOS",
    () => {
      const roots = systemRoots('darwin');
      const first = readFileSync('/etc/ssl/cert.pem', 'utf8').match(
        /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/,
      )![0];
      expect(roots).toContain(first);
      for (const cert of getCACertificates('bundled')) expect(roots).toContain(cert.trim());
    },
  );
});
