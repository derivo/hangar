# bays/secrets – Passwords (`dev.hangar.secrets`)

Holds passwords and tokens, encrypted with the system keychain
(ADR 0021). Other bays read them over the bus; agents never.

## Structure

- `manifest.json` – `hostModules: ["secrets"]`, functions only for bays (`bayOnly`).
- `src/main/vault.ts` – `Vault`: `list`, `save(name, value?, description)`
  (without a value the old one stays), `remove`, `resolve(names)`. Writes
  `<dataDir>/vault.json` atomically with mode 0600, values only encrypted
  (`ctx.secrets`). Name like an environment variable, never `HANGAR_*`;
  description at most 200 characters.
- `src/main/index.ts` – bus functions and UI channels `list`, `save`, `remove`;
  event `state` after every change.
- `src/ui/` – list (name, description, change, never the value), form
  "New password", "Replace value" (Escape cancels), delete with confirmation.

## Functions

| Function         | Effect                                                                       |
| ---------------- | ---------------------------------------------------------------------------- |
| `secret.list`    | `[{ name, description, updatedAt }]`, without values                         |
| `secret.resolve` | sensitive; `{ names }` → `{ NAME: value }`; unknown: `Unknown password: <n>` |

## Pitfalls

- Without a keychain (`ctx.secrets` missing or throwing) the bay stores and reads
  nothing; plaintext never exists.
- A server does not load the bay (host module only in the desktop app). The
  agent bay in the local server resolves through the bridge; if the app is
  closed, the shell does not start.
- A double click on save/delete takes effect once (ADR 0028, `e2e/chaos.spec.ts`).
