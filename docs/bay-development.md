# Developing bays

A bay is a standalone application in Hangar. It consists of a manifest, a user
interface (UI part) and optionally a main part that runs in the main process of
Hangar. The model for all examples is the agent bay in `bays/agents`.

## Creating a new bay

```sh
pnpm create:bay <id>
```

`<id>` is the bay identifier in reverse-domain style, e.g. `dev.hangar.notes`.
The script `scripts/create-bay.mjs` creates `bays/<last segment of the identifier>/`,
in the example `bays/notes/`, with:

- `manifest.json`, `icon.svg`, `package.json`, `CLAUDE.md`
- `src/main/index.ts` and `src/main/index.test.ts`
- `src/ui/index.html` and `src/ui/main.tsx`
- Vite configurations for the UI and the main part

After that, `pnpm dev` (via `build:deps`) builds all bays under `bays/` and
starts the app. Hangar finds every bay with a `manifest.json` in `bays/`;
`HANGAR_BAYS_DIR` (a list of paths) replaces this folder. A bay is only started
once it has been added via the plus in the sidebar (ADR 0017); without that
there is neither a main part nor MCP tools.

## Structure of a bay folder

```
bays/agents/
  manifest.json         Identifier, name, version, files, functions
  icon.svg              Icon in the sidebar
  package.json          Build script, dependencies
  vite.ui.config.ts     builds src/ui to dist/ui (relative paths, base './')
  vite.main.config.ts   bundles src/main into one ESM file dist/main/index.js
  src/main/             main part (main process)
  src/ui/               UI (index.html, React)
  dist/                 Build output, the manifest points to it
  CLAUDE.md             Purpose, interfaces, pitfalls
```

The main part is bundled as one ESM file. Native modules (e.g. node-pty) stay
external and come from the `node_modules` of the host (ADR 0004). Third-party
bays with native modules of their own are not planned in the MVP.

## Manifest

Schema: `BayManifestSchema` in `packages/sdk/src/manifest.ts`.

| Field              | Required | Rule                                                                                               |
| ------------------ | -------- | -------------------------------------------------------------------------------------------------- |
| `id`               | yes      | Reverse-domain style: `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$`, e.g. `dev.hangar.agents`            |
| `name`             | yes      | not empty; display name, the bay selection (plus in the sidebar) is sorted by it                   |
| `version`          | yes      | SemVer `x.y.z`, optionally with a prerelease (`-beta.1`)                                           |
| `minHangarVersion` | no       | SemVer; if Hangar is older, the bay is not loaded                                                  |
| `icon`             | yes      | relative path inside the bay                                                                       |
| `ui`               | yes      | relative path to the HTML file of the UI                                                           |
| `main`             | no       | relative path to the bundled main part                                                             |
| `functions`        | no       | list of offered functions, default `[]`                                                            |
| `hostModules`      | no       | capabilities of the host: `browser` (see "Browser tabs"), `workspaces`, `secrets` (see "Keychain") |
| `uses`             | no       | functions of other bays that the main part calls: `<bay-id>/<function>` (ADR 0032)                 |
| `agentSessions`    | no       | `true`: the bay may use `registerAgentSession`, otherwise it throws (ADR 0032)                     |
| `dataVersion`      | no       | integer from 0; format of the bay data (backup on change follows with updates)                     |
| `settings`         | no       | settings of the bay in the Hangar settings (ADR 0023), see "Settings"                              |

Relative paths must not start with `/` or a drive letter and must not contain
`..`. `icon`, `ui` and `main` must exist when loading.

Each function:

| Field          | Required | Rule                                                                                                         |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `name`         | yes      | `^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)*$`, e.g. `session.setStatus`; unique                          |
| `sensitive`    | no       | default `false`; Hangar never releases sensitive functions to agents automatically                           |
| `openToAgents` | no       | `true`: agents of any bay call without a prompt; not together with `sensitive` (ADR 0016)                    |
| `remote`       | no       | `true`: other Hangar instances may call if released; not together with `sensitive` (ADR 0011)                |
| `bayOnly`      | no       | `true`: only bays call, no MCP tool, never an agent; not together with `openToAgents` or `remote` (ADR 0021) |
| `description`  | no       | description of the MCP tool; if missing, the name is used                                                    |

