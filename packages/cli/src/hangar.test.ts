import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const entry = join(import.meta.dirname, 'hangar.ts');

describe('hangar entry point', () => {
  it('prints usage and exits 0 for help', async () => {
    const { stdout } = await exec(process.execPath, [entry, 'help']);
    expect(stdout).toContain('hangar status <working|waiting|background|done|idle> [--hook]');
  });

  it('writes errors to stderr and exits 1', async () => {
    const error = await exec(process.execPath, [entry, 'status', 'done'], {
      env: { LANG: 'de_DE.UTF-8' },
    }).catch((e: { code: number; stderr: string }) => e);
    expect(error).toMatchObject({
      code: 1,
      stderr: 'Nicht in einer Hangar-Session: HANGAR_MCP_URL und HANGAR_TOKEN fehlen.\n',
    });
  });

  it('never hangs a Stop hook whose input stays open, and stays quiet (Codex review)', async () => {
    const child = spawn(process.execPath, [entry, '--quiet', 'status', 'done', '--hook'], {
      env: { PATH: process.env.PATH },
    });
    const started = Date.now();
    const [code] = (await once(child, 'close')) as [number];
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('statusline runs the statusline of the person with the same stdin', async () => {
    const config = mkdtempSync(join(tmpdir(), 'hangar-claude-'));
    writeFileSync(
      join(config, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'tr a-z A-Z' } }),
    );
    const child = spawn(process.execPath, [entry, 'statusline'], {
      env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: config },
    });
    child.stdin.end('{"cwd":"/","model":"opus"}');
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d));
    const [code] = (await once(child, 'close')) as [number];
    expect({ code, out }).toEqual({ code: 0, out: '{"CWD":"/","MODEL":"OPUS"}' });
  });
});
