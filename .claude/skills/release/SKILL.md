---
name: release
description: Prepare a Hangar release – bump the version, write the changelog, build the packages, tag for GitHub Releases. Use for "make a release", "publish a beta".
---

# Release

Channels: tag `vX.Y.Z` → stable, `vX.Y.Z-beta.N` → beta (GitHub prerelease).
electron-updater delivers beta only to users with the channel "Beta" in the settings.

1. Gates green: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e`.
2. Set the version – identical in `package.json` (root) and
   `apps/desktop/package.json` (the app reports this version, bays check
   `minHangarVersion` against it).
3. `CHANGELOG.md`: rename the section `Unreleased` to `## [X.Y.Z] - YYYY-MM-DD`,
   add a new empty `Unreleased` above it.
4. Check locally: `pnpm package` (builds first; without signing:
   `CSC_IDENTITY_AUTO_DISCOVERY=false`). Result in
   `apps/desktop/release/<version>/`.
5. Commit `chore(release): vX.Y.Z`, tag `vX.Y.Z` – push only after approval by the
   user. The workflow `.github/workflows/release.yml` builds on all three
   platforms into a draft and publishes it only when all three are
   finished (tags with `-`, e.g. `v1.2.0-beta.1`, as prerelease).
6. Signing/notarization: secrets `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`,
   `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`,
   `WIN_CERT_P12_BASE64`, `WIN_CERT_PASSWORD`. If they are missing, packages stay
   unsigned (macOS auto-update needs a signature).
