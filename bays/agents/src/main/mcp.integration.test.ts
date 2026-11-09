// Milestone 5: an MCP call carrying a session token changes description and status.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Bus } from '@hangar/bus';
import { startMcpServer, TokenRegistry, type RunningMcpServer } from '@hangar/mcp';
import { createAgentsBay } from './index';
import { createTempRepo } from './test-repo';
import { fakeSpawn } from './test-pty';
import { fakeContext } from './test-ctx';

let server: RunningMcpServer | undefined;
afterEach(() => server?.close());

/** Wires the agent bay to a real bus and MCP server, like the desktop host does. */
async function setup() {
  const bus = new Bus({ prompter: { ask: async () => 'deny' } });
  const tokens = new TokenRegistry();
  server = await startMcpServer({ bus, tokens });
  const mcpUrl = server.url;
  const spawn = fakeSpawn();
  const { ctx } = fakeContext();
  // The specs of the manifest, as the host takes them (`bayOnly` keeps a function off MCP).
  const manifest = JSON.parse(
    readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'),
  ) as { functions: { name: string; sensitive: boolean }[] };
  ctx.provide.mockImplementation((name, handler, inputSchema) => {
    const spec = manifest.functions.find((f) => f.name === name)!;
    bus.register(ctx.bayId, { ...spec, inputSchema }, handler);
  });
  ctx.registerAgentSession.mockImplementation((sessionId) => ({
    token: tokens.issue(ctx.bayId, sessionId),
    mcpUrl,
    cliDir: '/unused',
  }));
  const bay = createAgentsBay(spawn);
  await bay.activate(ctx);
  const manager = bay.manager!;
  const project = await manager.addProject(createTempRepo());
  const session = await manager.createSession(project.id);
  const env = spawn.all[0]!.options.env;
  return { bay, manager, session, env };
}

async function client(url: string, token: string) {
  const c = new Client({ name: 'agent', version: '1.0.0' });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return c;
}

describe('MCP → bus → agent bay', () => {
  it('changes description and status of the session that owns the token', async () => {
    const { bay, manager, session, env } = await setup();
    expect(env.HANGAR_MCP_URL).toBe(server!.url);
    const agent = await client(env.HANGAR_MCP_URL!, env.HANGAR_TOKEN!);

    const { tools } = await agent.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'dev.hangar.agents/session.setDescription',
      'dev.hangar.agents/session.setStatus',
      'dev.hangar.agents/statusbar.set',
      'dev.hangar.agents/statusbar.remove',
      'dev.hangar.agents/job.add',
      'dev.hangar.agents/job.list',
      'dev.hangar.agents/handover.create',
      'dev.hangar.agents/handover.get',
      'dev.hangar.agents/quota.report',
    ]);
    expect(tools[1]!.inputSchema).toMatchObject({
      type: 'object',
      properties: { status: { enum: ['working', 'waiting', 'background', 'done', 'idle'] } },
    });

    await agent.callTool({
      name: 'dev.hangar.agents/session.setDescription',
      arguments: { description: 'Zahlungsseite bauen' },
    });
    await agent.callTool({
      name: 'dev.hangar.agents/session.setStatus',
      arguments: { status: 'waiting' },
    });
    expect(manager.view().sessions.find((s) => s.id === session.id)).toMatchObject({
      description: 'Zahlungsseite bauen',
      status: 'waiting',
    });

    const invalid = await agent.callTool({
      name: 'dev.hangar.agents/session.setStatus',
      arguments: { status: 'sleeping' },
    });
    expect(invalid.isError).toBe(true);
    await agent.close();
    await bay.deactivate!();
  });

  it('a restarted shell gets a new token and the old one stops working', async () => {
    const { bay, manager, session, env } = await setup();
    manager.restart(session.id);
    const res = await fetch(env.HANGAR_MCP_URL!, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.HANGAR_TOKEN}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    await bay.deactivate!();
  });
});
