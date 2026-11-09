// Development server for the bridge (ADR 0020): `pnpm dev:server [down]`.
// Builds hangar-server and the agent bay, starts docker/dev-server with Compose and prints
// how to pair. Key, ssh config and known_hosts live in `.dev-server/`, never in ~/.ssh.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const dir = join(root, '.dev-server');
const key = join(dir, 'key');
const port = process.env.HANGAR_DEV_SSH_PORT ?? '2299';
const compose = ['compose', '-f', join(root, 'docker/dev-server/compose.yaml')];
const env = () => ({
  ...process.env,
  HANGAR_DEV_KEY: readFileSync(`${key}.pub`, 'utf8').trim(),
  HANGAR_DEV_SSH_PORT: port,
  HANGAR_NODE_PTY: JSON.parse(readFileSync(join(root, 'bays/agents/package.json'), 'utf8'))
    .dependencies['node-pty'],
});
const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...options });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The server's log so far (`docker compose logs`). */
function serverLog() {
  return execFileSync('docker', [...compose, 'logs', '--no-log-prefix', 'server'], {
    cwd: root,
    env: env(),
    encoding: 'utf8',
  });
}

/** The last value logged as `<prefix> <value>`. */
const logValue = (log, prefix) =>
  [...log.matchAll(new RegExp(`^${prefix} (\\S+)$`, 'gm'))].at(-1)?.[1];

async function up() {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(key))
    run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'hangar-dev', '-f', key]);
  writeFileSync(
    join(dir, 'config'),
    [
      'Host hangar-dev',
      '  HostName 127.0.0.1',
      `  Port ${port}`,
      '  User test',
      `  IdentityFile ${key}`,
      '  IdentitiesOnly yes',
      `  UserKnownHostsFile ${join(dir, 'known_hosts')}`,
      '',
    ].join('\n'),
  );
  // Hangar calls this instead of ssh (HANGAR_SSH): ssh with the config above.
  writeFileSync(join(dir, 'ssh'), `#!/bin/sh\nexec ssh -F '${join(dir, 'config')}' "$@"\n`, {
    mode: 0o755,
  });

  run('pnpm', [
    '--filter',
    '@hangar/server',
    '--filter',
    '@hangar/cli',
    '--filter',
    '@hangar/bay-agents',
    'build',
  ]);
  // Recreated every time: node loaded the mounted bundles at start (volumes stay).
  run('docker', [...compose, 'up', '-d', '--build', '--force-recreate'], { env: env() });

  let log = '';
  for (let i = 0; i < 120 && !logValue(log, 'listening on'); i++) {
    await sleep(500);
    log = serverLog();
  }
  if (!logValue(log, 'listening on')) {
    process.stderr.write(log);
    throw new Error('hangar-server did not start, see the log above');
  }
  // The container's host key changes with every rebuild; it only listens on this machine's
  // loopback, so taking it as found is fine here (never for a real server).
  let hostKey = '';
  for (let i = 0; i < 20 && !hostKey; i++) {
    hostKey = execFileSync('ssh-keyscan', ['-p', port, '-t', 'ed25519', '127.0.0.1'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (!hostKey) await sleep(250);
  }
  writeFileSync(join(dir, 'known_hosts'), hostKey);

  console.log(`
Hangar-Dev-Server läuft (SSH auf 127.0.0.1:${port}).

  Desktop starten:   HANGAR_SSH=${join(dir, 'ssh')} pnpm dev
  Adresse:           hangar-dev:7420
  Fingerabdruck:     ${logValue(log, 'fingerprint')}
  Kopplungscode:     ${logValue(log, 'pairing code')}
  Projekt:           /home/test/projects/demo
  Shell im Server:   ${join(dir, 'ssh')} hangar-dev
  Stoppen:           pnpm dev:server down   (Daten bleiben; Volumes löschen: docker compose -p hangar-dev down -v)
`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'down') run('docker', [...compose, 'down'], { env: env() });
  else await up();
}
