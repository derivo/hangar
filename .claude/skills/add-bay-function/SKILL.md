---
name: add-bay-function
description: Offer a function on a Hangar bay – declare it in the manifest, register it with ctx.provide, make it available through the bus and MCP, test it. Use when agents or other bays should be able to call something new.
---

# Offer a function on a bay

1. **Manifest**: add an entry under `functions` in `bays/<bay>/manifest.json`:
   `{ "name": "note.create", "description": "…", "sensitive": false }`.
   Name: dot-separated identifiers. `sensitive: true` for everything that reads
   secrets or can cause damage – such functions are never allowed to agents
   automatically (ADR 0006).
2. **Test first** in `src/main/*.test.ts`: valid arguments, invalid
   arguments (error text), call from a session vs. a bay, if relevant.
   Model: `bays/agents/src/main/functions.test.ts`.
3. **Implementation**: validate the arguments with zod (they arrive unchecked
   from agents or other bays) and pass the JSON schema along:
   ```ts
   const Args = z.object({ title: z.string().min(1) });
   ctx.provide(
     'note.create',
     (args, info) => {
       const { title } = Args.parse(args);
       // info.caller: { kind: 'bay', bayId } | { kind: 'session', bayId, sessionId }
       return { id: store.create(title) };
     },
     z.toJSONSchema(Args, { io: 'input' }),
   );
   ```
   `ctx.provide` fails with an error for names that are not declared.
4. **MCP**: automatically visible as the tool `<bay-id>/note.create`; integration
   test with a real bus and MCP server following the pattern
   `bays/agents/src/main/mcp.integration.test.ts`.
5. **Docs**: `docs/mcp.md` (tool, parameters, example) and the bay's `CLAUDE.md`.
   If the `hangar` CLI should know the function: `packages/cli/src/cli.ts` plus
   a test.
6. Gates and CHANGELOG.
