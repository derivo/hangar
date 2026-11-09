import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

// scrypt N = 2^15, r = 8: 32 MiB, about 0.1 s per key.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const key = (passphrase: string, salt: Buffer) => scryptSync(passphrase, salt, 32, SCRYPT);

/**
 * Private keys at rest where no keychain is available (Linux without Secret Service, the
 * server): `pass:` – scrypt + AES-256-GCM with `passphrase` (`HANGAR_KEY_PASSPHRASE`) –
 * or, without one, `plain:` (file mode 600). Reads both; `safe:` only the app's keychain can.
 */
export function keysWithoutKeychain(passphrase: string | undefined) {
  return {
    encrypt(text: string): string {
      if (!passphrase) return `plain:${text}`;
      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key(passphrase, salt), iv);
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return `pass:${Buffer.concat([salt, iv, cipher.getAuthTag(), data]).toString('base64')}`;
    },
    decrypt(text: string): string {
      if (text.startsWith('plain:')) return text.slice(6);
      if (!text.startsWith('pass:'))
        throw new Error('Keys are protected by the keychain of the app');
      if (!passphrase)
        throw new Error('Keys are protected by a passphrase: set HANGAR_KEY_PASSPHRASE');
      const raw = Buffer.from(text.slice(5), 'base64');
      try {
        const decipher = createDecipheriv(
          'aes-256-gcm',
          key(passphrase, raw.subarray(0, 16)),
          raw.subarray(16, 28),
          { authTagLength: 16 },
        );
        decipher.setAuthTag(raw.subarray(28, 44));
        return Buffer.concat([decipher.update(raw.subarray(44)), decipher.final()]).toString(
          'utf8',
        );
      } catch {
        throw new Error('HANGAR_KEY_PASSPHRASE does not open the keys');
      }
    },
  };
}
