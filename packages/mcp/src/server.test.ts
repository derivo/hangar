import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Bus } from '@hangar/bus';
import { rateLimiter, startMcpServer, type RunningMcpServer } from './server';
import { TokenRegistry } from './tokens';

let server: RunningMcpServer;
let tokens: TokenRegistry;
let bus: Bus;
const echo = vi.fn((args: unknown, info: unknown) => ({ args, info }));

beforeEach(async () => {
  bus = new Bus({ prompter: { ask: async () => 'deny' } });
  bus.register(
    'dev.hangar.agents',
    {
      name: 'session.echo',
      sensitive: false,
      description: 'Echo',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    },
    echo,
  );
  bus.register('dev.hangar.other', { name: 'x.y', sensitive: false }, () => undefined);
  bus.register('dev.hangar.agents', { name: 'fail.now', sensitive: false }, () => {
    throw new Error('kaputt');
  });
  // Only for bays (ADR 0021): no tool.
  bus.register('dev.hangar.other', { name: 'inner', sensitive: true, bayOnly: true }, () => 1);
  tokens = new TokenRegistry();
  server = await startMcpServer({ bus, tokens, version: '1.2.3' });
});

afterEach(() => server.close());

async function connect(token: string) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

const post = (body: string, headers: Record<string, string> = {}, method = 'POST', path = '/mcp') =>
  fetch(server.url.replace('/mcp', path), {
    method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: method === 'POST' ? body : undefined,
  });

describe('MCP server', () => {
  it('listens on loopback and lists every bus function as tool', async () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const client = await connect(tokens.issue('dev.hangar.agents', 's1'));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'dev.hangar.agents/session.echo',
      'dev.hangar.other/x.y',
      'dev.hangar.agents/fail.now',
    ]);
    expect(tools[0]).toMatchObject({
      description: 'Echo',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    });
    expect(tools[1]).toMatchObject({ description: 'x.y', inputSchema: { type: 'object' } });
    await client.close();
  });

  it('calls the function as the session that owns the token', async () => {
    const client = await connect(tokens.issue('dev.hangar.agents', 's1'));
    const result = await client.callTool({
      name: 'dev.hangar.agents/session.echo',
      arguments: { text: 'hi' },
    });
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual({
      args: { text: 'hi' },
      info: { caller: { kind: 'session', bayId: 'dev.hangar.agents', sessionId: 's1' } },
    });
    expect(await client.callTool({ name: 'dev.hangar.agents/session.echo' })).toMatchObject({
      content: [{ type: 'text' }],
    });
    await client.close();
  });

  it('reports errors and denied permissions as tool errors', async () => {
    const client = await connect(tokens.issue('dev.hangar.agents', 's1'));
    expect(await client.callTool({ name: 'dev.hangar.agents/fail.now', arguments: {} })).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'kaputt' }],
    });
    expect(await client.callTool({ name: 'dev.hangar.other/x.y', arguments: {} })).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Access denied: dev.hangar.agents → dev.hangar.other/x.y' }],
    });
    await client.close();
  });

  it('returns null for functions without a result', async () => {
    const client = await connect(tokens.issue('dev.hangar.other', 's9'));
    const result = await client.callTool({ name: 'dev.hangar.other/x.y', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'null' }]);
    await client.close();
  });

  it('accepts a single tools/call without initialize (used by the hangar CLI)', async () => {
    const token = tokens.issue('dev.hangar.agents', 's1');
    const res = await post(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'dev.hangar.agents/session.echo', arguments: { text: 'cli' } },
      }),
      { authorization: `Bearer ${token}` },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { result: { content: { text: string }[] } };
    expect(JSON.parse(json.result.content[0]!.text).args).toEqual({ text: 'cli' });
  });

  it('rejects missing, unknown and revoked tokens', async () => {
    expect((await post('{}')).status).toBe(401);
    expect((await post('{}', { authorization: 'Bearer nope' })).status).toBe(401);
    const token = tokens.issue('dev.hangar.agents', 's1');
    tokens.revoke('s1');
    expect((await post('{}', { authorization: `Bearer ${token}` })).status).toBe(401);
    const renewed = tokens.issue('dev.hangar.agents', 's1');
    expect(tokens.resolve(renewed)).toBeDefined();
    expect(tokens.issue('dev.hangar.agents', 's1')).not.toBe(renewed);
    expect(tokens.resolve(renewed)).toBeUndefined();
  });

  it('answers wrong paths, methods and bodies with HTTP errors', async () => {
    const auth = { authorization: `Bearer ${tokens.issue('dev.hangar.agents', 's1')}` };
    expect((await post('{}', auth, 'POST', '/other')).status).toBe(404);
    expect((await post('', auth, 'GET')).status).toBe(405);
    const bad = await post('{nope', auth);
    expect(bad.status).toBe(400);
    expect((await post('x'.repeat(1_100_000), auth)).status).toBe(400);
  });

  it('answers 429 once a session exceeds its rate limit, other sessions unaffected', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const a = { authorization: `Bearer ${tokens.issue('dev.hangar.agents', 'a')}` };
      const b = { authorization: `Bearer ${tokens.issue('dev.hangar.agents', 'b')}` };
      const statuses = [];
      for (let i = 0; i < 101; i++) statuses.push((await post('{nope', a)).status);
      expect(statuses.slice(0, 100).every((s) => s === 400)).toBe(true);
      expect(statuses[100]).toBe(429);
      expect((await post('{nope', b)).status).toBe(400);
      // 600 requests per minute: 0.1 s brings one back.
      vi.advanceTimersByTime(100);
      expect((await post('{nope', a)).status).toBe(400);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('rateLimiter', () => {
  it('keeps its budget when the system clock is set back', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const auth = { authorization: `Bearer ${tokens.issue('dev.hangar.agents', 'c')}` };
      expect((await post('{nope', auth)).status).toBe(400);
      vi.setSystemTime(Date.now() - 3_600_000);
      expect((await post('{nope', auth)).status).toBe(400);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets buckets that are full again once it holds 1000', () => {
    let clock = 0;
    const limiter = rateLimiter(() => clock);
    for (let i = 0; i < 1000; i++) limiter.allow(`old-${i}`);
    expect(limiter.size).toBe(1000);
    // 600 per minute refill a bucket of 100 within 10 s.
    clock += 10_000;
    limiter.allow('active');
    limiter.allow('new');
    expect(limiter.size).toBe(2);
  });
});
