# Review Phase 20 – installation, update, rollback (2026-11-02)

Reviewer: Codex (`codex exec -s read-only`), diff before the commit. Task:
races in the state, bypass of check and confirmation, data loss on switching
and rolling back, permissions after the update, UI.

## Findings

All ten findings adopted, each with a test that was red before.

1. **[P1] Index loading writes stale state back.** A `confirm` during a running
   index fetch was lost. **Adopted:** read the state only after the fetch. Test
   "keeps a confirmation made while an index loads, and never lowers the index
   version".
2. **[P1] The same version published again keeps the old content.**
   **Adopted:** `confirm` replaces the version folder. Test "activates what
   was confirmed last, also for the same version published again".
3. **[P2] A function that returns as sensitive keeps old permissions.**
   **Adopted:** `sensitive` counts every function that was not sensitive
   before, including one that was missing before. Test "resets grants of a
   sensitive function that was not there before (Codex review)".
4. **[P2] Data backup was missing when replacing a bundled bay**, although the
   dialog promises it. **Adopted:** backup to `data-bundled-<version>`. Test
   "backs up the data of a bundled bay it replaces with a new data format".
5. **[P2] Rollback without a data folder deleted the backup.** **Adopted.**
   Tests "restores the backup on rollback even when the data folder is gone"
   and "switches the data format without a backup when the bay has no data
   yet".
6. **[P2] Installing an older version bypassed the restore.**
   **Adopted:** newer versions only; going back only via rollback. Test
   "refuses a version that is not newer than the installed one".
7. **[P2] Bay ID `state.json.tmp` collided with the state file.**
   **Adopted:** `_state.json` (not a valid ID). Test "keeps its state
   apart from bay folders, whatever the bay id".
8. **[P2] Index error hid the rollback.** **Adopted:** the catalog returns
   `{ bays, error }`, the settings show the error and keep listing. Tests
   "still offers the rollback when the index cannot be loaded" and
   `BayCatalog.test.tsx` "still lists installed bays when the index fails …".
9. **[P2] `prepare` did not check the update channel; a channel change left an
   inadmissible offer standing.** **Adopted:** `prepare` gets the channel,
   the settings reload the list on the change. Tests "installs a beta
   version only on the beta channel" and `Settings.test.tsx` "reloads the bay
   catalog when the update channel changes".
10. **[P2] The click lock ended before the list was reloaded**; keyboard clicks
    (`detail: 0`) could repeat the action. **Adopted:** lock until after the
    reload. Test "stays locked until the catalog is reloaded after
    an action".

## Not checked

Switching under Windows (locked files on rename); abort of the process in the
middle of a switch at start.
