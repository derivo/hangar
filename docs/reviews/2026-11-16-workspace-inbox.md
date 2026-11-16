# Review: workspace inbox and activity log (2026-11-16)

Reviewer: Codex (read-only, `codex exec -s read-only`), on the implementation of
[ADR 0046](../adr/0046-workspace-inbox-and-activity-log.md).

## Round 1: steps 1–3 (bus inbox, trust, activity log, outgoing log)

1. **[P1] A restart dropped every half accepted entry.** `resumeInbox()` runs
   before the relay connects; `isMember()` is `false` then, and the entry was
   removed as denied. Fixed: an entry that cannot pass the checks on resume goes
   back to `pending` and keeps its execution id, so accepting it later does not
   repeat a run from before the crash. Test: `inbox.test.ts` "puts an entry back
   to pending when a resume cannot check it yet" (red before the fix).
2. **[P1] The preview logged every string argument,** e.g. a Git remote with
   credentials or a token. Fixed: only the text fields of the inbox functions
   (`title`, `description`, `task`, `context`, `text`, `note`). Test:
   `inbox.test.ts` "takes only text fields, never a Git remote or a token".
3. **[P2] The inbox file was not durable.** A caller told `{ queued }` loses the
   call after a power loss, since the relay's replay guard refuses the same
   envelope. Fixed: `FileInboxStore` moved to `packages/host` (as the ADR plan
   says) and writes with `writeDurable` (flush, rename, folder fsync). Test:
   `inbox-store.test.ts`.
4. **[P2] A log line cut off by a crash swallowed the next entry,** since the
   next append joined it. Fixed: a file with a broken line is rewritten without
   it on load. Test: `activity-log.test.ts` "appends JSON lines … also after a
   restart" (red before the fix).
5. **[P2] Pruning truncated the log in place;** a crash in that window lost the
   history. Fixed: rewrites go through `writeDurable` (temporary file, rename).

## Round 2: step 4 (origin, execution ids, manifests, CLI)

1. **[P1] A `task.done` without a note ran twice** after the fix of round 1,
   finding 1: an entry back in `pending` could be accepted again after the
   person reopened the task. **[P2] Deleting the task or closing the handover
   session lost the dedupe record** in the same window. Root cause: the way back
   from `accepting` to `pending`. Fixed in the bus instead of the handlers:
   `acceptInbox` checks first and reserves after the check; `resumeInbox` runs a
   reserved entry without checking again (the checks passed when the person
   accepted, and after a restart no relay is connected yet); an entry whose bay
   is not loaded stays reserved for the next start. No path leads back to
   `pending`. Tests: `inbox.test.ts` "resumes a reserved entry without checking
   again" and "checks before it reserves" (red before the fix). Replaces the fix
   of round 1, finding 1.
2. **[P2] `hangar handover` did not show the authenticated sender;** two members
   with the same name looked alike. Fixed: a line with name, fingerprint and
   workspace from `handover.instance`. Test: `cli.test.ts` "hangar handover
   prints the handover of the own session" (red before the fix).

## Round 3: step 5 (desktop settings, badge, notification)

1. **[P2] With the local server, clicking the inbox notification opened the
   board,** which does not show waiting work. Fixed: one path for both cases –
   the desktop counts open entries (own core or local server) when the
   workspaces change and notifies on a rise; the click opens the settings. The
   server only asks the desktop to read again. Test: `host.test.ts` "tells about
   waiting inbox work; clicking it opens the settings" and "counts waiting inbox
   entries …" (red before the fix).
2. **[P2] A failed reload left stale Accept buttons.** Fixed: the section then
   shows why and no entries. Test: `Workspaces.test.tsx` "hides waiting entries
   and says why when the activity cannot be read".
3. **[P2] Two members of one name had trust checkboxes that a screen reader
   could not tell apart.** Fixed: the fingerprint is part of the description.
   Test: "tells two members of one name apart by fingerprint".
4. **[P2] Accept and Reject of two entries with the same text had the same
   name.** Fixed: the name carries text and sender. Test: "accepts and rejects
   waiting work and loads again".
