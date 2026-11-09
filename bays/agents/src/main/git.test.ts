import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addExcludes, addWorktree, currentBranch, gitEnv, removeWorktree, repoRoot } from './git';
import { createTempRepo } from './test-repo';

describe('git', () => {
  it('ignores every GIT_ variable, as the server does', () => {
    expect(
      gitEnv({
        GIT_DIR: '.git',
        GIT_SSH_COMMAND: 'malicious',
        GIT_CONFIG_COUNT: '1',
        GIT_ASKPASS: 'x',
        PATH: '/bin',
      }),
    ).toEqual({ PATH: '/bin' });
  });

  it('resolves the repository root from a sub folder', async () => {
    const repo = createTempRepo();
    expect(await repoRoot(repo)).toBe(repo);
  });

  it('rejects folders that are not a git repository', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hangar-nogit-')));
    await expect(repoRoot(dir)).rejects.toThrow('Kein Git-Repository');
  });

  it('creates a worktree on a new branch and removes it again', async () => {
    const repo = createTempRepo();
    const wt = join(mkdtempSync(join(tmpdir(), 'hangar-wt-')), 'wt');
    await addWorktree(repo, wt, 'hangar/abc');
    expect(existsSync(join(wt, 'README.md'))).toBe(true);
    expect(await currentBranch(wt)).toBe('hangar/abc');

    expect(await removeWorktree(repo, wt)).toBe(true);
    expect(existsSync(wt)).toBe(false);
  });

  it('refuses to remove a worktree with uncommitted changes', async () => {
    const repo = createTempRepo();
    const wt = join(mkdtempSync(join(tmpdir(), 'hangar-wt-')), 'wt');
    await addWorktree(repo, wt, 'hangar/dirty');
    writeFileSync(join(wt, 'new.txt'), 'x');
    expect(await removeWorktree(repo, wt)).toBe(false);
    expect(existsSync(wt)).toBe(true);
  });

  it('reports git errors with the git message', async () => {
    const repo = createTempRepo();
    const wt = join(mkdtempSync(join(tmpdir(), 'hangar-wt-')), 'wt');
    await addWorktree(repo, wt, 'hangar/x');
    await expect(addWorktree(repo, `${wt}2`, 'hangar/x')).rejects.toThrow(/hangar\/x/);
  });

  it('adds exclude patterns once to the shared info/exclude', async () => {
    const repo = createTempRepo();
    const wt = join(mkdtempSync(join(tmpdir(), 'hangar-wt-')), 'wt');
    await addWorktree(repo, wt, 'hangar/ex');
    await addExcludes(wt, ['.mcp.json', '.claude/settings.local.json']);
    await addExcludes(wt, ['.mcp.json']);
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.match(/^\.mcp\.json$/gm)).toHaveLength(1);
    expect(exclude).toContain('.claude/settings.local.json');
  });
});
