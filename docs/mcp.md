# MCP server and `hangar` CLI

Hangar provides all bay functions through a local MCP server. Agents in a
session shell reach it directly as an MCP client (e.g. Claude Code via
`.mcp.json`) or through the `hangar` CLI. Both use the same endpoint and the
same permission check (ADR 0007, ADR 0008).

## Endpoint

Implemented in `packages/mcp/src/server.ts`.

- Transport: Streamable HTTP with JSON responses (`enableJsonResponse`).
- Address: `http://127.0.0.1:<port>/mcp`. The port is chosen freely and changes
  on every start of Hangar; the shell gets the URL in `HANGAR_MCP_URL`.
- `127.0.0.1` only, no connections from outside.
- Stateless: Every `POST` request gets its own MCP server instance, there are
  no MCP session IDs. A client may send `tools/call` without a prior
  `initialize`. There are no server notifications such as `tools/list_changed`.
- Every request needs `Authorization: Bearer <HANGAR_TOKEN>`. The token determines
  the caller `{ kind: 'session', bayId, sessionId }`. Tokens are 32
  random bytes (hex), exist only in memory and are reissued on every shell start
  of the session; the old one becomes invalid. When the session is closed, the
  token is removed.
- Size of the request body: at most 1,000,000 bytes.

### HTTP errors

The checks run in this order. The body is always JSON of the form
`{"error": "<message>"}`.

| Status | Condition                             | Message                                           |
| ------ | ------------------------------------- | ------------------------------------------------- |
| 404    | Path is not `/mcp` (query is ignored) | `Nicht gefunden`                                  |
| 401    | Token missing or unknown              | `Invalid or missing token`                        |
| 429    | Token over its rate limit (see below) | `Too many requests`                               |
| 405    | Method is not `POST`                  | `Nur POST`                                        |
| 400    | Body is not valid JSON or too large   | Message of the JSON parser or `Request too large` |
| 500    | unexpected error during processing    | Error message                                     |

Rate limit: each token has a bucket of 20 requests that refills at 100 requests
per minute (`packages/mcp/src/server.ts`). Other sessions are not affected.

Errors of a bay function are not HTTP errors. They come back as an MCP result
with `isError: true` and the message as text.

## Session environment

Set in `bays/agents/src/main/sessions.ts` (`environment`) on every shell start:

| Variable            | Content                                                                         |
| ------------------- | ------------------------------------------------------------------------------- |
| `HANGAR_SESSION_ID` | UUID of the session                                                             |
| `HANGAR_TOKEN`      | Token of the session for the MCP server                                         |
| `HANGAR_MCP_URL`    | URL of the MCP server, e.g. `http://127.0.0.1:53124/mcp`                        |
| `HANGAR_PROJECT`    | Name of the project (folder name of the repository)                             |
| `HANGAR_PORT_BASE`  | first port of a block of 100 ports for dev servers of this session (from 40000) |

In addition:

- `PATH` starts with the folder of the `hangar` CLI (`<userData>/bin`).
- `TERM=xterm-256color`, `COLORTERM=truecolor`.
- The environment variables configured per session. Names must match
  `^[A-Za-z_][A-Za-z0-9_]*$`; `HANGAR_*` is reserved
  (`Variable ist reserviert: <name>`).

## Configuration in the worktree

On shell start, the agent bay writes two files into the worktree
(`bays/agents/src/main/agent-config.ts`). Both are added to the shared
`info/exclude` of the repository and not committed. Existing entries are kept;
only Hangar's own entries are replaced.

`.mcp.json` – MCP server `hangar`. Claude Code substitutes `${VAR}` from the
environment of the shell, so no token is stored on disk:

```json
{
  "mcpServers": {
    "hangar": {
      "type": "http",
      "url": "${HANGAR_MCP_URL}",
      "headers": { "Authorization": "Bearer ${HANGAR_TOKEN}" }
    }
  }
}
```

`.claude/settings.local.json` – enables the server and sets up Claude Code hooks
that report the status through the CLI:

```json
{
  "enabledMcpjsonServers": ["hangar"],
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "hangar --quiet status working" }] }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [{ "type": "command", "command": "hangar --quiet status waiting" }]
      }
    ],
    "Stop": [{ "hooks": [{ "type": "command", "command": "hangar --quiet status done --hook" }] }]
  }
}
```

`Notification` reports `waiting` only for notices that the person needs: one
group each for `permission_prompt`, `elicitation_dialog`,
`elicitation_url_dialog` and `agent_needs_input` (only the first in the
example). `idle_prompt` comes about 60 seconds after a response, even if the
agent is waiting in the background, for example for CI, and does not change the
status.

