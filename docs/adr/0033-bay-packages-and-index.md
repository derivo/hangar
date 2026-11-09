# ADR 0033 – `.bay` packages and signed index

Status: accepted (Phase 19; basis: [ADR 0012](0012-registry.md),
[concept-registry.md](../concept-registry.md) "Signature and index")

## Context

Bays should be installed and updated without a new Hangar build (Phase 20, 21).
This needs a package format, a signature and an index that Hangar believes only
if it is genuine, current and not older than the last one seen. A package is
unpacked into the person's data folder; an error while unpacking would
otherwise write outside it.

## Decision

- **Package:** `<version>.bay` is a tar.gz (ustar) with `manifest.json`, the
  icon from `icon` and `dist/` of the built bay, sorted, without times and
  owners (same input, same bytes). Sources and `node_modules` are not part of
  it; native modules are supplied by the host (ADR 0004). Symbolic links in the
  bay, also on the way to the icon, and paths outside the bay abort packing;
  identifier and version must be safe file names (they name the output).
- **Signature:** Ed25519 over the bytes of the `.bay` file, base64 in
  `<version>.bay.sig`; plus SHA-256 (hex) and size for the index.
  `verifyPackage` checks first the checksum, then the signature.
- **Unpacking** (`unpackBay`) only after verification and only into a new
  folder. Before the first write the whole archive is checked: only files and
  folders (type `0`, `5`), no links, devices or pax headers; no absolute paths,
  no `\`, no drive, no segments `..`, `.` or empty; no path twice; header
  checksums match, archive not truncated. Files are created with `wx` (never
  through something that is already there), mode 644 or 755. At most 256 MiB
  unpacked, 10,000 entries and 32 path segments (folders cost no bytes in the
  archive); size fields only as octal digits.
- **Own tar code instead of a dependency:** Reading and writing are a good 100
  lines; the rules above are stricter than the options of common packages, and
  the packer (`scripts/pack-bay.ts`) runs directly with Node. ASCII paths only.
- **Index** (`index.json`): `{ signed: { version, expires, bays: [...] },
signature }`, Ed25519 over the canonical JSON of `signed` (sorted keys,
  `canonical` from `@hangar/relay`). Per bay version `id`, `version`,
  `channel` (`stable`, `beta`), `sha256`, `size`, `signature`, optional
  `minHangarVersion`, and `url` relative to the index. `verifyIndex` rejects:
  wrong format, wrong signature, expired `expires`, `version` below the last
  one seen. The signature is checked over the received object, not over the one
  cleaned by zod.
- **Tooling:** `pnpm pack:bay <id> [--key <file>]` (key also from
  `HANGAR_BAY_KEY`) writes `dist/bays/<id>/<version>.bay` and `.bay.sig` and
  prints the index fields as JSON; `--keygen <file>` creates a key (PKCS#8,
  mode 600) and names the public key.
- `publisher` and `publishers.json` are dropped (decision of 2026-10-29): one
  key for index and packages.

## Consequences

- Phase 20 builds installation, update and rollback on this; the built-in public
  key and the last-seen index state are added there.
- Key rotation (old key signs the new one) is not implemented yet.
