import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitIdentity } from '../shared';

const run = promisify(execFile);

/** The global git identity (`git config --global`); `installed: false` if git cannot run. */
export async function gitIdentity(env: NodeJS.ProcessEnv = process.env): Promise<GitIdentity> {
  const get = (key: string) =>
    run('git', ['config', '--global', '--get', key], { env }).then(
      ({ stdout }) => stdout.trim() || undefined,
      (e: NodeJS.ErrnoException) => {
        // Exit code 1: the key is not set. ENOENT: git is missing.
        if (e.code === 'ENOENT') throw e;
        return undefined;
      },
    );
  try {
    const [name, email] = await Promise.all([get('user.name'), get('user.email')]);
    return { installed: true, ...(name && { name }), ...(email && { email }) };
  } catch {
    return { installed: false };
  }
}