Hook groups whose command starts with `hangar ` count as Hangar's own and are
replaced on the next shell start.

## Tools

Every bay function is an MCP tool named `<bay-id>/<function>`.
`tools/list` returns all registered functions with the description from the
manifest and the JSON Schema of the arguments as `inputSchema`.

The agent bay offers these tools (`bays/agents/manifest.json`,
`bays/agents/src/main/functions.ts`); those of the browser bay and the board
follow below. `session.info` and `project.list` are `bayOnly` (ADR 0021) and not
a tool. Except for `job.add`, they are not sensitive and always act
on the session of the caller, determined by the token. Success returns
`{"ok":true}` as text.

### `dev.hangar.agents/session.setDescription`

Sets the short description of the own session.

| Parameter     | Type   | Required | Rule                                                       |
| ------------- | ------ | -------- | ---------------------------------------------------------- |
| `description` | string | yes      | at most 200 characters; whitespace at the edges is trimmed |

```json
{ "description": "Login-Tests reparieren" }
```

### `dev.hangar.agents/session.setStatus`

Reports the status of the own session.

| Parameter | Type   | Required | Rule                                                 |
| --------- | ------ | -------- | ---------------------------------------------------- |
| `status`  | string | yes      | `working`, `waiting`, `background`, `done` or `idle` |

```json
{ "status": "waiting" }
```

When the status changes to `waiting`, Hangar shows the notification "Session is
waiting for input" and increases the badge of the bay. The heuristic does not
change `waiting` and `done`; `working` becomes `idle` after 30 seconds without
output. `background` (ADR 0035): The response of the agent has ended, a
background task is still running (for example waiting for CI); no notification,
no badge, the heuristic does not change it.

### `dev.hangar.agents/statusbar.set`

Sets a segment of the status bar of the own session. A segment with the same
`key` is replaced, otherwise appended.

| Parameter | Type             | Required | Rule                                                              |
| --------- | ---------------- | -------- | ----------------------------------------------------------------- |
| `key`     | string           | yes      | 1–40 characters from `A-Z`, `a-z`, `0-9`, `_`, `.`, `-`           |
| `value`   | string \| number | yes      | stored as text, at most 200 characters                            |
| `type`    | string           | yes      | `text`, `path`, `bar` or `badge`                                  |
| `max`     | number           | for bar  | greater than 0; required for `bar`, `value` must then be a number |

```json
{ "key": "kontingent", "value": 42, "type": "bar", "max": 100 }
```

### `dev.hangar.agents/statusbar.remove`

Removes a segment from the status bar of the own session. An unknown `key` is
not an error.

| Parameter | Type   | Required | Rule                   |
| --------- | ------ | -------- | ---------------------- |
| `key`     | string | yes      | as for `statusbar.set` |

```json
{ "key": "kontingent" }
```

### `dev.hangar.agents/job.add`

Schedules a shell command in the own session (ADR 0013). **Sensitive:** The
first call asks for permission. The job runs, as long as Hangar runs, as its own
process in the worktree of the session with its environment, without input and
for at most 60 minutes (ADR 0014); the terminal of the session stays untouched.
The result is in the settings under "Jobs" and in `job.list`. If the session
closes, the job is deleted.

| Parameter  | Type   | Required | Rule                                                                                   |
| ---------- | ------ | -------- | -------------------------------------------------------------------------------------- |
| `command`  | string | yes      | 1–1000 characters; if it reads from standard input, the job only ends with the session |
| `schedule` | string | yes      | Cron with five fields in local time, e.g. `0 2 * * 1-5`                                |

```json
{ "command": "pnpm test", "schedule": "0 2 * * 1-5" }
```

Response: `{ "id": "…", "nextRun": 1793329200000 }` (ms since 1970).

### `dev.hangar.agents/job.list`

Lists the jobs of the own session: `id`, `command`, `schedule`, `paused`,
`nextRun` and, after the first run, `lastRun` (`at`, `durationMs`, `ok`,
`output`). No parameters.

### `dev.hangar.agents/handover.create`

Hands work over to a new session (ADR 0031): own worktree, the handover is shown
above the terminal. Not sensitive, `remote: true`: Other instances call it only
with the share of the workspace and only for shared projects. Never input into a
running shell, never files.

| Parameter | Type    | Rule                                                            |
| --------- | ------- | --------------------------------------------------------------- |
| `task`    | string  | 1–2000 characters                                               |
| `context` | string? | up to 4000 characters                                           |
| `project` | string? | project name; locally the own one if omitted, required remotely |
| `branch`  | string? | branch name; locally the starting point of the new worktree     |
| `remote`  | string? | Git address (`https://`, `ssh://`, `git@`), for display only    |

