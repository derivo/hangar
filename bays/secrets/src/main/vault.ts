import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BaySecrets } from '@hangar/sdk';
import type { messages } from './messages';

/** An entry as the UI and other bays see it: never with its value. */
export interface SecretInfo {
  name: string;
  description: string;
  updatedAt: string;
}

interface Stored extends SecretInfo {
  /** Encrypted with the keychain (`BaySecrets.encrypt`). */
  value: string;
}

/** Same rules as the agent bay's env names: the name becomes a variable of a shell. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_DESCRIPTION = 200;

/** Passwords in `vault.json`: names and descriptions plain, values encrypted (ADR 0021). */
export class Vault {
  private entries: Stored[];

  constructor(
    private readonly file: string,
    private readonly secrets: BaySecrets | undefined,
    private readonly t: ReturnType<typeof messages>,
    private readonly now = () => new Date(),
  ) {
    this.entries = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Stored[]) : [];
  }

  list(): SecretInfo[] {
    return this.entries
      .map(({ name, description, updatedAt }) => ({ name, description, updatedAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Adds or changes an entry; without `value` an existing one keeps its value. */
  save(name: string, value: string | undefined, description: string): void {
    if (!NAME.test(name)) throw new Error(this.t.invalidName(name));
    if (name.startsWith('HANGAR_')) throw new Error(this.t.reservedName(name));
    if (description.length > MAX_DESCRIPTION) throw new Error(this.t.descriptionTooLong);
    const old = this.entries.find((e) => e.name === name);
    if (value === '' || (value === undefined && !old)) throw new Error(this.t.valueMissing);
    if (!this.secrets) throw new Error(this.t.noKeychain);
    const encrypted = value === undefined ? old!.value : this.secrets.encrypt(value);
    const entry = { name, description, updatedAt: this.now().toISOString(), value: encrypted };
    this.entries = [...this.entries.filter((e) => e.name !== name), entry];
    this.write();
  }

  remove(name: string): void {
    this.entries = this.entries.filter((e) => e.name !== name);
    this.write();
  }

  /** The plain values of `names`; throws naming the first missing one. */
  resolve(names: string[]): Record<string, string> {
    // fromEntries: a name like `__proto__` stays an own key.
    return Object.fromEntries(
      names.map((name) => {
        const entry = this.entries.find((e) => e.name === name);
        if (!entry) throw new Error(`Unknown password: ${name}`);
        if (!this.secrets) throw new Error(this.t.noKeychain);
        return [name, this.secrets.decrypt(entry.value)];
      }),
    );
  }

  private write(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.entries, null, 2), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
}
