import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEvent, RemoteAccess } from '@hangar/bus';
import { startCore, type Core } from './core';

let core: Core | undefined;
afterEach(async () => {
  await core?.close();
  core = undefined;
});

const start = (
  onJobsChanged = () => {},
  remote?: RemoteAccess,
  onActivity?: (e: ActivityEvent) => void,
) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hangar-core-'));
  return startCore({
    dataDir,
    ...(remote && { remote }),
    ...(onActivity && { onActivity }),
    version: '1.2.3',
    prompter: { ask: async () => 'allow' },
    cli: { execPath: '/usr/bin/node', cliPath: '/opt/hangar/cli.mjs' },
    onJobsChanged,
  }).then((c) => ((core = c), { core: c, dataDir }));
};

describe('startCore', () => {
  it('lets other instances call shared functions only with remote access (ADR 0030)', async () => {
    const caller = {
      kind: 'remote' as const,
      instance: 'f'.repeat(64),
      workspace: 'team',
      bayId: 'dev.x',
    };
    const spec = { name: 'read', sensitive: false, remote: true };
    const closed = (await start()).core;
    closed.services.provide('dev.test', spec, () => 'ok');
    await expect(closed.services.call(caller, 'dev.test/read', {})).rejects.toThrow();
    await closed.close();
    const { core } = await start(undefined, { isMember: () => true, isShared: () => true });
    core.services.provide('dev.test', spec, () => 'ok');
    await expect(core.services.call(caller, 'dev.test/read', {})).resolves.toBe('ok');
  });

  it('keeps the inbox and the activity log in the data folder (ADR 0046)', async () => {
    const caller = { kind: 'remote' as const, instance: 'SHA256:b', workspace: 'team', bayId: 'x' };
    const seen = vi.fn();
    const { core, dataDir } = await start(
      undefined,
      { isMember: () => true, isShared: () => true },
      seen,
    );
    core.services.provide(
      'dev.test',
      { name: 'add', sensitive: false, remote: true, inbox: true },
      () => 1,
    );
    const { queued } = (await core.services.call(caller, 'dev.test/add', { title: 'hi' })) as {
      queued: string;
    };
    expect(core.bus.inboxEntries().map((e) => e.id)).toEqual([queued]);
    expect(readFileSync(join(dataDir, 'inbox.json'), 'utf8')).toContain(queued);
    expect(core.activity.list()).toEqual([
      expect.objectContaining({ outcome: 'queued', preview: 'hi' }),
    ]);
    expect(readFileSync(join(dataDir, 'workspace-log.jsonl'), 'utf8')).toContain('"queued"');
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'queued' }));
    // Outgoing calls of the relay go to the same log.
    core.record({ ...core.activity.list()[0]!, direction: 'out', outcome: 'ran' });
    expect(core.activity.list()[0]).toMatchObject({ direction: 'out', outcome: 'ran' });
  });

  it('gives agent sessions a token, the MCP URL and the CLI folder, and revokes it at the end', async () => {
    const { core, dataDir } = await start();
    const cliDir = join(dataDir, 'bin');
    expect(existsSync(join(cliDir, process.platform === 'win32' ? 'hangar.cmd' : 'hangar'))).toBe(
      true,
    );

    const access = core.services.registerAgentSession('dev.test', 's1');
    expect(access).toEqual({ token: expect.any(String), mcpUrl: core.mcpUrl, cliDir });
    expect(core.tokens.resolve(access.token)).toEqual({
      kind: 'session',
      bayId: 'dev.test',
      sessionId: 's1',
    });
    const unauthorized = await fetch(core.mcpUrl, { method: 'POST', body: '{}' });
    expect(unauthorized.status).toBe(401);

    core.services.unregisterAgentSession('dev.test', 's1');
    expect(core.tokens.resolve(access.token)).toBeUndefined();
  });

  it('routes provided functions through the bus', async () => {
    const { core } = await start();
    core.services.provide('dev.test', { name: 'echo', sensitive: false }, async (args) => args);
    await expect(
      core.services.call({ kind: 'bay', bayId: 'dev.test' }, 'dev.test/echo', { a: 1 }),
    ).resolves.toEqual({ a: 1 });
  });

  it('keeps jobs in the data folder and reports changes', async () => {
    const onJobsChanged = vi.fn();
    const { core, dataDir } = await start(onJobsChanged);
    expect(core.services).toMatchObject({
      dataRoot: join(dataDir, 'bays'),
      hangarVersion: '1.2.3',
    });
    core.services.scheduler.add('dev.test', { label: 'x', schedule: '0 * * * *' });
    expect(onJobsChanged).toHaveBeenCalled();
    expect(existsSync(join(dataDir, 'jobs.json'))).toBe(true);
  });

  it('closes the MCP server', async () => {
    const { core: started } = await start();
    await started.close();
    core = undefined;
    await expect(fetch(started.mcpUrl, { method: 'POST', body: '{}' })).rejects.toThrow();
  });
});
