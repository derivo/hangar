# ADR 0006: Permission model of the bus

- Status: accepted
- Date: 2026-10-28

## Context

Specification §7 states the rules roughly: own functions always allowed, a
prompt on the first cross-bay access, sensitive functions never automatic for
agents, approval "once, per session, or confirmation on every access". Open are
the subject of a permission, the meaning of "once" and the storage.

## Decision

- The **subject** of a permission is always the calling bay. An agent acts on
  behalf of the bay that owns its session (token → `{ bayId, sessionId }`).
  The target is `<bay-id>/<funktion>`.
- **Own bay:** A bay may call all its own functions; its agents may call all its
  own **non-sensitive** functions. The functions of the agent bay always act on
  the caller's session (`caller.sessionId`), never on another one.
- **First access to another bay** (non-sensitive): dialog "Allow / Deny"; the
  answer is stored permanently (`permissions.json` in the data folder).
- **Sensitive functions:** every access without a stored permission asks, also
  for agents of the own bay. Answers:
  - "Always allow" – the one-time approval, applies from then on (`allow`),
  - "For this session" – only for the agent's session, only in memory, ends with
    the session (for calls from a bay: only this one call),
  - "Ask on every access" – stored as `ask`, every further call shows a yes/no
    confirmation,
  - "Deny" – stored as `deny`.
- **Settings page:** lists the stored and the session permissions per function;
  each can be revoked. After revocation, the bus asks again.
- **Transport:** The bus routes through a `Transport` interface; in the MVP only
  local.

## Consequences

- Agents of different sessions of the same bay share permanent permissions, but
  not session permissions.
- For Hangar Relay, the `Caller` must later be extended by the remote instance;
  remote calls are then `deny` by default.
