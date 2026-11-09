# Review 2026-11-01 – Phase 13, remote callers in the bus

Review of the diff (bus, manifest, permission dialog, bridge) by Codex
(`codex exec -s read-only`). Codex ran 14 targeted checks against the source
code (own bay, sensitive, missing `remote: true`, share list, membership, stored
and session permissions, `openToAgents`, `setMode` with a removed subject,
collision `remote:…` with bay IDs, manifest, bridge).

| Severity | Location                  | Finding                                                                                                                | Check                | Consequence                                                                                                                   |
| -------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| high     | `packages/bus/src/bus.ts` | Membership and share only checked before the dialog; if both are withdrawn meanwhile, the call runs and `allow` stays. | confirmed (red test) | Checked again after the answer (`remoteClosed`); test "refuses and stores nothing when access ends while the dialog is open". |

No other findings.
