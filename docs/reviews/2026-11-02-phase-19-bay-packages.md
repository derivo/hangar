# Review Phase 19 – `.bay` packages and index (2026-11-02)

Reviewer: Codex (`codex exec -s read-only`), diff before the commit. Task:
path escapes, errors when reading tar, bypass of signature, checksum, expiry
and version counter, differences in canonicalization.

## Findings

1. **[P1] Negative size in the tar header → endless loop.** `-512` counted as a
   valid number, the reader jumped back to the same header. **Adopted:**
   size only from 1–11 octal digits. Test "rejects a negative size …".
2. **[P2] Directory bomb below the size limit.** 1,000 entries with 120
   folders each gave 121,000 folders from 5 KB. **Adopted:** at most 10,000
   entries and 32 path segments. Test "rejects deep paths and too many entries".
3. **[P2] `icon` outside the bay ends up in the signed package**
   (`icon: "../../signing-key.pem"`). **Adopted:** packing rejects unsafe paths
   and links on the way. Test "packs only files inside the bay".
4. **[P2] `version` with `../` lets `pack:bay` write outside `dist/bays`.**
   **Adopted:** ID in reverse-domain style, version as SemVer, otherwise abort.
   Test "refuses an id or version …".

All four cases presuppose a validly signed package or a manifest of one's own,
but are real gaps. No finding on signature, index or canonicalization.

## Not checked

Real Windows file system (upper/lower case, reserved names such as `CON`);
under macOS `wx` catches paths that differ only in spelling.
