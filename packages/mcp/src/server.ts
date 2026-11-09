import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Bus, Caller } from '@hangar/bus';
import type { TokenRegistry } from './tokens';

const MAX_BODY = 1_000_000;
/** Token bucket per session token: bursts of 20, refilled at 100 requests per minute. */
const BURST = 20;
const REFILL_PER_MS = 100 / 60_000;

export interface McpServerOptions {
  bus: Bus;
  tokens: TokenRegistry;
  /** 0 picks a free port. */
  port?: number;
  version?: string;
}

export interface RunningMcpServer {
  /** e.g. `http://127.0.0.1:53124/mcp` – becomes HANGAR_MCP_URL. */
  url: string;
  close(): Promise<void>;
}

/**
 * Streamable-HTTP MCP server on 127.0.0.1. Every request must carry
 * `Authorization: Bearer <session token>`; the token decides the caller.
 * Stateless: each POST gets its own MCP server instance (no MCP session ids).
 */
export async function startMcpServer(options: McpServerOptions): Promise<RunningMcpServer> {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const allow = (token: string) => {
    const now = Date.now();
    const bucket = buckets.get(token) ?? { tokens: BURST, at: now };
    bucket.tokens = Math.min(BURST, bucket.tokens + (now - bucket.at) * REFILL_PER_MS);
    bucket.at = now;
    buckets.set(token, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };
  const http = createServer((req, res) => {
    handle(req, res, options, allow).catch((e: Error) => reply(res, 500, e.message));
  });
  await new Promise<void>((resolve) => http.listen(options.port ?? 0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: McpServerOptions,
  allow: (token: string) => boolean,
) {
  if (req.url?.split('?')[0] !== '/mcp') return reply(res, 404, 'Nicht gefunden');
  const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  const caller = options.tokens.resolve(token);
  if (!caller) return reply(res, 401, 'Invalid or missing token');
  if (!allow(token!)) return reply(res, 429, 'Too many requests');
  if (req.method !== 'POST') return reply(res, 405, 'Nur POST');

  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return reply(res, 400, (e as Error).message);
  }

  const server = createMcp(options, caller);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

function createMcp({ bus, version = '0.0.0' }: McpServerOptions, caller: Caller): Server {
  const server = new Server({ name: 'hangar', version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: bus
      .list()
      .filter((f) => !f.spec.bayOnly)
      .map((f) => ({
        name: f.id,
        description: f.spec.description ?? f.spec.name,
        inputSchema: (f.spec.inputSchema ?? { type: 'object' }) as { type: 'object' },
      })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await bus.call(caller, request.params.name, request.params.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: (e as Error).message }] };
    }
  });
  return server;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) reject(new Error('Request too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function reply(res: ServerResponse, status: number, message: string) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}
