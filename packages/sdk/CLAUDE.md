# @hangar/sdk

Public API for bay developers: manifest schema and the types of the
bay context (main) and `window.hangar` (UI).

## Interfaces

- `parseManifest(json)` / `BayManifestSchema` – validation of `manifest.json` (zod).
- `BayContext`, `BayMain` – main part of a bay (`activate(ctx)`, `deactivate()`).
- `HangarUiApi` – `window.hangar.locale/invoke/on` in the bay UI;
  `server` carries the name of the server if the UI shows a server bay
  (ADR 0019), otherwise it is missing.
- ADR 0016: function in the manifest with `openToAgents` (not together with `sensitive`);
  `ctx.onAgentSessionEnded(listener)` reports the end of every agent session;
  `ctx.onLocaleChange(listener)` a language change (only on a server).
- ADR 0011: function in the manifest with `remote: true` (not together with `sensitive`) can be called by
  other instances if a workspace shares it; bay ids with `remote.`
  are reserved.
- ADR 0032: manifest `uses` (`<bay-id>/<function>`, otherwise `ctx.call` rejects foreign targets),
  `agentSessions` (otherwise `ctx.registerAgentSession` throws), `dataVersion` (integer from 0).
- ADR 0023, 0025: manifest `settings` (`SettingSchema`, `boolean` or `text`, key unique per
  bay) → `ctx.settings.get(key)` (`SettingValue`), `ctx.settings.onChange(listener)`.
- Host module `browser` (ADR 0015): manifest `hostModules: ["browser"]` → `ctx.browser`
  (`BayBrowser`: open, navigate, close tabs, `evaluate`, `screenshot`, page errors and
  find in page, ADR 0042; `trustCertificate` for the person only, ADR 0043) and
  `window.hangar.browser.show(id, rect)` (`BayBrowserView`).
- Host module `workspaces` (ADR 0030): `hostModules: ["workspaces"]` → `ctx.workspaces`
  (`BayWorkspaces`: `publish(state)` to the bay with the same id of all members, `states()`,
  `onState(listener)` with `RemoteBayState` including workspace and instance; the state is not
  trustworthy, the bay checks it).
- ADR 0021: function in the manifest with `bayOnly` (not with `openToAgents` or `remote`): only bays
  call it. Host module `secrets`: `hostModules: ["secrets"]` → `ctx.secrets`
  (`BaySecrets`: `encrypt(text)`, `decrypt(data)`; throws without a keychain).
- `@hangar/sdk/i18n` – `Locale`, `UiLocale`, `catalogFor`, `resolveLocale`,
  `pseudoLocalize` (ADR 0009). Without dependencies, so that bay UIs do not bundle
  zod.

## Pitfalls

- All public interfaces carry TSDoc; `pnpm docs:api` generates `docs/api/`
  from it. Always document new exports.
- Manifest paths must be relative and must not leave the bay (`..`).
- The implementation of the context is in `packages/host/src/bay-runtime.ts`.
