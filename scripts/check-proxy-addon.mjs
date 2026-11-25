// After `pnpm package`: the proxy bay's addon is inside app.asar, where the bay copies it
// from into its data folder; mitmdump must load that copy (ADR 0049, step 2).
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFile } from '@electron/asar';

const release = 'apps/desktop/release';
const archive = readdirSync(release, { recursive: true })
  .map(String)
  .map((p) => join(release, p))
  .find((p) => /[\\/]app\.asar$/.test(p));
if (!archive) {
  console.error(`check-proxy-addon: no app.asar below ${release}`);
  process.exit(1);
}
const dir = mkdtempSync(join(tmpdir(), 'hangar-addon-'));
const addon = join(dir, 'hangar_proxy.py');
writeFileSync(
  addon,
  extractFile(archive, join('bays', 'proxy', 'dist', 'addon', 'hangar_proxy.py')),
);
// Overridable so scripts/check-proxy-addon.test.ts does not wait a minute.
const timeout = Number(process.env.CHECK_PROXY_ADDON_TIMEOUT_MS ?? 60_000);
const child = spawn('mitmdump', ['-s', addon, '--set', 'server=false'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
const finish = (code) => {
  rmSync(dir, { recursive: true, force: true });
  process.exit(code);
};
// Any timeout fails, also one after the hello: mitmdump must end on its own when stdin closes.
const timer = setTimeout(() => {
  console.error(`check-proxy-addon: no hello or no exit within ${timeout} ms`);
  child.kill('SIGKILL');
  finish(1);
}, timeout);
let rest = '';
let hello;
child.stdout.setEncoding('utf8').on('data', (d) => {
  const lines = (rest + d).split('\n');
  rest = lines.pop(); // only complete lines are parsed
  // mitmdump logs "Loading script" to stdout before the addon points its log to stderr.
  const line = lines.find((l) => l.startsWith('{"type":"hello"'));
  if (!line || hello) return;
  hello = JSON.parse(line);
  console.log(`${archive}: mitmproxy ${hello.version}`);
  child.stdin.end(); // the addon shuts mitmdump down
});
child.on('exit', (code) => {
  clearTimeout(timer);
  finish(hello ? (code ?? 1) : 1);
});