An invalid manifest prevents loading; the bay appears in the sidebar with a
readable error message, e.g. `id: must be in reverse-domain style` or
`functions: Duplicate function name "x"`. Further load errors: duplicate bay
identifier (`Duplicate bay id "<id>"`), Hangar version too old
(`Requires Hangar <min> or newer (installed: <version>)`), missing file
(`Missing file: <pfad>`).

Example (`bays/agents/manifest.json`, shortened):

```json
{
  "id": "dev.hangar.agents",
  "name": "Agents",
  "version": "0.1.0",
  "minHangarVersion": "0.1.0",
  "icon": "icon.svg",
  "ui": "dist/ui/index.html",
  "main": "dist/main/index.js",
  "functions": [
    {
      "name": "session.setStatus",
      "sensitive": false,
      "description": "Reports the status of your own session: working, waiting, background, done or idle."
    }
  ]
}
```

## Main part

The main part exports an object of type `BayMain` as its default. Hangar loads
it at startup via `import()` and calls `activate(ctx)` once. It keeps running
while the UI is hidden or the window is closed. `deactivate()` is called before
quitting; save state there.

```ts
import type { BayMain } from '@hangar/sdk';

const bay: BayMain = {
  activate(ctx) {
    ctx.provide('hello.say', () => 'hi');
    ctx.ui.handle('state', () => ({ greeting: 'hi' }));
  },
  deactivate() {
    // write state to ctx.dataDir
  },
};
export default bay;
```

If `activate` throws, Hangar removes all functions of the bay from the bus and
shows the bay in the sidebar with `Start failed: <message>`.

### `BayContext`

Defined in `packages/sdk/src/types.ts`, implemented in
`packages/host/src/bay-runtime.ts`.

| Member                                             | Effect                                                                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `bayId`                                            | Identifier from the manifest                                                                                          |
| `dataDir`                                          | own data folder `<userData>/bays/<id>`; is created; the bay manages its state itself                                  |
| `hangarVersion`                                    | Version of the running app                                                                                            |
| `locale`                                           | Language of the app (`de`, `en`, in tests also `en-XA`); fixed until the next start, see "Texts and languages"        |
| `onLocaleChange(listener)`                         | only on a server: the language follows the most recently connected desktop; `listener` receives the new one           |
| `settings.get(key)`, `settings.onChange(listener)` | Value of a setting from the manifest (see "Settings"); `listener` receives `{ key, value }`                           |
| `provide(name, handler, schema?)`                  | Offer a function on the bus (see below)                                                                               |
| `call(target, args?)`                              | Call a function of another bay; `target` is `<bay-id>/<function>` and must be in `uses`                               |
| `notify({ title, body? })`                         | System notification; a click brings the bay to the front                                                              |
| `setBadge(count)`                                  | Badge on the entry in the sidebar; `0` hides it; values are rounded down, negative ones become `0`                    |
| `setRunning(count)`                                | how many processes of the bay keep running (shells); the local server counts them for tray and restart (ADR 0036)     |
| `registerAgentSession(sessionId)`                  | registers an agent session with the MCP server (only with `agentSessions: true`); returns `{ token, mcpUrl, cliDir }` |
| `unregisterAgentSession(sessionId)`                | invalidates the token and discards the session permissions                                                            |
| `onAgentSessionEnded(listener)`                    | `listener({ bayId, sessionId })` when any bay unregisters an agent session (ADR 0016)                                 |
| `labelSessions(label)`                             | `label(sessionId)` returns the name of a session for the settings (instead of the identifier)                         |
| `jobs.onRun(handler)`                              | runs due jobs of the bay; returning text = success, exception = failure (ADR 0013)                                    |
| `jobs.add({ label, schedule, payload? })`          | creates a job (cron with five fields, local time); throws on an invalid schedule                                      |
| `jobs.list()` / `jobs.remove(id)`                  | own jobs with next and last run / delete an own job                                                                   |
| `pickFolder({ title?, path? })`                    | native folder dialog; `undefined` on cancel. On the server it checks `path` against `--root` (ADR 0018)               |
| `ui.handle(channel, handler)`                      | answers `window.hangar.invoke(channel, ...args)` from the own UI                                                      |
| `ui.send(channel, payload)`                        | event to the own UI (`window.hangar.on`); no effect without a loaded UI                                               |

