# Review links in the terminal (2026-11-02)

Reviewer: Codex (`codex exec -s read-only`), diff before the commit. Bug: a
click on an OSC 8 link asked for confirmation and opened nothing after "OK".
xterm 6.0.0 by default opens `window.open()` without an address and sets it
afterwards; the host (`setWindowOpenHandler`) rejects `about:blank`.

## Findings

1. **[P2] Show the target before opening.** The first version opened without
   asking; the visible text of an OSC 8 link can feign a different address.
   **Adopted:** the prompt names the real target ("Open link?" and the
   address), only after "OK" `window.open(uri)`. Test
   `e2e/terminal-links.spec.ts`: cancelling opens nothing, "OK" opens, both
   prompts name the address.

No finding: only http(s) is activated (`allowNonHttpProtocols` stays off;
`javascript:`, `file:`, `mailto:`, `data:` discarded, checked by Codex with
xterm 6.0.0); undocked sessions use the same host handler.

## Not checked

Links without OSC 8 (plain addresses in the text) are still not clickable;
that would need the web links addon. Links are not reachable by keyboard
(as before in xterm).
