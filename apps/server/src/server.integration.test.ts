import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { dataWithDueJob, fixtureBays, waitForHealth } from './test-setup';

describe('hangar-server as a Node process', () => {
  it('runs a job of a bay without Electron and reports it in /health and jobs.json', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'hangar-server-dist-'));
    await build({
      configFile: join(import.meta.dirname, '../vite.config.ts'),
      logLevel: 'silent',
      build: { outDir },
    });
    const data = dataWithDueJob();
    const child = spawn(
      process.execPath,
      [join(outDir, 'hangar-server.mjs'), '--data', data, '--bays', fixtureBays],
      { env: { ...process.env, HANGAR_TICK_MS: '50' } },
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    try {
      const url = await new Promise<string>((resolve, reject) => {
        child.stdout.on('data', () => {
          const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
          if (match) resolve(match[1]!);
        });
        child.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
      });
      const health = await waitForHealth(url, (h) => !!h.jobs[0]?.lastRun);
      expect(health.jobs[0]?.lastRun?.ok).toBe(true);
      expect(JSON.parse(readFileSync(join(data, 'jobs.json'), 'utf8'))[0].lastRun.output).toBe(
        'done 1',
      );
    } finally {
      child.kill('SIGTERM');
    }
    const [code] = await once(child, 'exit');
    // Windows has no SIGTERM handler; kill ends the process without an exit code.
    if (process.platform !== 'win32') expect(code).toBe(0);
    expect(stdout).toContain('bay dev.hangar.jobtest 0.1.0 loaded');
    expect(stdout).not.toContain('done 1');
  });
});