Response locally `{ "sessionId": "…" }`, remotely `{ "ok": true }`. Errors:
`No such project`, `No such shared project`, `Project name is ambiguous`
(two projects of this name), `Too many open handovers` (five open ones from
other instances).

### `dev.hangar.agents/handover.get`

The handover the own session was started with (`origin`, `from`,
`task`, `branch?`, `remote?`, `context?`, `at`), otherwise `null`. Only from a
session.

### `dev.hangar.agents/quota.report`

Reports the 5-hour and weekly quota of Claude Code for the footer of the agent bay
(ADR 0024). Not sensitive, only from a session. Normally called by
`hangar statusline`, not by the agent itself.

| Parameter     | Type    | Rule                                       |
| ------------- | ------- | ------------------------------------------ |
| `provider`    | string  | only `claude` (the bay reads Codex itself) |
| `usedPercent` | number  | 0–100                                      |
| `resetsAt`    | number? | seconds since 1970                         |
| `week`        | object? | weekly limit: `usedPercent`, `resetsAt`    |

### Browser bay (`dev.hangar.browser/…`)

Web pages in tabs (ADR 0015, `bays/browser/manifest.json`). Each agent session
has its own tabs with its own cookies in memory, separate from the tabs of the
person and of other agents; an agent reaches only its own tabs. The person sees
them in the tab bar with the mark "Agent". All functions are not sensitive and
open to agents of every bay, without prompt (ADR 0016). When the session ends,
its tabs close.

| Tool              | Parameters                | Response                                                                                 |
| ----------------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| `tab.open`        | `url`                     | Tab: `id`, `url`, `title`, `loading`, `canGoBack`, `canGoForward`, `partition`, `error?` |
| `tab.navigate`    | `id`, `url`               | Tab                                                                                      |
| `tab.list`        | –                         | List of the own tabs                                                                     |
| `tab.close`       | `id`                      | `{ "ok": true }`                                                                         |
| `page.text`       | `id`                      | `{ "text": "…", "truncated": false }` (at most 100,000 characters)                       |
| `page.click`      | `id`, `selector` (CSS)    | `{ "ok": true }`                                                                         |
| `page.fill`       | `id`, `selector`, `value` | `{ "ok": true }`; sets the value and triggers `input`/`change`                           |
| `page.screenshot` | `id`                      | `{ "path": "…/screenshots/<id>-<zeit>.png" }`                                            |

`url` as in the address bar: `localhost:5173` → `http://localhost:5173`,
`example.com` → `https://example.com`; http and https only. Loading waits at
most 30 seconds; if it fails, the reason is in `error`.

```json
{ "url": "localhost:5173" }
```

### Board (`dev.hangar.board/…`)

Tasks per project of the agent bay (ADR 0037, `bays/board/manifest.json`). The
project is that of the calling session; only agent sessions of the agent bay may
call. All functions are not sensitive and open to agents (ADR 0016). Agents of
other instances (ADR 0037, addendum) name in every tool `project`, the name of a
project shared in workspaces; for this the workspace must share the function.
Their tasks belong to the instance, not to a session, and never become open
again on their own. When a session ends, its tasks in progress go back to
"open". Texts without control characters.

| Tool         | Parameters                                           | Response                                                                          |
| ------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `task.list`  | `status?` (`open`, `doing`, `done`)                  | tasks, among others `id`, `title`, `status`, `sessionName?`, `createdBy`, `notes` |
| `task.add`   | `title` (at most 200), `description?` (at most 4000) | new task, `open`                                                                  |
| `task.claim` | `id`                                                 | task, `doing` for the own session; error if another one has it                    |
| `task.note`  | `id`, `text` (at most 2000)                          | task with note; not for tasks of another session                                  |
| `task.done`  | `id`, `note?`                                        | task, `done`; error if another session has it                                     |

All five additionally take `project?` (at most 200), only for other instances.

### Tool errors

As text in a result with `isError: true`:

| Message                                                             | Cause                                                       |
| ------------------------------------------------------------------- | ----------------------------------------------------------- |
| `Invalid arguments: <feld>: <grund>`                                | arguments violate the schema                                |
| `Invalid arguments: key: 1–40 characters from A-Z, a-z, 0-9, _ . -` | invalid segment key                                         |
| `Invalid arguments: args: type bar needs max and a numeric value`   | `bar` without `max` or with a non-numeric `value`           |
| `Unknown function: <name>`                                          | tool name does not exist                                    |
| `Access denied: <bay-id> → <name>`                                  | permission denied                                           |
| `Only callable from an agent session`                               | call of an agent bay function by a bay instead of a session |
| `Unbekannte Session: <id>`                                          | session no longer exists                                    |
| `Unknown tab "<id>"`                                                | tab does not exist or does not belong to the caller         |
| `Only http and https addresses can be opened: <url>`                | browser bay: other address, e.g. `file:`                    |
| `No element matches "<selector>"`                                   | browser bay: selector matches no element                    |