The sum of all badges additionally appears on the app icon (`app.setBadgeCount`).

## UI part

The UI is an HTML page from the bay folder, loaded in its own
`WebContentsView`:

- `sandbox: true`, `contextIsolation: true`, no Node access.
- Own storage partition `persist:bay:<id>`.
- Navigation is blocked. `window.open` with an `http(s)` URL opens the default
  browser, everything else is rejected.
- Asset paths must be relative (`base: './'` in the Vite configuration).

The only connection to the main part is `window.hangar` (type `HangarUiApi`):

```ts
const state = await window.hangar.invoke<{ greeting: string }>('state');
const off = window.hangar.on('state', (payload) => render(payload));
// later: off();
```

- `invoke(channel, ...args)` calls the handler registered with `ctx.ui.handle`.
  If it is missing, the error is `No handler for "<channel>"`. Error messages
  from the main part arrive with an Electron prefix, e.g.
  `Error invoking remote method 'bay:invoke': Error: <message>`; the agent bay
  removes it in `src/ui/api.ts` (`errorMessage`).
- `on(channel, listener)` receives events from `ctx.ui.send` and returns an
  unsubscribe function.
- `windows` opens own windows of the bay (ADR 0010): `open(key, title)` loads
  the UI again with `?window=<key>` or brings the window to the front,
  `close(key)`, `list()`, `onChange(listener)`. `windows.current` is the key in
  the window, `undefined` in the view. Windows share storage and events with the
  view and open again after a restart.

## Texts and languages

Hangar speaks German and English (ADR 0009). Each bay brings a catalog for both
and chooses it once at startup:

```ts
// src/ui/messages.ts (main part analogous with ctx.locale)
import { catalogFor, type UiLocale } from '@hangar/sdk/i18n';

const de = { hello: 'Hallo', remove: (name: string) => `${name} entfernen` };
const en: typeof de = { hello: 'Hello', remove: (name) => `Remove ${name}` };

export let t = de;
export function setLocale(locale: UiLocale) {
  t = catalogFor({ de, en }, locale);
}
// main.tsx: setLocale(window.hangar.locale);
```

- `const en: typeof de` makes `pnpm typecheck` fail if a text is missing.
- Whole sentences with placeholders as a function, no composed sentence
  fragments.
- Texts for agents (function descriptions in the manifest, errors from bus
  functions) stay English.
- On a server, `ctx.locale` changes when a desktop with a different language
  connects: call `ctx.onLocaleChange(setLocale)` in the main part.
- Hangar sets `<html lang>` itself. With `HANGAR_LOCALE=en-XA` the bay shows
  pseudo texts in square brackets; text without brackets is hard-coded.

### Theme

Hangar injects `packages/theme/src/tokens.css` into every bay UI at
`dom-ready`. Bays only use `var(--hangar-*)`, e.g. `--hangar-color-bg`,
`--hangar-color-text`, `--hangar-color-accent`, `--hangar-font-sans`,
`--hangar-space-2`, `--hangar-radius`. Dark mode follows
`prefers-color-scheme`; `data-theme="light"` or `data-theme="dark"` on the root
element forces a mode. For values outside CSS (e.g. xterm.js),
`readToken(name)` from `@hangar/theme` returns the light value of a token.

