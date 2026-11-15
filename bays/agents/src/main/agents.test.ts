import { describe, expect, it } from 'vitest';
import { agentOf, commandAgent, listProcesses, parseProcesses } from './agents';

describe('commandAgent (ADR 0045)', () => {
  it.each([
    ['claude', 'claude'],
    ['/Users/x/.local/bin/claude --resume', 'claude'],
    ['node /Users/x/.local/bin/codex', 'codex'],
    ['/usr/local/bin/node /usr/lib/node_modules/@openai/codex/bin/codex.js exec', 'codex'],
    ['/opt/homebrew/Cellar/opencode/2.2.5/bin/opencode', 'opencode'],
    ['bun /x/opencode.mjs', 'opencode'],
    ['C:\\Tools\\codex.exe', 'codex'],
  ])('%s is %s', (args, agent) => {
    expect(commandAgent(args)).toBe(agent);
  });

  it.each(['-zsh', 'node server.js', 'vim claude.md', 'gemini', 'claudette', ''])(
    'knows no agent in %j',
    (args) => {
      expect(commandAgent(args)).toBeUndefined();
    },
  );
});

describe('agentOf (ADR 0045)', () => {
  const procs = parseProcesses(
    [
      '  1     0 /sbin/launchd',
      ' 10     1 /bin/zsh -l',
      ' 11    10 node /home/x/.local/bin/codex',
      ' 12    11 /home/x/.codex/bin/codex',
      ' 13    12 claude -p review',
      ' 20     1 /bin/zsh -l',
      ' 21    20 vim notes.md',
      ' 30     1 claude daemon run',
    ].join('\n'),
  );

  it('takes the agent closest to the shell', () => {
    expect(agentOf(10, procs)).toBe('codex');
  });

  it('finds none under a shell without an agent, nor processes outside the shell', () => {
    expect(agentOf(20, procs)).toBeUndefined();
    expect(agentOf(99, procs)).toBeUndefined();
  });

  it('finds an agent that replaced the shell (exec claude) (Codex)', () => {
    expect(agentOf(10, parseProcesses(' 10 1 claude'))).toBe('claude');
  });

  it('keeps the agent that replaced the shell when it starts another one (Codex)', () => {
    const table = ' 10 1 codex\n 11 10 bash\n 12 11 claude -p review';
    expect(agentOf(10, parseProcesses(table))).toBe('codex');
  });

  it('skips lines it cannot read', () => {
    expect(parseProcesses('garbage\n\n 5 1 claude')).toEqual([{ pid: 5, ppid: 1, args: 'claude' }]);
  });
});

describe('listProcesses (ADR 0045)', () => {
  it.skipIf(process.platform === 'win32')('reads the process table of this machine', async () => {
    const processes = parseProcesses(await listProcesses());
    expect(processes.find((p) => p.pid === process.pid)?.ppid).toBe(process.ppid);
  });

  it('reads nothing on Windows', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(await listProcesses()).toBe('');
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});
