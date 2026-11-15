import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** AI agents the bay recognises in a session's shell (ADR 0045). */
export const AGENT_KINDS = ['claude', 'codex', 'opencode'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export interface ProcessInfo {
  pid: number;
  ppid: number;
  args: string;
}

/** Runtimes that start an agent written as a script; the script names the agent. */
const RUNTIMES = new Set(['node', 'bun', 'deno']);

const commandName = (path: string) =>
  (path.split(/[\\/]/).at(-1) ?? '').replace(/\.(m?js|cjs|exe)$/i, '');

/** The agent a command line starts: its program, or the script a runtime runs. */
export function commandAgent(args: string): AgentKind | undefined {
  // shortcut: splits at spaces, so a path with spaces is not recognised; agents rarely sit there.
  const [program = '', script = ''] = args.trim().split(/\s+/);
  const name = commandName(RUNTIMES.has(commandName(program)) ? script : program);
  return (AGENT_KINDS as readonly string[]).includes(name) ? (name as AgentKind) : undefined;
}

/** Lines of `ps -A -o pid=,ppid=,args=`. */
export function parseProcesses(table: string): ProcessInfo[] {
  return table.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), args: m[3]! }] : [];
  });
}

/** The shell itself if an agent replaced it (exec), else the agent closest to it below. */
export function agentOf(shellPid: number, processes: ProcessInfo[]): AgentKind | undefined {
  // `exec codex` replaces the shell under its pid; agents it starts stay below it (Codex).
  const shell = processes.find((p) => p.pid === shellPid);
  const own = shell && commandAgent(shell.args);
  if (own) return own;
  let level = [shellPid];
  while (level.length > 0) {
    const children = processes.filter((p) => level.includes(p.ppid));
    for (const child of children) {
      const agent = commandAgent(child.args);
      if (agent) return agent;
    }
    level = children.map((p) => p.pid);
  }
  return undefined;
}

const run = promisify(execFile);

/** The process table; empty on Windows, which has no `ps` (no agent shown there). */
export async function listProcesses(): Promise<string> {
  if (process.platform === 'win32') return '';
  return (await run('ps', ['-A', '-o', 'pid=,ppid=,args='], { maxBuffer: 16 * 1024 * 1024 }))
    .stdout;
}
