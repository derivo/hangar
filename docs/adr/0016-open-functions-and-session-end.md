# ADR 0016 – Functions for all agents and the end of an agent session

Status: accepted. Supplements [ADR 0006](0006-permissions.md) and
[ADR 0015](0015-browser-bay.md).

## Context

The browser bay offers eight functions for agents. The agents belong to the
agent bay, so they call another bay: According to ADR 0006, Hangar asks on the
first call of each function, up to eight dialogs, before an agent can check a
page. The functions act only on the agent's tabs in its own partition; the
prompt protects nothing here.

In addition, an agent's tabs stay open when its session ends. The browser bay
does not learn about the end: Only the bay that owns the session knows about it.

## Decision

- **`openToAgents` in the manifest:** A function with `"openToAgents": true` may
  be called by agents of any bay without a prompt. This is allowed only for
  non-sensitive functions; the manifest schema rejects `sensitive` and
  `openToAgents` together. Like those of the agent bay, the function must act
  only on the caller's data (`caller.sessionId`).
- **Blocking stays possible:** A denial (`deny`) set in the settings also applies
  to open functions. Calls from bays (not from agents) still ask according to
  ADR 0006.
- **End of a session as an event:** If a bay unregisters an agent session
  (`ctx.unregisterAgentSession`), all bays receive the event via
  `ctx.onAgentSessionEnded(listener)` with `{ bayId, sessionId }`. A restart of
  the shell does not end the session.
- **Browser bay:** All eight functions are `openToAgents`. When a session ends,
  the bay closes its tabs.

## Alternatives

- **Ask for the browser bay permission once per bay instead of per function:**
  one dialog instead of eight, but a new permission type for a prompt without
  benefit.
- **Agent bay approves the browser functions permanently:** couples the agent
  bay to another bay.
- **Close tabs after a time without calls:** also closes tabs of running
  sessions that are only waiting.

## Consequences

- New manifest field `openToAgents` (SDK, bus `FunctionSpec`), new context event
  `onAgentSessionEnded`.
- Whoever opens a function must ensure that it acts only on the caller's data;
  Hangar does not check this.
