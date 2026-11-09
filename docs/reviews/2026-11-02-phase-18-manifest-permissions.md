# Review Phase 18 – manifest permissions (2026-11-02)

Reviewer: Codex (`codex exec -s read-only`), diff before the commit. Task:
bypasses of `uses` and `agentSessions`, gaps in the schema, broken existing
bays.

## Findings

1. **[P2] `uses` rejects remote targets with a leading digit**
   (`packages/sdk/src/manifest.ts`). `remoteBayId` produces, for example for the
   instance name `123`, an ID that the pattern for `uses` does not accept.
   **Not adopted.** Remote IDs contain the name and fingerprint of a specific
   foreign instance and differ per installation; a shipped manifest cannot name
   them in a meaningful way, not even with a matching pattern. Bays share via
   `ctx.workspaces`, agents call remote functions through their session.
   Recorded in ADR 0032.

No further finding: no reproduced bypass (prefix of the own ID, IDs without a
function, sessions), all manifests of the bays valid, only the deliberately
broken fixture bay rejected.

## Own check

- Own ID as prefix: ``startsWith(`${id}/`)``; bay IDs contain no `/`, function
  names neither. Another bay with the same prefix (`dev.hangar.test2`) does not
  fall under it.
- Coverage measured the same before and after the phase (98.19 % statements on
  the state before the phase); the value 98.22 % from Phase 17 varies per run.
