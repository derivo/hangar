import type { EnvValue } from '../main/types';
import { t } from './messages';

/** A value written as `@secret:NAME` refers to a password of the secrets bay (ADR 0021). */
// No escape, a literal value starting with "@secret:" cannot be set; add one if asked.
const SECRET = /^@secret:(.+)$/;

/** Parses `KEY=value` lines; blank lines and `#` comments are ignored. */
export function parseEnv(text: string): Record<string, EnvValue> {
  const env: Record<string, EnvValue> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) throw new Error(t.envLineWithoutEquals(line));
    const value = line.slice(eq + 1).trim();
    const secret = SECRET.exec(value)?.[1];
    env[line.slice(0, eq).trim()] = secret ? { secret } : value;
  }
  return env;
}

export function formatEnv(env: Record<string, EnvValue>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : `@secret:${v.secret}`}`)
    .join('\n');
}
