// After `pnpm package`: the proxy bay's addon is a real file under app.asar.unpacked and
// mitmdump loads it from there (ADR 0049, step 2).
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const release = 'apps/desktop/release';
const addon = readdirSync(release, { recursive: true })
  .map(String)
  .map((p) => join(release, p))
  .find((p) =>
    /app\.asar\.unpacked[\\/]bays[\\/]proxy[\\/]dist[\\/]addon[\\/]hangar_proxy\.py$/.test(p),
  );
if (!addon) {
  console.error(`check-proxy-addon: no unpacked hangar_proxy.py below ${release}`);
  process.exit(1);
}
const child = spawn('mitmdump', ['-s', addon, '--set', 'server=false'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
const timer = setTimeout(() => {
  console.error('check-proxy-addon: no hello within 60 s');
  child.kill();
  process.exit(1);
}, 60_000);
let out = '';
child.stdout.setEncoding('utf8').on('data', (d) => {
  out += d;
  if (!out.includes('\n')) return;
  const hello = JSON.parse(out.slice(0, out.indexOf('\n')));
  if (hello.type !== 'hello') throw new Error(`unexpected first line ${out}`);
  console.log(`${addon}: mitmproxy ${hello.version}`);
  child.stdin.end(); // the addon shuts mitmdump down
});
child.on('exit', (code) => {
  clearTimeout(timer);
  process.exit(out.includes('"hello"') ? (code ?? 1) : 1);
});
