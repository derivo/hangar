import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Grant, PermissionStore } from './types';

/** Keeps grants in memory (tests, session-scoped use). */
export class MemoryPermissionStore implements PermissionStore {
  protected grants: Grant[] = [];

  list(): Grant[] {
    return [...this.grants];
  }

  get(subject: string, target: string): Grant | undefined {
    return this.grants.find((g) => g.subject === subject && g.target === target);
  }

  set(grant: Grant): void {
    this.grants = [...this.grants.filter((g) => !same(g, grant)), grant];
  }

  remove(subject: string, target: string): void {
    this.grants = this.grants.filter((g) => !same(g, { subject, target }));
  }
}

/** Persists grants as JSON; a missing or corrupt file means "no grants". */
export class FilePermissionStore extends MemoryPermissionStore {
  constructor(private readonly file: string) {
    super();
    if (existsSync(file)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(parsed)) this.grants = parsed as Grant[];
      } catch {
        // start empty: asking again is safe, trusting a broken file is not
      }
    }
  }

  override set(grant: Grant): void {
    super.set(grant);
    this.save();
  }

  override remove(subject: string, target: string): void {
    super.remove(subject, target);
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.grants, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }
}

const same = (a: Pick<Grant, 'subject' | 'target'>, b: Pick<Grant, 'subject' | 'target'>) =>
  a.subject === b.subject && a.target === b.target;
