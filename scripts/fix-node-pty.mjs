// node-pty 1.1.0 ships its macOS prebuilt `spawn-helper` without the executable bit,
// which makes every spawn fail with "posix_spawnp failed". Restore the bit after install.
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const prebuilds = join(process.cwd(), 'node_modules', 'node-pty', 'prebuilds');
if (existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, dir, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
