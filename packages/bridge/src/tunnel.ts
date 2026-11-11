import { execFile, spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';

/** A server reached through `ssh -L`: its bridge listens on `port` on its own loopback. */
export interface SshTarget {
  user?: string;
  host: string;
  port: number;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
// No leading `-`: ssh would read the host or user as an option (`-oProxyCommand=…`).
const NAME = '[A-Za-z0-9_][A-Za-z0-9._-]*';
const SSH_ADDRESS = new RegExp(`^(?:(${NAME})@)?(${NAME}):(\\d+)$`);
const LOOPBACK_ADDRESS = /^(?:ws:\/\/)?(\[::1\]|[^/:@]+):(\d+)(?:\/connect)?$/;

/**
 * `127.0.0.1:7420` (or `ws://…/connect`) connects directly; `[user@]host:port` goes through an
 * SSH tunnel to the port the server listens on there (ADR 0019).
 */
export function parseAddress(address: string): { url: string } | { ssh: SshTarget } {
  const trimmed = address.trim();
  const invalid = new Error(`Invalid address: ${trimmed}`);
  const local = LOOPBACK_ADDRESS.exec(trimmed);
  if (local && LOOPBACK.has(local[1]!)) {
    return { url: `ws://${local[1]}:${validPort(local[2]!, invalid)}/connect` };
  }
  const ssh = SSH_ADDRESS.exec(trimmed);
  if (!ssh) throw invalid;
  const [, user, host, port] = ssh;
  return { ssh: { ...(user && { user }), host: host!, port: validPort(port!, invalid) } };
}

function validPort(port: string, invalid: Error): number {
  const n = Number(port);
  if (n < 1 || n > 65535) throw invalid;
  return n;
}

/**
 * Arguments for `ssh`: forward, no prompts (no terminal to answer them). `cat` on the server
 * ends at the end of stdin, so ssh ends with the desktop, even after a crash (no `-N`).
 */
export function sshArgs(target: SshTarget, localPort: number, stdinNull = false): string[] {
  return [
    '-T',
    ...['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15'],
    // Settings of the user's ssh config that would break the tunnel or detach it from the app:
    // a command of their own, a shared master connection that owns the forward and outlives
    // this process, `StdinNull yes` (stdin is how the tunnel ends with the app). `StdinNull=no`
    // only where ssh knows it: OpenSSH before 8.7 (Windows 10) rejects the option, and there
    // the config cannot set it either.
    ...['-o', 'RemoteCommand=none'],
    ...(stdinNull ? ['-o', 'StdinNull=no'] : []),
    ...['-o', 'ControlMaster=no', '-o', 'ControlPath=none'],
    ...['-L', `127.0.0.1:${localPort}:127.0.0.1:${target.port}`],
    '--',
    target.user ? `${target.user}@${target.host}` : target.host,
    'cat',
  ];
}

/** Whether the output of `ssh -V` names OpenSSH 8.7 or newer, which knows `StdinNull`. */
export function stdinNullSupported(version: string): boolean {
  const m = /OpenSSH_(?:for_Windows_)?(\d+)\.(\d+)/.exec(version);
  return !!m && Number(m[1]) * 100 + Number(m[2]) >= 807;
}

/** `ssh -V` prints to stderr; an ssh that fails or is not OpenSSH yields no version. */
export function sshVersion(ssh: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(ssh, ['-V'], { timeout: 5000 }, (_, stdout, stderr) => resolve(`${stdout}${stderr}`));
  });
}

export interface Tunnel {
  /** Local loopback port that reaches the server. */
  port: number;
  close(): void;
}

const READY_TIMEOUT_MS = 20_000;

/** Starts `ssh -L` and resolves once the local port accepts connections. */
export async function openTunnel(target: SshTarget, ssh = 'ssh'): Promise<Tunnel> {
  const port = await freePort();
  const stdinNull = stdinNullSupported(await sshVersion(ssh));
  const child = spawn(ssh, sshArgs(target, port, stdinNull), { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));
  const failed = new Promise<never>((_, reject) => {
    const fail = (why: string) => reject(new Error(`SSH failed: ${why}`));
    child.on('error', (e) => fail(e.message));
    child.on('exit', (code) => fail(stderr.trim().split('\n').at(-1) || `exit code ${code}`));
  });
  const close = () => void child.kill();
  try {
    await Promise.race([failed, accepts(port)]);
  } catch (e) {
    close();
    throw e;
  }
  return { port, close };
}

// The port may be taken between closing and ssh binding it; ssh then exits
// (ExitOnForwardFailure) and the connection fails with that message. Retry if it ever matters.
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** Polls until the port accepts a connection; ssh prints nothing when the forward is up. */
async function accepts(port: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('SSH failed: tunnel not up after 20 s');
}
