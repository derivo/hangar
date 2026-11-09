# ADR 0032 – Manifest permissions: `uses`, `agentSessions`, `dataVersion`

Status: accepted (Phase 18; basis: [ADR 0012](0012-registry.md),
[concept-registry.md](../concept-registry.md) "New manifest fields")

## Context

ADR 0012 requires a bay to name in its manifest what it uses, so that
installation and update can show new permissions. Without that, any main part
can call any function of any bay and issue itself session tokens with which it
acts as an agent. `publisher` is dropped (decision of 2026-10-29).

## Decision

- **`uses`**: list `<bay-id>/<function>`. `ctx.call` rejects every target
  outside the bay's own that is not in it
  (`Access denied: <bay-id> → <target> (not in the manifest's "uses")`), before
  the bus is asked. After that the bus permissions apply as before (ADR 0006).
  Without `uses` there are no foreign calls. Exact entries only, no patterns.
  Functions of other instances (`remote.<name>-<fingerprint>.<bay-id>/…`) cannot
  be declared: name and fingerprint differ per installation. Bays share through
  `ctx.workspaces` (ADR 0030); agents call remote functions through their
  session.
- **The checkpoint is the bay runtime** (`packages/host/src/bay-runtime.ts`), not
  the bus: `ctx.call` is the only place that creates callers of kind `bay`; the
  bus knows no manifests.
- **`agentSessions: true`**: Only then does `ctx.registerAgentSession` issue a
  token, otherwise it throws. Agents in sessions still ask on first access
  (ADR 0006), their calls are not in `uses`.
- **`dataVersion`**: integer from 0. Phase 18 checks only the format; backup on
  a change follows with installation and update (Phase 20).
- The agent bay carries `agentSessions: true`, `uses: []`, `dataVersion: 1`.

## Consequences

- Third-party bays that call other bays or create sessions must extend the
  manifest; otherwise the call fails with a clear message.
- The protection applies against accidental or later-added calls, not against a
  bay that uses Node directly in the main process; only an operating system
  sandbox closes that (concept-registry.md, threats).

## Addendum 2026-11-04: `uses` counts as permission

With password bay and board (ADR 0021, 0037), bays asked each other at app
start, before the person had opened them: a permission dialog without context,
and a rejection would have disabled the bay permanently.

Decision: If a bay calls a **non-sensitive** function that its manifest names in
`uses`, the bus lets it through without a dialog. The manifest is the consent;
install and update show `uses` beforehand (ADR 0034).

- For this the host sets `declared: true` on the caller (`kind: 'bay'` in
  `ctx.call`; `kind: 'local-server'` without a session, if the manifest of the
  app's copy of the server bay names the target). The bay itself never sets it.
- Sensitive functions still ask (such as `secret.resolve`).
- A block from the settings (`deny`) still applies.
- This does not affect agents in sessions: their calls are not in `uses`.
