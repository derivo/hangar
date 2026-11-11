import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sshVersion, stdinNullSupported } from './tunnel';

/** A Linux machine reached over SSH where the app sets up its server (ADR 0041). */
export interface SetupTarget {
  user?: string;
  host: string;
}

// No leading `-`: ssh would read the host or user as an option.
const NAME = '[A-Za-z0-9_][A-Za-z0-9._-]*';
const SETUP_ADDRESS = new RegExp(`^(?:(${NAME})@)?(${NAME})$`);

/** `[user@]host`, as in `~/.ssh/config`; no port: the server's port is read from the machine. */
export function parseSetupAddress(address: string): SetupTarget {
  const m = SETUP_ADDRESS.exec(address.trim());
  if (!m) throw new Error(`Invalid address: ${address.trim()}`);
  return { ...(m[1] && { user: m[1] }), host: m[2]! };
}

/** Runs a shell script on the machine; `input` (a file) becomes its stdin. */
export type Remote = (
  script: string,
  input?: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * `ssh` without prompts and without the user's own command or shared connection (as the tunnel,
 * ADR 0019); the script runs in `sh`, whatever the login shell is.
 */
export function sshRemote(target: SetupTarget, ssh = 'ssh'): Remote {
  const version = sshVersion(ssh);
  return async (script, input) => {
    const args = [
      '-T',
      ...['-o', 'BatchMode=yes', '-o', 'RemoteCommand=none'],
      ...['-o', 'ControlMaster=no', '-o', 'ControlPath=none'],
      ...(stdinNullSupported(await version) ? ['-o', 'StdinNull=no'] : []),
      '--',
      target.user ? `${target.user}@${target.host}` : target.host,
      `sh -c ${quote(script)}`,
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(ssh, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += String(c)));
      child.stderr.on('data', (c) => (stderr += String(c)));
      child.on('error', (e) => reject(new Error(`SSH failed: ${e.message}`)));
      child.on('close', (code) => {
        // 255 is ssh's own failure (refused, unknown host, key not accepted).
        if (code === 255) reject(new Error(`SSH failed: ${lastLine(stderr) || 'exit code 255'}`));
        else resolve({ code: code ?? 1, stdout, stderr });
      });
      child.stdin.on('error', () => {});
      if (input) createReadStream(input).pipe(child.stdin);
      else child.stdin.end();
    });
  };
}

const lastLine = (text: string) => text.trim().replace(/^[^]*\n/, '');
/** The `Error: …` line of an uncaught error in node (it ends with stack and version). */
const errorLine = (text: string) => /^\w*Error: .*$/m.exec(text)?.[0] ?? lastLine(text);

/** A Linux package the app ships (ADR 0041, step 1). */
export interface LinuxPackage {
  arch: 'x64' | 'arm64';
  file: string;
  /** `<version>+<hash>`: the runtime folder on the machine. */
  build: string;
  glibc: string;
}

/** The packages in `dir` (`Resources/linux-server`); none in a build without them. */
export async function linuxPackages(dir: string, version: string): Promise<LinuxPackage[]> {
  const found: LinuxPackage[] = [];
  for (const arch of ['x64', 'arm64'] as const) {
    const file = join(dir, `hangar-server-linux-${arch}.tar.gz`);
    if (!existsSync(file)) continue;
    const requirements = await new Promise<string>((resolve, reject) =>
      execFile('tar', ['-xzOf', file, 'hangar-server/requirements.json'], (e, out) =>
        e ? reject(e) : resolve(out),
      ),
    );
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 8);
    const { glibc } = JSON.parse(requirements) as { glibc: string };
    found.push({ arch, file, build: `${version}+${hash}`, glibc });
  }
  return found;
}

/** What the probe found on the machine. */
export interface Machine {
  system: string;
  arch: string;
  glibc?: string;
  home: string;
  user: string;
  systemd: boolean;
  linger: boolean;
  /** `PATH` of the login shell: the service gets it, it reads no profile. */
  path: string;
  git: boolean;
  runtimes: string[];
}

