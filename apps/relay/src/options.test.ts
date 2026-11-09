import { describe, expect, it } from 'vitest';
import { parseOptions } from './options';

describe('parseOptions', () => {
  const env = { HANGAR_RELAY_TOKEN: 'secret' };

  it('defaults to loopback and needs a data folder and the operator token', () => {
    expect(parseOptions(['--data', 'd'], env)).toMatchObject({
      host: '127.0.0.1',
      port: 7430,
      operatorToken: 'secret',
    });
    expect(() => parseOptions([], env)).toThrow('--data <folder> is required');
    expect(() => parseOptions(['--data', 'd'], {})).toThrow('HANGAR_RELAY_TOKEN is required');
  });

  it('reads listen address, TLS files and the public address', () => {
    expect(
      parseOptions(['--data', 'd', '--listen', '[::]:8443', '--tls-cert', 'c', '--tls-key', 'k'], {
        ...env,
        HANGAR_RELAY_URL: 'wss://relay.example.com:8443',
      }),
    ).toMatchObject({
      host: '::',
      port: 8443,
      tlsFiles: { cert: 'c', key: 'k' },
      origin: 'wss://relay.example.com:8443',
    });
    // Proofs are bound to the address instances use; beyond loopback the relay cannot guess it.
    expect(() =>
      parseOptions(
        ['--data', 'd', '--listen', '0.0.0.0:7430', '--tls-cert', 'c', '--tls-key', 'k'],
        env,
      ),
    ).toThrow('HANGAR_RELAY_URL is required beyond loopback');
    expect(() =>
      parseOptions(['--data', 'd'], { ...env, HANGAR_RELAY_URL: 'relay.example.com' }),
    ).toThrow('HANGAR_RELAY_URL must be a ws:// or wss:// address');
    expect(() => parseOptions(['--data', 'd', '--listen', 'nope'], env)).toThrow(
      '--listen must be <host>:<port>',
    );
    expect(() => parseOptions(['--data', 'd', '--tls-cert', 'c'], env)).toThrow(
      '--tls-cert and --tls-key belong together',
    );
  });
});
