import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { t } from './messages';

const exec = promisify(execFile);

/**
 * The current environment without any GIT_ variable (as the server, `apps/server/src/options.ts`):
 * they could point git at another repository (GIT_DIR, set inside git hooks) or run other
 * programs (GIT_SSH_COMMAND, GIT_ASKPASS, GIT_CONFIG_*).
 */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Any case: Windows reads environment names case-insensitively (`git_dir` is GIT_DIR there).
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^git_/i.test(k)));
}

/** Runs git without a shell (arguments are never interpolated). */
async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd, env: gitEnv() });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error((err.stderr || err.message).trim(), { cause: e });
  }
}

/** Top-level folder of the repository containing `path` (git prints `C:/…` on Windows). */
export async function repoRoot(path: string): Promise<string> {
  try {
    return resolve(await git(path, 'rev-parse', '--show-toplevel'));
  } catch (e) {
    throw new Error(t.notARepository(path), { cause: e });
  }
}

export function currentBranch(worktree: string): Promise<string> {
  return git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD');
}

/** Creates `dir` as a worktree on a new branch based on the repository's HEAD. */
/** A new worktree on a new `branch`, from `startPoint` (a branch name) or the current HEAD. */
export async function addWorktree(
  repo: string,
  dir: string,
  branch: string,
  startPoint?: string,
): Promise<void> {
  mkdirSync(dirname(dir), { recursive: true });
  await git(repo, 'worktree', 'add', '-b', branch, dir, ...(startPoint ? [startPoint] : []));
}

/**
 * Removes a worktree. Returns false (and keeps it) if it has uncommitted changes, so
 * no work is ever lost. The branch is always kept.
 */
export async function removeWorktree(repo: string, dir: string): Promise<boolean> {
  try {
    await git(repo, 'worktree', 'remove', dir);
    return true;
  } catch {
    return false;
  }
}

/** Number of changed or untracked files in a worktree. */
export async function changedFiles(worktree: string): Promise<number> {
  const out = await git(worktree, 'status', '--porcelain');
  return out ? out.split('\n').length : 0;
}

/** Commits on `branch` that the repository's checked-out HEAD does not contain. */
export async function commitsAhead(repo: string, branch: string): Promise<number> {
  return Number(await git(repo, 'rev-list', '--count', `HEAD..${branch}`));
}

/** Local branches Hangar created (`hangar/*`). */
export async function hangarBranches(repo: string): Promise<string[]> {
  const out = await git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/hangar/');
  return out ? out.split('\n') : [];
}

/** Deletes a local branch, merged or not; callers decide whether that is wanted. */
export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await git(repo, 'branch', '-D', branch);
}

/** Adds ignore patterns to the repository-wide `info/exclude` (not committed). */
export async function addExcludes(worktree: string, patterns: string[]): Promise<void> {
  let common = await git(worktree, 'rev-parse', '--git-common-dir');
  if (!isAbsolute(common)) common = join(worktree, common);
  const file = join(common, 'info', 'exclude');
  mkdirSync(dirname(file), { recursive: true });
  const existing = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  const missing = patterns.filter((p) => !existing.includes(p));
  if (missing.length > 0) appendFileSync(file, `\n${missing.join('\n')}\n`);
}
