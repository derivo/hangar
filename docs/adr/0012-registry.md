# ADR 0012 – Bay registry

Status: accepted, implemented in phases 18–20; open is the index on GitHub
Releases (phase 21) (concept: [concept-registry.md](../concept-registry.md))

## Context

Bays should be installed and updated without a new Hangar build. The main part
of a bay runs in the main process with all the rights of Node (ADR 0004); a
downloaded bay is thus code with the rights of the app.

## Decision

User decision 2026-10-29: For now there is only one registry with own bays
(`dev.hangar.*`), no third-party bays. Tier B, `publisher` and `publishers.json`
are dropped until further notice.

- **Two tiers:** Tier A only signed bays of one publisher (`dev.hangar.*`), tier
  B (third parties) only when the main part runs in an operating-system sandbox;
  a separate process alone is not a boundary.
- **Package and trust:** `.bay` (tar.gz), SHA-256 and Ed25519 signature per
  version; signed index with expiry date and version counter; public key built
  into Hangar.
- **Manifest:** new fields `publisher`, `uses`, `agentSessions`, `hostModules`,
  `dataVersion`; the bus rejects calls of a bay outside `uses`; session tokens
  only with `agentSessions`; new functions, `uses`, capabilities or newly
  sensitive functions trigger an approval.
- **Storage:** `<userData>/packages/<id>/<version>/`, separate from the bay's
  data folder, with a pointer to the active version; switch on the next start;
  the previous version and, with a new `dataVersion`, a backup of the data stay
  for rollback.
- **Publisher:** signed `publishers.json` binds prefixes to keys; a registry
  version from the same publisher may replace a bundled bay.
- **Hosting tier A:** static (index and packages), API paths `/v1/…` as later
  with the service.

## Alternatives

- **npm as a registry:** signatures and permission diff are missing, packages
  bring arbitrary dependencies.
- **Admit third parties immediately:** foreign code with full rights in the main
  process.
- **Updates without confirmation:** convenient, but new permissions would arrive
  unnoticed.

## Consequences

- `uses` and the check in the bus are worthwhile even without a registry.
- The scheduler (roadmap phase 4) takes over the daily update check.
- Tier B requires the isolation of the main part (own phase, own ADR).
- Review: [reviews/2026-10-28-relay-registry.md](../reviews/2026-10-28-relay-registry.md).
