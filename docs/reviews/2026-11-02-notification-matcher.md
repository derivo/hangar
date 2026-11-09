# Review notification matcher (2026-11-02)

Reviewer: Codex (`codex exec -s read-only`), diff before the commit. Task:
"waiting for input" only when Claude Code needs the person; `idle_prompt` does
not set the status. Matcher semantics, replacing old hooks without a matcher,
the person's own hooks, docs.

## Findings

None. Codex checked with its own script (file system in memory): old group
without a matcher is replaced, own hooks in the same group stay, writing twice
gives the same bytes, one hit each for `permission_prompt`,
`elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input`, none for
`idle_prompt`, `auth_success`, `elicitation_complete`, `elicitation_response`,
`agent_completed`.

## Measurement for a later status "waiting for background"

Real run `claude -p` (Haiku) in a temporary folder with a logging `Stop` hook:
if the answer ends while a background Bash is running, `background_tasks`
contains the entry
`{ id, type: "shell", status: "running", description, command }`. After the
command ends, Claude Code continues by itself; the next `Stop` has an empty
`background_tasks`. Not measured: whether `UserPromptSubmit` comes on
continuing, background agents instead of Bash, interactive sessions.
