# ADR 0007: MCP server over Streamable HTTP, stateless

- Status: accepted
- Date: 2026-10-28

## Decision

- The MCP server listens only on `127.0.0.1` on a free port and accepts requests
  at `/mcp` (Streamable HTTP, JSON responses).
- Every request needs `Authorization: Bearer <HANGAR_TOKEN>`. Tokens are 32
  random bytes per session, exist only in memory and are reissued on every shell
  start (old ones become invalid).
- Stateless: Every POST request gets its own MCP server instance. This way the
  `hangar` CLI needs no handshake and sends only `tools/call`.
- Port and URL change on every start; shells receive them through
  `HANGAR_MCP_URL`, and the MCP configuration in the worktree reads the
  variables.

## Consequences

- No server notifications to clients (e.g. `tools/list_changed`); in the MVP the
  tool list does not change at runtime.
- A local process of the same user can read the token from the environment of a
  shell; this matches the trust model of a local terminal.
