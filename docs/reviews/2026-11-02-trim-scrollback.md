# Review trimming the history (2026-11-02)

Reviewer: Codex (`codex exec -s read-only`), diff before the commit. Bug: after
a restart the history of sessions with Claude Code was missing (alternate
screen, cursor jumps, hardly any line breaks). `trimScrollback` cut up to the
next line break after the limit; that one stood only in the restart notice.
Fix: search at most 4096 characters far.

## Findings

None. Codex checked the trimming, the 4096 limit and the restore case in
isolation (500,000 instead of 40 characters kept). A cut in the middle of an
escape sequence or a UTF-16 surrogate pair remains possible; that was already
so before when no line break followed.

## Not checked

What is visible after restoring: the notice leaves the alternate screen
(`restoreSuffix`), Claude Code's full-screen display disappears in the process;
the normal screen before it stays visible.
