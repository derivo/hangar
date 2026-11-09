# ADR 0021 – Password bay: own vault, secrets only as environment variable

Status: accepted 2026-11-04, with the addendum "Agent bay in the local server"
below. Extends [ADR 0006](0006-permissions.md),
[ADR 0015](0015-browser-bay.md) (host modules) and
[ADR 0016](0016-open-functions-and-session-end.md).

## Context

Agents need credentials (API keys, tokens) in sessions. Today the person types
them as plain text into the environment variables of a project or a session of
the agent bay; they then sit unencrypted in its `state.json`.

Requirements from the person (2026-10-30):

- Hangar stores secrets itself, without 1Password, Bitwarden or the like.
- An agent gets a secret only as an environment variable of its shell, never
  through an MCP function.
- First stage only in the desktop app, not on a Hangar server.

## Decision

- **New bay `dev.hangar.secrets`** ("Passwords") in `bays/secrets`. It manages
  entries with name, value and description. The name is a valid variable name
  (rules as for `project.setEnv` of the agent bay).
- **Host module `secrets`:** With `hostModules: ["secrets"]` the bay gets
  `ctx.secrets.encrypt(text)` and `ctx.secrets.decrypt(data)`. The desktop app
  uses Electron `safeStorage` for this (key in the system keychain). If
  `safeStorage` is not available (Linux without a keychain), `encrypt` throws;
  the bay shows that instead of storing plain text. The server does not have the
  module and therefore does not load the bay (as with `browser`).
- **Storage:** `<dataDir>/vault.json` with encrypted values; names and
  descriptions in plain text, so the list works without decrypting.
- **UI:** list, create, replace value, delete. A stored value is never shown
  again; it can only be replaced.
- **Assignment in the agent bay:** An environment variable of a project or a
  session can point to an entry instead of holding a value
  (`{ secret: "<id>" }`). When a shell or a job starts, the agent bay resolves
  the references through `dev.hangar.secrets/secret.resolve`; `state.json` of
  the agent bay holds only the reference.
- **`secret.resolve` for bays only:** New manifest field `bayOnly: true`. Such a
  function does not appear as an MCP tool and rejects callers with
  `kind: "session"` in the bus, regardless of stored permissions. It is
  `sensitive`: the first call by the agent bay asks according to ADR 0006
  ("The agent bay wants to read passwords").
- **Missing entry:** If a reference points to a deleted entry, the shell does
  not start and the agent bay names the variable and the entry.

## Limits (deliberate)

- The variable is in the shell's environment. An agent can read it with
  `echo $NAME` and pass it on. The bay protects against plain text in
  `state.json`, in MCP responses and in the conversation history through
  function calls, not against an agent that sets out to get it.
- No master password: whoever has the unlocked user account has the secrets, as
  with the keychain itself.
- No import, no export, no synchronization between machines.

## Consequences

- SDK: host module `secrets`, manifest field `bayOnly`; bus and MCP server
  respect it.
- Agent bay: variables with a reference, resolution before every start, display
  in the form ("from passwords").
- On a server, environment variables stay plain text until a separate ADR
  settles a vault there (for example with a key that the desktop supplies over
  the bridge).

## Alternatives

- **1Password/Bitwarden CLI:** no own cryptography, but requires an installed
  and signed-in CLI; rejected by the person.
- **`secret.get` as a sensitive MCP function:** simpler, but the plain text then
  sits in the agent's context and history; rejected.
- **Own encryption with a master password:** more protection on an unlocked
  machine, but entry on every start and own cryptography; possible later.

## Addendum 2026-11-04: implementation and agent bay in the local server

Since [ADR 0036](0036-shells-survive-restart.md) the agent bay runs in the
local server, but the password bay only in the app (host module `secrets`).
Decision of the person: secrets come through the app.

- The agent bay in the server calls `dev.hangar.secrets/secret.resolve` like any
  function offered by the app, over the bridge (caller `local-server`). If the
  app is closed, a shell with a reference does not start; the terminal shows the
  reason. Shells without a reference start immediately as before.
- `bayOnly` goes to the server with the offer; server and app thereby reject
  every caller with a session (`session`, `local-server` with `sessionId`) and
  every remote caller, and the MCP server does not list the function.
- The name of an entry is its identifier (`{ secret: "<name>" }`); there is no
  renaming. An entry that is deleted and created again with the same name
  applies to existing references.
- Functions: `secret.resolve` (`{ names }` → values, sensitive, bays only) and
  `secret.list` (names and descriptions for the agent bay's form, not
  sensitive, bays only).
- A job of the agent bay runs with the environment of the most recently started
  shell (ADR 0014), so with the resolved values; without a running shell it
  fails as before.
