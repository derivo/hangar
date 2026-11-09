# Review 2026-11-01 – Phase 12, server in operation

Review of the diff (image, Compose, systemd unit, smoke test, docs, filter of
the session environment) by Codex (`codex exec -s read-only`). Codex could not
reach Docker and did not run the smoke test.

| Severity | Location                              | Finding                                                                                        | Check                                                     | Consequence                                                                                     |
| -------- | ------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| high     | `docker/server/hangar-server.service` | Without `StateDirectoryMode`/`UMask`, `/var/lib/hangar` is 0755, files 0644: locally readable. | confirmed (systemd default 0755, `store.ts` sets no mode) | `StateDirectoryMode=0700`, `UMask=0077`; image likewise `/data` 700, checked in the smoke test. |
| high     | `docs/server-operations.md`, backup   | Archive is created with umask 022 and contains the private key.                                | confirmed                                                 | `umask 077`, archive via standard output; round trip on throwaway volumes: archive 600.         |
| medium   | `docs/server-operations.md`, backup   | Backs up only `hangar_data`, not `hangar_projects`.                                            | confirmed                                                 | Both volumes in one archive; restore command extended with `-i` and played through.             |

Own finding when comparing the docs with the code: `bays/agents/src/main/sessions.ts`
always filtered `ANTHROPIC_*` out of the sessions' environment; an API key of
the service never reached the agents. Now only if `CLAUDECODE` is set
(unit test in `sessions.test.ts`, in the smoke test with a mutation probe).
