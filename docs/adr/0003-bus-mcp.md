# ADR 0003: Central bus, MCP server as a facade

- Status: accepted
- Date: 2026-10-28

## Context

Bays offer functions that other bays and agents in terminals are supposed to
call. Later, a remote transport (Hangar Relay) and sensitive functions
(password bay) are added.

## Decision

- `packages/bus` is the only place that registers functions, forwards calls and
  checks permissions. It knows no transport details.
- A call always carries a `Caller` (`bay` or `session`) and a target
  `<bay-id>/<funktion>`.
- Forwarding to the target bay goes through a `Transport` interface. In the MVP
  there is only the local transport (handler in the main process); a remote
  transport will be added later as another implementation.
- `packages/mcp` is a thin facade: token → session, then `bus.call`. Every bus
  function is automatically an MCP tool `<bay-id>/<funktion>`.

## Consequences

- Permissions apply equally to bays and agents, because both go through the
  same bus.
- MCP tool names contain `/` and `.`; the MCP specification allows this.
  Whether a client rewrites names is up to the client.