## Offering functions

```ts
ctx.provide(
  'note.add',
  (args, info) => {
    const { text } = parse(args); // arguments are untrusted
    return { ok: true };
  },
  { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
);
```

- The name must be in `manifest.json` under `functions`, otherwise `provide`
  throws: `Function "<name>" is not declared in the manifest`.
- The function is then reachable as `<bay-id>/<name>` for other bays and as an
  MCP tool of the same name. `sensitive` and `description` come from the
  manifest.
- The third argument is a JSON Schema of the arguments; MCP clients see it as
  `inputSchema`. Without a schema, `{ "type": "object" }` applies. The agent bay
  generates the schema from zod (`z.toJSONSchema(schema, { io: 'input' })`).
- `args` is untrusted and must be checked. `info.caller` says who is calling:
  `{ kind: 'bay', bayId }` or
  `{ kind: 'session', bayId, sessionId }`.
- The return value must be JSON-serializable. Via MCP it arrives as
  `JSON.stringify(result ?? null)`; a thrown exception becomes an MCP result
  with `isError: true` and the message as text.

## Calling other bays

```ts
const result = await ctx.call<{ ok: boolean }>('dev.hangar.notes/note.add', { text: 'hi' });
```

The target must be in the manifest under `uses` (ADR 0032), otherwise the call
throws `Access denied: <bay-id> → <target> (not in the manifest's "uses")`;
own functions always work. Unknown targets throw
`Unknown function: <target>`, denied accesses
`Access denied: <bay-id> → <target>` (`PermissionDeniedError`).

## Permissions

Implemented in `Bus.authorize` (`packages/bus/src/bus.ts`), defined in
ADR 0006.

- **Subject** is always the calling bay. An agent acts on behalf of the bay
  that its session belongs to. The target is `<bay-id>/<function>`.
- **Own bay:** A bay may call all its own functions, its agents all its own
  non-sensitive functions, without a prompt.
- **Declared in `uses`, not sensitive** (ADR 0032, addendum): A bay calls
  without a prompt; a block from the settings still applies.
- **Other bay, not sensitive:** On first access, Hangar asks
  ("Allow" / "Deny"). The answer is stored permanently in `permissions.json`.
- **Open to agents** (`openToAgents`, ADR 0016): Agents of any bay call
  without a prompt, unless the settings block it (`deny`). Only for
  functions that act solely on data of the caller.
- **Other Hangar instance** (ADR 0011): The "own bay" rule never applies, even
  with the same bay identifier. Before every call, the bus checks: the function
  carries `remote: true`, is not sensitive, is in the share list of the
  workspace, and the instance is a member of it. Only then does the stored
  permission count (subject `remote:<fingerprint>/<bay-id>`), otherwise Hangar
  asks. The manifest rejects bay identifiers with the prefix `remote.`.
- **Bays only** (`bayOnly`, ADR 0021): Agents, other instances and agents of
  the local server are rejected before any rule, without a dialog;
  `tools/list` does not show the function. The local server itself (without a
  session) counts as a bay.
- **Sensitive function without a stored permission** (also for agents of the
  own bay): Hangar asks with four answers:
  - "Always allow" → stored as `allow`,
  - "For this session" (agent) or "Only this time" (bay) → permission only in
    memory for this session; for a bay it only applies to this call,
  - "Ask on every access" → stored as `ask`; this call runs, every further one
    shows "Allow" / "Deny",
  - "Deny" → stored as `deny`.
- Cancelling the dialog counts as "Deny".
- Session permissions end with the session (`unregisterAgentSession`).
- The settings show the permissions per caller as a table: function with
  description from the manifest, sensitive, release, granted, last call.
  Session permissions carry the name of the session (`labelSessions`). The
  release can be changed (`allow`/`deny`, for sensitive functions also `ask`),
  revoked (after that, Hangar asks again) or set before the first access under
  "Set a rule" (`Bus.setMode`). The last call is only in memory and counts
  since startup.

