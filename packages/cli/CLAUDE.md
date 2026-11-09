# @hangar/cli – `hangar`

Command line for agents in a session shell. Calls the Hangar MCP server
via JSON-RPC `tools/call` (`HANGAR_MCP_URL`, `Bearer HANGAR_TOKEN`).
No dependencies, only `fetch`.

## Commands

| Command                                                    | Effect                                                                                                                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hangar status <idle\|working\|waiting\|background\|done>` | Status of the own session; `--hook` reads the input of the stop hook: `done` becomes `background` as long as a background task is running (ADR 0035) |
| `hangar describe "<text>"`                                 | Description of the own session                                                                                                                       |
| `hangar statusbar set <key> <value> [--type t] [--max n]`  | Status bar segment                                                                                                                                   |
| `hangar statusline`                                        | `statusLine` of Claude Code (ADR 0024): reports the 5h quota, then the person's own statusline                                                       |
| `hangar handover`                                          | Handover of the own session as text (ADR 0031)                                                                                                       |
| `hangar handover create "<task>" [--branch …] …`           | Hands work over to a new session; options `--context`, `--project`, `--remote`                                                                       |
| `hangar help`                                              | Help                                                                                                                                                 |

`--quiet` / `-q`: no output, exit 0 even on errors (for hooks). If Hangar does not
answer within 3 s (`TIMEOUT_MS`), the CLI aborts.

## Structure

- `src/cli.ts` – `run(argv, env, fetch)`, pure and testable; `statusline(stdin, env, deps)` with
  replaceable reading and executing (`StatuslineDeps`).
- `src/hangar.ts` – `statusline` reads stdin and starts the person's statusline via the
  shell (`spawn`, `shell: true`) in the working folder from the JSON.
- `src/hangar.ts` – entry point; `vite build` bundles into `dist/hangar.mjs`.
- On start Hangar writes `<userData>/bin/hangar` (`hangar.cmd` on Windows),
  which starts `dist/hangar.mjs` with Electron in Node mode
  (`packages/host/src/cli-shim.ts`). The folder is at the front of the `PATH` of every session.

## Pitfalls

- Errors end with exit 1, never 2: exit 2 blocks Claude Code hooks.
- Language from `LC_ALL`, `LC_MESSAGES`, `LANG`: German for `de…`, otherwise English (ADR 0009).
- Decision: ADR 0008.
