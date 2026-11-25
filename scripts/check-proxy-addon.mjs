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
const child = spawn('mitmdump', ['-s', addon, '--set', 'server=false'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
const timer = setTimeout(() => {
  console.error('check-proxy-addon: no hello within 60 s');
  child.kill();
}, 60_000);
let out = '';
child.stdout.setEncoding('utf8').on('data', (d) => {
  out += d;
  // mitmdump logs "Loading script" to stdout before the addon points its log to stderr.
  const line = out.split('\n').find((l) => l.startsWith('{"type":"hello"'));
  if (!line || !child.stdin.writable) return;
  console.log(`${archive}: mitmproxy ${JSON.parse(line).version}`);
  child.stdin.end(); // the addon shuts mitmdump down
});
child.on('exit', (code) => {
  clearTimeout(timer);
  rmSync(dir, { recursive: true, force: true });
  process.exit(out.includes('"hello"') ? (code ?? 1) : 1);
});