## Notifications and badges

- `ctx.notify({ title, body })` shows a system notification. A click brings the
  window to the front and selects the bay. With `HANGAR_E2E`, notifications are
  not shown but recorded for E2E tests.
- `ctx.setBadge(count)` sets the badge in the sidebar. The agent bay sets it to
  the number of waiting sessions and additionally reports `waiting` as a
  notification "Session is waiting for input".

## Jobs

- `ctx.jobs.add({ label, schedule: '0 2 * * 1-5', payload })` creates a job; it
  survives restarts. `payload` is JSON data, not code.
- `ctx.jobs.onRun(async (job) => …)` runs due jobs, even without a loaded UI.
  The returned text appears as the result in the settings under "Jobs", an
  exception as a failure.
- Jobs only run while Hangar is running; a missed run is made up once after
  waking up. Without `onRun` (bay not loaded) they do not run, but stay
  stored. Rules: ADR 0013.

## Browser tabs

With `"hostModules": ["browser"]` in the manifest, the main part gets
`ctx.browser` (ADR 0015, model `bays/browser`):

- `open(url, { partition, persist })` creates a tab and waits at most
  30 seconds for it to load; `navigate`, `back`, `forward`, `reload`, `close`,
  `list`, `onChange(listener)`. Cmd/Ctrl +, - and 0 in a page zoom it;
  `list` names the zoom in percent (`zoom`, absent at 100 %), `resetZoom(id)`
  sets it back.
- `evaluate(id, script)` runs a script in the page; `screenshot(id)`
  returns a PNG.
- `errors(id)` lists errors and warnings of the page (failed load or HTTP
  400+, console, failed requests; ADR 0042); `list` names `status` and the
  error count `errors`. `find(id, text, { forward, next })` and
  `stopFind(id)` find in the page, the result comes as `find` of the tab;
  `focus(id)` gives the page the keyboard focus;
  `onFindRequest(listener)` hears Cmd/Ctrl+F pressed in a page.
  `trustCertificate(id, { host, fingerprint })` trusts the certificate a page
  was refused with (`certificate` of the tab, as shown to the person)
  for its host until Hangar quits and loads the page again (ADR 0043); offer it
  only to the person, never to agents.
- Partitions only apply within the bay; `persist: true` keeps cookies
  across restarts. Only http, https and `about:blank` are loaded, web pages
  receive no permissions (camera, location …).
- The UI shows a tab with `window.hangar.browser.show(id, rect)`
  over a rectangle of its own view; `show(undefined)` hides it.
  What lies under the rectangle is covered.

## Keychain

With `"hostModules": ["secrets"]` in the manifest, the main part gets
`ctx.secrets` (ADR 0021, model `bays/secrets`): `encrypt(text)` returns Base64,
`decrypt(data)` the text. The desktop app encrypts with the keychain of the
system (`safeStorage`) and throws if it is not available; it never stores
plain text. A server does not load a bay with this module.

## Settings

A bay declares settings in the manifest (ADR 0023); the Hangar settings show
them under "Bay settings" in the app language: `boolean` as a
checkbox, `text` as a text field (ADR 0025).

```json
"settings": [
  {
    "key": "copyOnSelect",
    "type": "boolean",
    "default": true,
    "label": { "de": "Markieren kopiert in die Zwischenablage", "en": "Selecting copies to the clipboard" },
    "description": { "de": "Gilt für neue Sessions.", "en": "Applies to new sessions." }
  }
]
```

- `type: "boolean"` (`default` true/false) or `type: "text"` (`default` a string);
  `key` is unique per bay.
- Stored in `settings.json` under `baySettings[<bay-id>][<key>]`; if the
  value is missing or has the wrong type, `default` applies.
- In the main part: `ctx.settings.get(key)` (`boolean | string`, type `SettingValue`) and `ctx.settings.onChange(({ key, value }) => …)`.
  The UI asks its main part; it has no interface of its own.
