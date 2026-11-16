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
