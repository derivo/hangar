# @hangar/mcp

MCP server (Streamable HTTP, `127.0.0.1`, stateless) on top of the bus.

## Interfaces

- `startMcpServer({ bus, tokens, port?, version? })` → `{ url, close() }`
- `TokenRegistry`: `issue(bayId, sessionId)`, `resolve(token)`, `revoke(sessionId)`
- Every bus function is a tool `<bay-id>/<function>`; `inputSchema` comes from `FunctionSpec`.
  Functions with `bayOnly` (ADR 0021) are missing from `tools/list`; a call fails at the bus.

## Pitfalls

- Without a valid bearer token the server answers 401 before MCP even runs.
- Rate limit per token (bucket of 20, refilled at 100/min, in memory per server): beyond it 429.
  `hangar statusline` (quota report) counts against the same session budget.
- Errors from handlers and denied permissions are reported as tool errors (`isError`), not as HTTP errors.
- Decisions: ADR 0007.