- On a Hangar server, the `settings.json` of the server applies; the desktop app
  does not show these settings.

## Hangar version

`minHangarVersion` in the manifest sets the smallest supported Hangar version.
Hangar compares it with its own version via SemVer and otherwise does not load
the bay. At runtime, `ctx.hangarVersion` returns the version.

## Testing

The rules from the root `CLAUDE.md` apply: test first, 90 % lines and branches
for `bays/*/src/main` (`vitest.config.ts`), Git tests only against temporary
repositories.

- **Main part** (`bays/*/src/main/**/*.test.ts`, Vitest project `node`):
  call `activate` with a fake context and run functions or UI channels
  directly. The agent bay has helpers for this:
  - `test-ctx.ts` – `fakeContext()` returns `ctx` (a `BayContext` made of
    `vi.fn()` mocks with a temporary `dataDir`), `invoke(channel, ...args)` for
    UI channels and `functions` with all functions registered via `provide`,
  - `test-pty.ts` – `fakeSpawn()`, a controllable pseudo-terminal,
  - `test-repo.ts` – `createTempRepo()`, a throwaway Git repository under
    `mkdtemp`.

  The helpers live in the agent bay and are not part of the SDK.

- **Integration**: `mcp.integration.test.ts` wires the bay to a real
  `Bus` and MCP server; `cli.integration.test.ts` types `hangar` commands into a
  real shell.
- **UI** (`bays/*/src/ui/**/*.test.{ts,tsx}`, Vitest project `ui` with jsdom):
  replace `window.hangar` with a stub.
- **E2E**: Playwright against the built app in `apps/desktop/e2e/`
  (`pnpm test:e2e`).

Pattern after `bays/agents/src/main/functions.test.ts` (`sessionId` comes from a previously created session):

```ts
const bay = createAgentsBay(fakeSpawn());
const { ctx, functions } = fakeContext();
await bay.activate(ctx);
const info = { caller: { kind: 'session', bayId: 'dev.hangar.agents', sessionId } };
functions.get('session.setStatus')!({ status: 'done' }, info);
```

## SDK reference (`@hangar/sdk`)

| Export                          | Kind  | Purpose                                                                     |
| ------------------------------- | ----- | --------------------------------------------------------------------------- |
| `BayManifestSchema`             | value | zod schema of `manifest.json`                                               |
| `parseManifest(input)`          | value | validates manifest JSON; `{ ok: true, manifest }` or `{ ok: false, error }` |
| `BayManifest`, `ManifestResult` | type  | result types of the validation                                              |
| `BayMain`                       | type  | shape of the main module: `activate(ctx)`, optional `deactivate()`          |
| `BayContext`                    | type  | everything the host gives to the main part                                  |
| `BayFunction`                   | type  | `(args: unknown, info: CallInfo) => unknown`                                |
| `CallInfo`, `Caller`            | type  | caller of a function (from `@hangar/bus`)                                   |
| `HangarNotification`            | type  | `{ title: string; body?: string }`                                          |
| `AgentAccess`                   | type  | `{ token, mcpUrl, cliDir }` for a session shell                             |
| `HangarUiApi`                   | type  | `window.hangar` with `locale`, `invoke`, `on` and `windows`                 |
| `BayWindows`                    | type  | own windows of a bay (`open`, `close`, `list`, `onChange`, `current`)       |
| `Locale`, `UiLocale`            | type  | `de` \| `en`; `UiLocale` additionally the pseudo-locale `en-XA`             |
| `catalogFor(catalogs, locale)`  | value | chooses the catalog; `en-XA` pseudo-localizes the English one               |
| `resolveLocale(languages)`      | value | first German or English language of a list, otherwise `en`                  |
| `isUiLocale`, `pseudoLocalize`  | value | check or pseudo-localization of a catalog                                   |

`pnpm docs:api` generates an API reference with TypeDoc into `docs/api/`.
