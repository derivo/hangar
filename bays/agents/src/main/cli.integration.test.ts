// Milestone 6: hangar CLI commands typed in a real session shell change the session.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Bus } from '@hangar/bus';
import { startMcpServer, TokenRegistry, type RunningMcpServer } from '@hangar/mcp';
import { createAgentsBay } from './index';
import { spawnNodePty } from './pty';
import { createTempRepo } from './test-repo';
import { fakeContext } from './test-ctx';

const cliSource = resolve(import.meta.dirname, '../../../../packages/cli/src/hangar.ts');

let server: RunningMcpServer | undefined;
afterEach(() => server?.close());

/** A `hangar` executable that runs the CLI source with this Node (like Hangar's shim). */
function cliDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-bin-'));
  const shim = join(dir, 'hangar');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${cliSource}" "$@"\n`);
  chmodSync(shim, 0o755);
  return dir;
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timeout: ${what}`);
}

describe.skipIf(process.platform === 'win32')('hangar CLI in a real session shell', () => {
  it('changes status, description and status bar of its own session', async () => {
    const bus = new Bus({ prompter: { ask: async () => 'deny' } });
    const tokens = new TokenRegistry();
    server = await startMcpServer({ bus, tokens });
    const mcpUrl = server.url;
    const bin = cliDir();
    const { ctx } = fakeContext();
    ctx.provide.mockImplementation((name, handler, inputSchema) => {
      bus.register(ctx.bayId, { name, sensitive: false, inputSchema }, handler);
    });
    ctx.registerAgentSession.mockImplementation((sessionId) => ({
      token: tokens.issue(ctx.bayId, sessionId),
      mcpUrl,
      cliDir: bin,
    }));

    const previousShell = process.env.SHELL;
    process.env.SHELL = '/bin/sh';
    const bay = createAgentsBay(spawnNodePty);
    try {
      await bay.activate(ctx);
      const manager = bay.manager!;
      const project = await manager.addProject(createTempRepo());
      const { id, worktreePath } = await manager.createSession(project.id);
      const session = () => manager.view().sessions.find((s) => s.id === id)!;

      // Claude Code would find this configuration in the worktree.
      const settings = JSON.parse(
        readFileSync(join(worktreePath, '.claude', 'settings.local.json'), 'utf8'),
      );
      expect(settings.hooks.Notification[0].hooks[0].command).toBe('hangar --quiet status waiting');

      manager.input(id, 'hangar status waiting && hangar describe "Tests reparieren"\r');
      await until(() => session().status === 'waiting', 'status waiting');
      await until(() => session().description === 'Tests reparieren', 'description');

      manager.input(id, 'hangar statusbar set kontingent 42 --type bar --max 100\r');
      await until(() => session().statusbar.length === 1, 'statusbar segment');
      expect(session().statusbar).toEqual([
        { key: 'kontingent', value: '42', type: 'bar', max: 100 },
      ]);

      // The hook command form: quiet and successful even when it fails.
      manager.input(id, 'hangar --quiet status bogus; echo "exit=$?"\r');
      await until(() => manager.buffer(id).includes('exit=0'), 'quiet exit code');
      manager.input(id, 'hangar status done\r');
      await until(() => session().status === 'done', 'status done');
    } finally {
      await bay.deactivate!();
      process.env.SHELL = previousShell;
    }
  });
});
