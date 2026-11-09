import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeAgentConfig } from './agent-config';

const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const dir = () => mkdtempSync(join(tmpdir(), 'hangar-cfg-'));

describe('writeAgentConfig', () => {
  it('writes the MCP server and status hooks for Claude Code', () => {
    const wt = dir();
    writeAgentConfig(wt);
    expect(read(join(wt, '.mcp.json'))).toEqual({
      mcpServers: {
        hangar: {
          type: 'http',
          url: '${HANGAR_MCP_URL}',
          headers: { Authorization: 'Bearer ${HANGAR_TOKEN}' },
        },
      },
    });
    const settings = read(join(wt, '.claude', 'settings.local.json'));
    expect(settings.enabledMcpjsonServers).toEqual(['hangar']);
    expect(settings.hooks).toEqual({
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: 'hangar --quiet status working' }] },
      ],
      // Only what needs the person; `idle_prompt` (about 60 s after a reply, also while
      // the agent waits on CI in the background) leaves the status alone.
      Notification: [
        'permission_prompt',
        'elicitation_dialog',
        'elicitation_url_dialog',
        'agent_needs_input',
      ].map((matcher) => ({
        matcher,
        hooks: [{ type: 'command', command: 'hangar --quiet status waiting' }],
      })),
      // `--hook`: "done" becomes "background" while a background task runs (CI, a watch).
      Stop: [{ hooks: [{ type: 'command', command: 'hangar --quiet status done --hook' }] }],
    });
    expect(settings.statusLine).toEqual({ type: 'command', command: 'hangar statusline' });
  });

  it('keeps a statusline of its own in the local settings (ADR 0024)', () => {
    const wt = dir();
    mkdirSync(join(wt, '.claude'));
    const own = { type: 'command', command: 'my-line' };
    writeFileSync(join(wt, '.claude', 'settings.local.json'), JSON.stringify({ statusLine: own }));
    writeAgentConfig(wt);
    expect(read(join(wt, '.claude', 'settings.local.json')).statusLine).toEqual(own);
  });

  it('keeps existing configuration and stays idempotent', () => {
    const wt = dir();
    mkdirSync(join(wt, '.claude'));
    writeFileSync(
      join(wt, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
    );
    const own = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo stop' }] };
    writeFileSync(
      join(wt, '.claude', 'settings.local.json'),
      JSON.stringify({ model: 'opus', enabledMcpjsonServers: ['other'], hooks: { Stop: [own] } }),
    );
    writeAgentConfig(wt);
    writeAgentConfig(wt);
    expect(Object.keys(read(join(wt, '.mcp.json')).mcpServers)).toEqual(['other', 'hangar']);
    const settings = read(join(wt, '.claude', 'settings.local.json'));
    expect(settings.model).toBe('opus');
    expect(settings.enabledMcpjsonServers).toEqual(['other', 'hangar']);
    expect(settings.hooks.Stop).toEqual([
      own,
      { hooks: [{ type: 'command', command: 'hangar --quiet status done --hook' }] },
    ]);
  });

  it('replaces unreadable or non-object files', () => {
    const wt = dir();
    writeFileSync(join(wt, '.mcp.json'), '[1,2]');
    mkdirSync(join(wt, '.claude'));
    writeFileSync(join(wt, '.claude', 'settings.local.json'), '{broken');
    writeAgentConfig(wt);
    expect(read(join(wt, '.mcp.json')).mcpServers.hangar.type).toBe('http');
    expect(read(join(wt, '.claude', 'settings.local.json')).enabledMcpjsonServers).toEqual([
      'hangar',
    ]);
  });

  it('replaces the Notification hook without a matcher of earlier versions', () => {
    const wt = dir();
    mkdirSync(join(wt, '.claude'));
    const old = { hooks: [{ type: 'command', command: 'hangar --quiet status waiting' }] };
    writeFileSync(
      join(wt, '.claude', 'settings.local.json'),
      JSON.stringify({ hooks: { Notification: [old] } }),
    );
    writeAgentConfig(wt);
    const groups = read(join(wt, '.claude', 'settings.local.json')).hooks.Notification;
    expect(groups.map((g: { matcher?: string }) => g.matcher)).not.toContain(undefined);
  });

  it('keeps other hooks that share a group with a Hangar hook', () => {
    const wt = dir();
    mkdirSync(join(wt, '.claude'));
    const mixed = {
      matcher: 'Bash',
      hooks: [
        { type: 'command', command: 'hangar --quiet status done' },
        { type: 'command', command: 'echo mine' },
      ],
    };
    writeFileSync(
      join(wt, '.claude', 'settings.local.json'),
      JSON.stringify({ hooks: { Stop: [mixed] } }),
    );
    writeAgentConfig(wt);
    expect(read(join(wt, '.claude', 'settings.local.json')).hooks.Stop).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] },
      { hooks: [{ type: 'command', command: 'hangar --quiet status done --hook' }] },
    ]);
  });

  it.skipIf(process.platform === 'win32')('refuses to write through symbolic links', () => {
    const outside = dir();
    const target = join(outside, 'config.json');
    writeFileSync(target, '{"keep":true}');
    const wt = dir();
    symlinkSync(target, join(wt, '.mcp.json'));
    expect(() => writeAgentConfig(wt)).toThrow('.mcp.json ist ein symbolischer Link');
    expect(readFileSync(target, 'utf8')).toBe('{"keep":true}');

    const wt2 = dir();
    symlinkSync(outside, join(wt2, '.claude'));
    expect(() => writeAgentConfig(wt2)).toThrow('.claude ist ein symbolischer Link');
  });
});