const PROBE = `
echo "uname=$(uname -sm)"
echo "glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null)"
echo "home=$HOME"
echo "user=$(id -un)"
if systemctl --user show-environment >/dev/null 2>&1; then echo systemd=yes; fi
echo "linger=$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null)"
p=$("\${SHELL:-/bin/sh}" -lc 'printf "\nHANGAR_PATH=%s\n" "$PATH"' </dev/null 2>/dev/null | sed -n 's/^HANGAR_PATH=//p' | tail -n 1)
echo "path=$p"
if PATH="$p" command -v git >/dev/null 2>&1; then echo git=yes; fi
for d in "$HOME/.local/share/hangar/runtime"/*/; do [ -d "$d" ] && echo "runtime=$(basename "$d")"; done
true`;

export async function probeMachine(remote: Remote): Promise<Machine> {
  const { stdout } = await remote(PROBE);
  const lines = stdout.split('\n').map((l) => l.split(/=(.*)/s) as [string, string?]);
  const value = (key: string) => lines.find(([k]) => k === key)?.[1] ?? '';
  const [system = '', arch = ''] = value('uname').split(' ');
  const glibc = /^glibc (\d+\.\d+)/.exec(value('glibc'))?.[1];
  return {
    system,
    arch,
    ...(glibc && { glibc }),
    home: value('home'),
    user: value('user'),
    systemd: value('systemd') === 'yes',
    linger: value('linger') === 'yes',
    path: value('path'),
    git: value('git') === 'yes',
    runtimes: lines.filter(([k]) => k === 'runtime').map(([, v]) => v!),
  };
}

const ARCH: Record<string, LinuxPackage['arch']> = { x86_64: 'x64', aarch64: 'arm64' };
const older = (a: string, b: string) => {
  const [aMajor, aMinor] = a.split('.').map(Number) as [number, number];
  const [bMajor, bMinor] = b.split('.').map(Number) as [number, number];
  return aMajor < bMajor || (aMajor === bMajor && aMinor < bMinor);
};

/** The package for the machine, or why there is none (messages the dialog translates). */
export function choosePackage(machine: Machine, packages: LinuxPackage[]): LinuxPackage {
  if (machine.system !== 'Linux') throw new Error(`Not a Linux machine: ${machine.system}`);
  const arch = ARCH[machine.arch];
  if (!arch) throw new Error(`Unsupported architecture: ${machine.arch}`);
  const pkg = packages.find((p) => p.arch === arch);
  if (!pkg) throw new Error(`No package for ${arch} in this build`);
  if (!machine.glibc) throw new Error('No glibc on the machine');
  if (older(machine.glibc, pkg.glibc))
    throw new Error(`glibc ${machine.glibc} is older than ${pkg.glibc}`);
  if (!machine.systemd) throw new Error('No systemd user services on the machine');
  if (!machine.git) throw new Error('git not found on the machine');
  return pkg;
}

const ROOT = '$HOME/.local/share/hangar';

/** The data folder on the machine, as the unit passes it to the server. */
export const remoteDataDir = (home: string) => `${home}/.local/share/hangar/data`;

