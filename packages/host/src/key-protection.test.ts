import { describe, expect, it } from 'vitest';
import { keysWithoutKeychain, takePassphrase } from './key-protection';

describe('keysWithoutKeychain', () => {
  it('stores plain without a passphrase, as before', () => {
    const keys = keysWithoutKeychain(undefined);
    expect(keys.encrypt('secret')).toBe('plain:secret');
    expect(keys.decrypt('plain:secret')).toBe('secret');
    expect(keysWithoutKeychain('').encrypt('secret')).toBe('plain:secret');
  });

  it('encrypts with the passphrase and reads it back', () => {
    const keys = keysWithoutKeychain('correct horse');
    const sealed = keys.encrypt('secret');
    expect(sealed).toMatch(/^pass:/);
    expect(sealed).not.toContain('secret');
    // A fresh salt and nonce every time.
    expect(keys.encrypt('secret')).not.toBe(sealed);
    expect(keys.decrypt(sealed)).toBe('secret');
    expect(keysWithoutKeychain('correct horse').decrypt(sealed)).toBe('secret');
  });

  it('still reads old plain keys with a passphrase set', () => {
    expect(keysWithoutKeychain('correct horse').decrypt('plain:secret')).toBe('secret');
  });

  it('refuses a wrong or missing passphrase and a damaged value', () => {
    const sealed = keysWithoutKeychain('correct horse').encrypt('secret');
    expect(() => keysWithoutKeychain('wrong').decrypt(sealed)).toThrow(
      'HANGAR_KEY_PASSPHRASE does not open the keys',
    );
    expect(() => keysWithoutKeychain(undefined).decrypt(sealed)).toThrow(
      'Keys are protected by a passphrase: set HANGAR_KEY_PASSPHRASE',
    );
    const damaged = sealed.slice(0, -4) + (sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => keysWithoutKeychain('correct horse').decrypt(damaged)).toThrow(
      'HANGAR_KEY_PASSPHRASE does not open the keys',
    );
  });

  it('refuses keys of the keychain', () => {
    expect(() => keysWithoutKeychain('x').decrypt('safe:abc')).toThrow(
      'Keys are protected by the keychain of the app',
    );
  });
});

describe('takePassphrase', () => {
  it('takes HANGAR_KEY_PASSPHRASE out of the environment and puts it back for a relaunch', () => {
    const env: NodeJS.ProcessEnv = { HANGAR_KEY_PASSPHRASE: 'correct horse', PATH: '/bin' };
    const taken = takePassphrase(env);
    expect(taken.passphrase).toBe('correct horse');
    expect(env).toEqual({ PATH: '/bin' });
    taken.restore();
    expect(env).toEqual({ HANGAR_KEY_PASSPHRASE: 'correct horse', PATH: '/bin' });
    const none: NodeJS.ProcessEnv = {};
    takePassphrase(none).restore();
    expect(none).toEqual({});
  });
});
