import { spawn } from 'node:child_process';
import { t } from './messages';

/** How to run `command` once with a session's shell, without a terminal (ADR 0014). */
export function shellCommand(
  shell: { file: string; args: string[] },
  command: string,
): { file: string; args: string[]; verbatim: boolean } {
  const name = shell.file.split(/[\\/]/).pop()!.toLowerCase();
  if (name === 'cmd.exe' || name === 'cmd') {
    // as Node's `shell: true`: one quoted argument, passed on unescaped
    return { file: shell.file, args: ['/d', '/s', '/c', `"${command}"`], verbatim: true };
  }
  if (/^(powershell|pwsh)(\.exe)?$/.test(name)) {
    return { file: shell.file, args: ['-NoProfile', '-Command', command], verbatim: false };
  }
  return { file: shell.file, args: [...shell.args, '-c', command], verbatim: false };
}

// eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Last non-empty output line, without colors and overwritten progress. */
function lastLine(output: string): string {
  const lines = output
    .replace(ANSI, '')
    .split('\n')
    .map((l) => l.replace(/\r$/, '').split('\r').pop()!.trim())
    .filter(Boolean);
  return (lines.at(-1) ?? '').slice(0, 200);
}

/** How long a killed run may take to close its output before Hangar closes it. */
const CLOSE_GRACE_MS = 2000;

export interface JobProcess {
  done: Promise<{ exitCode: number; lastLine: string }>;
  kill(): void;
}

/** Starts one job run: empty input, output kept for its last line, stopped after `timeoutMs`. */
export function startJobProcess(options: {
  shell: { file: string; args: string[] };
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}): JobProcess {
  const { file, args, verbatim } = shellCommand(options.shell, options.command);
  const group = process.platform !== 'win32';
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // own process group on POSIX, so a kill reaches the command's children
    detached: group,
    windowsVerbatimArguments: verbatim,
    windowsHide: true,
  });
  let killed = false;
  const kill = () => {
    killed = true;
    // A child the kill missed (taskkill failed, or one that left the group) can hold the output
    // pipes open; `close` waits for them. Closing our ends lets the run end anyway.
    setTimeout(() => {
      child.stdout!.destroy();
      child.stderr!.destroy();
    }, CLOSE_GRACE_MS).unref();
    try {
      if (group && child.pid) process.kill(-child.pid, 'SIGKILL');
      else if (child.pid) {
        // Windows has no process groups: taskkill /T ends the command's children too.
        spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }).on(
          'error',
          () => child.kill(),
        );
      }
    } catch {
      // already gone
    }
  };
  let output = '';
  const collect = (data: Buffer) => void (output = (output + data.toString()).slice(-65_536));
  child.stdout!.on('data', collect);
  child.stderr!.on('data', collect);
  const done = new Promise<{ exitCode: number; lastLine: string }>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(t.jobTimedOut(Math.ceil(options.timeoutMs / 60_000))));
      else if (code === null || killed) reject(new Error(t.jobStopped));
      else resolve({ exitCode: code, lastLine: lastLine(output) });
    });
  });
  return { done, kill };
}