/** The unit: the person's user, explicit paths (systemd expands no `~`), private files. */
export function unit(build: string): string {
  const runtime = `%h/.local/share/hangar/runtime/${build}`;
  const data = '%h/.local/share/hangar/data';
  return [
    '[Unit]',
    'Description=Hangar server (set up by the Hangar app, ADR 0041)',
    '',
    '[Service]',
    `ExecStart=${runtime}/node ${runtime}/server/hangar-server.mjs --data ${data} --root %h --bays ${runtime}/bays --cli ${runtime}/cli/hangar.mjs`,
    'EnvironmentFile=%h/.local/share/hangar/server.env',
    'UMask=0077',
    `StandardOutput=append:${data}/server.log`,
    'StandardError=inherit',
    'Restart=always',
    'RestartSec=5',
    // The server closes its sessions on SIGTERM; their state is on disk for the restart.
    'KillMode=mixed',
    'TimeoutStopSec=30',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

const PTY_CHECK =
  "const t = require(process.argv[1] + '/node_modules/node-pty').spawn('/bin/sh', ['-c', 'echo pty-ok'], {});" +
  't.onData((d) => process.stdout.write(d)); t.onExit(() => process.exit(0));';

/** What the setup leaves: where the server listens and how to pair with it. */
export interface SetupResult {
  remoteData: string;
  port: number;
  fingerprint: string;
  code: string;
  linger: boolean;
  /** The person's user name on the machine (for the lingering hint). */
  user: string;
  build: string;
}

/**
 * Sets up the server on the machine (ADR 0041): checks, uploads the package unless that build is
 * there, starts node-pty with it, writes the unit and restarts the service, then reads port, key
 * and pairing code that the server writes.
 */
export async function setUpServer(
  remote: Remote,
  packages: LinuxPackage[],
  waitMs = 30_000,
): Promise<SetupResult> {
  const machine = await probeMachine(remote);
  const pkg = choosePackage(machine, packages);
  const runtime = `${ROOT}/runtime/${pkg.build}`;
  const prepare = `set -e; umask 077; mkdir -p "${ROOT}/runtime" "${ROOT}/data"; chmod 700 "${ROOT}" "${ROOT}/runtime" "${ROOT}/data"`;
  if (machine.runtimes.includes(pkg.build)) await expectOk(remote(prepare), 'Preparing failed');
  else
    await expectOk(
      remote(
        // Its own temp folder: a second setup running at the same time must not delete it.
        `${prepare}; T="${runtime}.tmp.$$"; mkdir "$T"; tar xzf - -C "$T"; [ -d "${runtime}" ] || mv "$T/hangar-server" "${runtime}"; rm -rf "$T"`,
        pkg.file,
      ),
      'Upload failed',
    );
  const pty = await remote(`"${runtime}/node" -e ${quote(PTY_CHECK)} "${runtime}"`);
  if (!pty.stdout.includes('pty-ok'))
    throw new Error(`node-pty does not start on the machine: ${errorLine(pty.stderr)}`);

  // systemd reads `\"` and `\\` in a double-quoted value.
  const env = `PATH="${machine.path.replace(/[\\"]/g, (c) => `\\${c}`)}"\n`;
  await expectOk(
    remote(`set -e; umask 077
mkdir -p "$HOME/.config/systemd/user"
cat > "${ROOT}/server.env" <<'HANGAR_ENV'
${env}HANGAR_ENV
cat > "$HOME/.config/systemd/user/hangar-server.service" <<'HANGAR_UNIT'
${unit(pkg.build)}HANGAR_UNIT
rm -f "${ROOT}/data/pair-code" "${ROOT}/data/listen.json"
systemctl --user daemon-reload
systemctl --user enable hangar-server.service 2>/dev/null
systemctl --user restart hangar-server.service`),
    'Installing the service failed',
  );

  const tries = Math.max(1, Math.round(waitMs / 500));
  const started = await remote(`D="${ROOT}/data"
i=0; while [ $i -lt ${tries} ]; do
  if [ -s "$D/pair-code" ] && [ -s "$D/listen.json" ]; then cat "$D/listen.json"; echo; cat "$D/pair-code"; exit 0; fi
  i=$((i+1)); sleep 0.5
done
tail -n 5 "$D/server.log" 2>/dev/null; exit 3`);
  if (started.code !== 0)
    throw new Error(
      `The server did not start: ${lastLine(started.stdout) || lastLine(started.stderr)}`,
    );
  const [listen = '', code = ''] = started.stdout.trim().split('\n');
  const { port, fingerprint } = JSON.parse(listen) as { port: number; fingerprint: string };
  return {
    remoteData: remoteDataDir(machine.home),
    port,
    fingerprint,
    code: code.trim(),
    linger: machine.linger,
    user: machine.user,
    build: pkg.build,
  };
}

/** Port and key of a server set up on a machine, as it wrote them after listening. */
export async function remoteListen(
  remote: Remote,
  remoteData: string,
): Promise<{ port: number; fingerprint: string }> {
  const { code, stdout } = await remote(`cat ${quote(`${remoteData}/listen.json`)}`);
  if (code !== 0) throw new Error('The server on the machine is not running');
  return JSON.parse(stdout) as { port: number; fingerprint: string };
}

async function expectOk(
  run: Promise<{ code: number; stdout: string; stderr: string }>,
  what: string,
): Promise<void> {
  const { code, stderr } = await run;
  if (code !== 0) throw new Error(`${what}: ${lastLine(stderr) || `exit code ${code}`}`);
}