`<grund>` is the message of zod for schema violations.

## Example: raw `tools/call`

From a session shell, with the same headers as the CLI:

```sh
curl -s "$HANGAR_MCP_URL" \
  -H "Authorization: Bearer $HANGAR_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "dev.hangar.agents/session.setStatus",
      "arguments": { "status": "waiting" }
    }
  }'
```

Response on success (shortened):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { "content": [{ "type": "text", "text": "{\"ok\":true}" }] }
}
```

Equivalent with the CLI:

```sh
hangar status waiting
```

## `hangar` CLI

Implemented in `packages/cli/src/cli.ts`. The CLI has no dependencies and
sends exactly one `tools/call` to `HANGAR_MCP_URL` for each command. On start,
Hangar creates a shim `hangar` (or `hangar.cmd` under Windows) in
`<userData>/bin`, which starts the bundled CLI with Hangar's own Electron binary
(`ELECTRON_RUN_AS_NODE=1`). A separate Node installation is not needed.

```
hangar status <working|waiting|background|done|idle> [--hook]
hangar describe "<text>"
hangar statusbar set <key> <value> --type <text|path|bar|badge> [--max <n>]
hangar statusline
hangar handover
hangar handover create "<task>" [--branch <b>] [--context "<text>"] [--project <p>] [--remote <url>]
hangar help
```

| Command                   | Tool                                       | Arguments                                               |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| `status <s>`              | `dev.hangar.agents/session.setStatus`      | `{ status }`                                            |
| `describe <text…>`        | `dev.hangar.agents/session.setDescription` | `{ description }`, words joined with spaces             |
| `statusbar set <k> <v> …` | `dev.hangar.agents/statusbar.set`          | `{ key, value, type, max? }`                            |
| `statusline`              | `dev.hangar.agents/quota.report`           | from `rate_limits.five_hour` and `seven_day` (ADR 0024) |
| `handover`                | `dev.hangar.agents/handover.get`           | prints the handover as text                             |
| `handover create <text…>` | `dev.hangar.agents/handover.create`        | `{ task, branch?, context?, project?, remote? }`        |

`hangar statusline` is the `statusLine` command that Hangar writes into
`.claude/settings.local.json` of every session. It reads the JSON from Claude
Code on stdin, reports the 5-hour and weekly quota (time limit 1 s, errors silent) and
prints what the person's own status line prints for the same stdin:
`statusLine` from `.claude/settings.json` of the project
(`workspace.project_dir`), otherwise from `$CLAUDE_CONFIG_DIR/settings.json`
(default `~/.claude/settings.json`), run in `workspace.current_dir`. It does not
call a command that starts with `hangar `; the command gets
`HANGAR_STATUSLINE=1`, and if that is set, `hangar statusline` calls none at
all. Always ends with 0.

`statusbar.remove` has no CLI command; use the MCP tool for it.

Options:

- `--type <text|path|bar|badge>` – required for `statusbar set`.
- `--max <n>` – maximum value, must be a number (`--max muss eine Zahl sein`).
- `-q`, `--quiet` – swallow errors and always end with 0 (for Claude Code
  hooks).

Examples:

```sh
hangar describe "Login-Tests reparieren"
hangar statusbar set worktree "$PWD" --type path
hangar statusbar set kontingent 42 --type bar --max 100
```

Exit codes: `0` on success and on `help`; `1` on every error, message on stderr.
Never `2`, because Claude Code treats a hook with exit 2 as "block". With
`--quiet` always `0`.

CLI error messages:

| Message                                                                                  | Cause                                          |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `Status fehlt oder ist ungültig (working, waiting, background, done, idle)`              | `status` without or with an unknown value      |
| `Beschreibung fehlt`                                                                     | `describe` without text                        |
| `Aufruf: hangar statusbar set <key> <value> --type <text\|path\|bar\|badge> [--max <n>]` | `statusbar set` without key, value or `--type` |
| `Nicht in einer Hangar-Session: HANGAR_MCP_URL und HANGAR_TOKEN fehlen.`                 | environment variables missing                  |
| `Hangar nicht erreichbar: <Grund>`                                                       | connection failed                              |
| `Hangar antwortet mit <Status>: <Meldung>`                                               | HTTP error of the server (see above)           |
| Text of the tool error                                                                   | result with `isError: true`                    |

Unknown commands and `statusbar` without `set` print the help text and end with 1.
