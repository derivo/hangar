import { describe, expect, it, vi } from 'vitest';
import { readInput, run, statusline, type StatuslineDeps } from './cli';

const env = {
  HANGAR_MCP_URL: 'http://127.0.0.1:9/mcp',
  HANGAR_TOKEN: 'secret',
  LANG: 'de_DE.UTF-8',
};
const USAGE = 'hangar – meldet einer Hangar-Session Status, Beschreibung und Statusleiste';

function fakeFetch(result: unknown = { content: [{ type: 'text', text: '{"ok":true}' }] }) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json({ jsonrpc: '2.0', id: 1, result }),
  );
}

describe('hangar CLI', () => {
  it('reads the hook input, but gives up on an open or failing input (Codex review)', async () => {
    async function* chunks() {
      yield Buffer.from('{"a"');
      yield ':1}';
    }
    expect(await readInput(chunks())).toBe('{"a":1}');
    async function* open() {
      yield '{"partial"';
      await new Promise(() => {});
    }
    expect(await readInput(open(), 10)).toBe('{"partial"');
    const failing = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('EIO')) }),
    };
    expect(await readInput(failing)).toBe('');
  });

  it('reports background instead of done while a background task of the Stop hook runs', async () => {
    const status = async (stdin: string, argv = ['--quiet', 'status', 'done', '--hook']) => {
      const fetch = fakeFetch();
      await run(argv, env, fetch, undefined, async () => stdin);
      return JSON.parse(String(fetch.mock.calls[0]![1]!.body)).params.arguments.status;
    };
    const running = JSON.stringify({
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'b1', type: 'shell', status: 'running', command: 'gh pr checks' }],
    });
    expect(await status(running)).toBe('background');
    const finished = JSON.stringify({ background_tasks: [{ id: 'b1', status: 'completed' }] });
    expect(await status(finished)).toBe('done');
    expect(await status(JSON.stringify({ background_tasks: [] }))).toBe('done');
    expect(await status('not json')).toBe('done');
    expect(await status('')).toBe('done');
    // Without --hook the input is not read.
    expect(await status(running, ['status', 'done'])).toBe('done');
    // Without a reader there is no input.
    const fetch = fakeFetch();
    await run(['status', 'done', '--hook'], env, fetch);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body)).params.arguments.status).toBe('done');
  });

  it.each([
    [['status', 'waiting'], 'dev.hangar.agents/session.setStatus', { status: 'waiting' }],
    [
      ['describe', 'Login reparieren'],
      'dev.hangar.agents/session.setDescription',
      {
        description: 'Login reparieren',
      },
    ],
    [
      ['statusbar', 'set', 'tokens', '1200', '--type', 'bar', '--max', '5000'],
      'dev.hangar.agents/statusbar.set',
      { key: 'tokens', value: '1200', type: 'bar', max: 5000 },
    ],
    [
      ['statusbar', 'set', 'model', 'opus', '--type', 'badge'],
      'dev.hangar.agents/statusbar.set',
      { key: 'model', value: 'opus', type: 'badge' },
    ],
    [
      ['handover', 'create', 'Tests', 'schreiben', '--branch', 'hangar/1a2b', '--context', 'steht'],
      'dev.hangar.agents/handover.create',
      { task: 'Tests schreiben', branch: 'hangar/1a2b', context: 'steht' },
    ],
    [
      ['handover', 'create', 'Review', '--project', 'shop', '--remote', 'git@x:y.git'],
      'dev.hangar.agents/handover.create',
      { task: 'Review', project: 'shop', remote: 'git@x:y.git' },
    ],
  ])('hangar %j calls %s', async (argv, tool, args) => {
    const fetch = fakeFetch();
    expect(await run(argv, env, fetch)).toEqual({ code: 0, out: '', err: '' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(env.HANGAR_MCP_URL);
    expect(init!.headers).toMatchObject({
      authorization: 'Bearer secret',
      accept: 'application/json, text/event-stream',
    });
    expect(JSON.parse(init!.body as string)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    });
  });

  it.each([
    [[], USAGE],
    [['help'], USAGE],
    [['status'], 'Status fehlt oder ist ungültig (working, waiting, background, done, idle)'],
    [
      ['status', 'busy'],
      'Status fehlt oder ist ungültig (working, waiting, background, done, idle)',
    ],
    [['describe'], 'Beschreibung fehlt'],
    [
      ['statusbar', 'set', 'k'],
      'Aufruf: hangar statusbar set <key> <value> --type <text|path|bar|badge> [--max <n>]',
    ],
    [
      ['statusbar', 'set', 'k', 'v'],
      'Aufruf: hangar statusbar set <key> <value> --type <text|path|bar|badge> [--max <n>]',
    ],
    [['statusbar', 'set', 'k', '5', '--type', 'bar', '--max', 'x'], '--max muss eine Zahl sein'],
    [['statusbar', 'nope'], USAGE],
    [['handover', 'create'], 'Auftrag fehlt'],
    [['handover', 'nope'], USAGE],
    [['fly'], USAGE],
    [['--wat'], "Unknown option '--wat'"],
  ])('rejects %j with exit 1', async (argv, message) => {
    const fetch = fakeFetch();
    const result = await run(argv, env, fetch);
    expect(result.code).toBe(argv[0] === 'help' ? 0 : 1);
    expect(result.err + result.out).toContain(message);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('hangar handover prints the handover of the own session (ADR 0031)', async () => {
    const handover = {
      origin: 'remote',
      from: 'Anna (team)',
      task: 'Review des Login-Branches',
      branch: 'feature/login',
      remote: 'git@github.com:anna/shop.git',
      context: 'Formular steht.',
      at: '2026-11-02T10:00:00.000Z',
    };
    const fetch = fakeFetch({ content: [{ type: 'text', text: JSON.stringify(handover) }] });
    expect(await run(['handover'], env, fetch)).toEqual({
      code: 0,
      out: [
        'Übergabe von Anna (team), einer anderen Instanz',
        'Auftrag: Review des Login-Branches',
        'Branch: feature/login (git@github.com:anna/shop.git)',
        'Kontext: Formular steht.',
        '',
      ].join('\n'),
      err: '',
    });
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).params).toEqual({
      name: 'dev.hangar.agents/handover.get',
      arguments: {},
    });
    const local = { origin: 'local', from: 'Login bauen', task: 'Tests', at: handover.at };
    const plain = fakeFetch({ content: [{ type: 'text', text: JSON.stringify(local) }] });
    expect((await run(['handover'], { ...env, LANG: 'C' }, plain)).out).toBe(
      'Handover from Login bauen\nTask: Tests\n',
    );
    const onlyRemote = { ...local, origin: 'remote', remote: 'https://example.invalid/r.git' };
    const remoteOnly = fakeFetch({ content: [{ type: 'text', text: JSON.stringify(onlyRemote) }] });
    expect((await run(['handover'], { ...env, LANG: 'C' }, remoteOnly)).out).toBe(
      'Handover from Login bauen, another instance\nTask: Tests\nRemote: https://example.invalid/r.git\n',
    );
    // Control characters from the other side never reach the terminal.
    const escape = { ...local, from: 'Eve\u001b]52;c;ZXZpbA==\u0007', task: 'a\u001b[2Jb\nc\td' };
    const escaped = fakeFetch({ content: [{ type: 'text', text: JSON.stringify(escape) }] });
    expect((await run(['handover'], { ...env, LANG: 'C' }, escaped)).out).toBe(
      'Handover from Eve]52;c;ZXZpbA==\nTask: a[2Jb\nc\td\n',
    );
    const branched = { ...local, branch: 'hangar/1a2b' };
    const ownBranch = fakeFetch({ content: [{ type: 'text', text: JSON.stringify(branched) }] });
    expect((await run(['handover'], env, ownBranch)).out).toBe(
      'Übergabe von Login bauen\nAuftrag: Tests\nBranch: hangar/1a2b\n',
    );
    // A tool answer without content prints nothing.
    expect(await run(['status', 'done'], env, fakeFetch({}))).toEqual({
      code: 0,
      out: '',
      err: '',
    });
    const none = fakeFetch({ content: [{ type: 'text', text: 'null' }] });
    expect((await run(['handover'], env, none)).out).toBe('Diese Session hat keine Übergabe.\n');
    const created = fakeFetch({ content: [{ type: 'text', text: '{"sessionId":"1a2b3c4d-x"}' }] });
    expect((await run(['handover', 'create', 'x'], env, created)).out).toBe(
      'Übergeben an die neue Session 1a2b3c4d.\n',
    );
  });

  it('explains when it runs outside a Hangar session', async () => {
    expect(await run(['status', 'done'], { LANG: 'de_DE.UTF-8' }, fakeFetch())).toEqual({
      code: 1,
      out: '',
      err: 'Nicht in einer Hangar-Session: HANGAR_MCP_URL und HANGAR_TOKEN fehlen.\n',
    });
  });

  it('reports tool errors, JSON-RPC errors and HTTP errors', async () => {
    const toolError = fakeFetch({
      isError: true,
      content: [{ type: 'text', text: 'Unbekannte Session' }],
    });
    expect(await run(['status', 'done'], env, toolError)).toEqual({
      code: 1,
      out: '',
      err: 'Unbekannte Session\n',
    });
    const rpcError = vi.fn(async () =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: 'Method not found' },
      }),
    );
    expect((await run(['status', 'done'], env, rpcError)).err).toBe('Method not found\n');
    const http = vi.fn(async () =>
      Response.json({ error: 'Invalid or missing token' }, { status: 401 }),
    );
    expect((await run(['status', 'done'], env, http)).err).toBe(
      'Hangar antwortet mit 401: Invalid or missing token\n',
    );
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect((await run(['status', 'done'], env, down)).err).toBe(
      'Hangar nicht erreichbar: fetch failed\n',
    );
  });

  it('gives up when Hangar accepts the connection but never answers', async () => {
    const hanging = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason)),
        ),
    );
    const result = await run(['status', 'done'], env, hanging, 20);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^Hangar nicht erreichbar: /);
    expect(hanging.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });

  it('speaks English unless LC_ALL, LC_MESSAGES or LANG ask for German', async () => {
    const outside = (e: Record<string, string>) => run(['status', 'done'], e, fakeFetch());
    const english = 'Not in a Hangar session: HANGAR_MCP_URL and HANGAR_TOKEN are missing.\n';
    const german = 'Nicht in einer Hangar-Session: HANGAR_MCP_URL und HANGAR_TOKEN fehlen.\n';
    expect((await outside({})).err).toBe(english);
    expect((await outside({ LANG: 'C' })).err).toBe(english);
    expect((await outside({ LANG: 'de_AT.UTF-8', LC_ALL: 'en_US.UTF-8' })).err).toBe(english);
    expect((await outside({ LANG: 'en_US.UTF-8', LC_MESSAGES: 'de_DE' })).err).toBe(german);
    const en = { ...env, LANG: 'en_US.UTF-8' };
    expect((await run(['status'], en, fakeFetch())).err).toBe(
      'Status is missing or invalid (working, waiting, background, done, idle)\n',
    );
    expect((await run(['describe'], en, fakeFetch())).err).toBe('Description is missing\n');
    expect((await run(['statusbar', 'set', 'k'], en, fakeFetch())).err).toBe(
      'Usage: hangar statusbar set <key> <value> --type <text|path|bar|badge> [--max <n>]\n',
    );
    expect(
      (await run(['statusbar', 'set', 'k', '5', '--type', 'bar', '--max', 'x'], en, fakeFetch()))
        .err,
    ).toBe('--max must be a number\n');
    const http = vi.fn(async () => Response.json({ error: 'nope' }, { status: 500 }));
    expect((await run(['status', 'done'], en, http)).err).toBe('Hangar answered with 500: nope\n');
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect((await run(['status', 'done'], en, down)).err).toBe(
      'Hangar is not reachable: fetch failed\n',
    );
    expect((await run(['help'], {}, fakeFetch())).out).toContain(
      'hangar – reports status, description and status bar to a Hangar session',
    );
  });

  it('--quiet never fails (for Claude Code hooks)', async () => {
    expect(await run(['--quiet', 'status', 'done'], {}, fakeFetch())).toEqual({
      code: 0,
      out: '',
      err: '',
    });
    expect(await run(['-q', 'fly'], env, fakeFetch())).toEqual({ code: 0, out: '', err: '' });
  });
});

describe('hangar statusline (ADR 0024)', () => {
  const input = JSON.stringify({
    workspace: { current_dir: '/wt' },
    rate_limits: { five_hour: { used_percentage: 6, resets_at: 1_793_300_000 } },
  });
  const deps = (files: Record<string, unknown>, fetch = fakeFetch()) => {
    const d: StatuslineDeps = {
      fetch,
      home: '/home/p',
      readFile: vi.fn((path: string) => {
        if (!(path in files)) throw new Error('ENOENT');
        return JSON.stringify(files[path]);
      }),
      exec: vi.fn(async (command: string, stdin: string) => `${command} <${stdin.length}>`),
    };
    return d;
  };
  const line = (command: string) => ({ statusLine: { type: 'command', command } });

  it('reports the 5-hour limit and passes stdin to the statusline of the person', async () => {
    const d = deps({ '/home/p/.claude/settings.json': line('node ~/line.js') });
    expect(await statusline(input, env, d)).toBe(`node ~/line.js <${input.length}>`);
    expect(d.exec).toHaveBeenCalledWith('node ~/line.js', input, '/wt');
    const [, init] = (d.fetch as ReturnType<typeof fakeFetch>).mock.calls[0]!;
    expect(JSON.parse(init!.body as string).params).toEqual({
      name: 'dev.hangar.agents/quota.report',
      arguments: { provider: 'claude', usedPercent: 6, resetsAt: 1_793_300_000 },
    });
  });

  it('also reports the weekly limit, if Claude Code passes one', async () => {
    const d = deps({});
    const withWeek = JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 6 },
        seven_day: { used_percentage: 15, resets_at: 1_793_800_000 },
      },
    });
    await statusline(withWeek, env, d);
    const [, init] = (d.fetch as ReturnType<typeof fakeFetch>).mock.calls[0]!;
    expect(JSON.parse(init!.body as string).params.arguments).toEqual({
      provider: 'claude',
      usedPercent: 6,
      week: { usedPercent: 15, resetsAt: 1_793_800_000 },
    });
    // Claude Code leaves out a window that has not started yet: 5 hours count as unused.
    const weekOnly = deps({});
    await statusline(
      JSON.stringify({ rate_limits: { seven_day: { used_percentage: 15 } } }),
      env,
      weekOnly,
    );
    const [, only] = (weekOnly.fetch as ReturnType<typeof fakeFetch>).mock.calls[0]!;
    expect(JSON.parse(only!.body as string).params.arguments).toEqual({
      provider: 'claude',
      usedPercent: 0,
      week: { usedPercent: 15 },
    });
  });

  it('prefers the project settings, honours CLAUDE_CONFIG_DIR and never calls itself', async () => {
    const project = deps({
      '/wt/.claude/settings.json': line('project-line'),
      '/home/p/.claude/settings.json': line('user-line'),
    });
    expect(await statusline(input, env, project)).toMatch(/^project-line/);
    const custom = deps({ '/cfg/settings.json': line('custom-line') });
    expect(await statusline(input, { ...env, CLAUDE_CONFIG_DIR: '/cfg' }, custom)).toMatch(
      /^custom-line/,
    );
    const loop = deps({
      '/wt/.claude/settings.json': line('hangar statusline'),
      '/home/p/.claude/settings.json': line('user-line'),
    });
    expect(await statusline(input, env, loop)).toMatch(/^user-line/);
    expect(await statusline(input, env, deps({}))).toBe('');
  });

  it('reads settings from the project, runs in the current folder, never nests', async () => {
    const nested = JSON.stringify({ workspace: { current_dir: '/p/sub', project_dir: '/p' } });
    const d = deps({ '/p/.claude/settings.json': line('project-line') });
    expect(await statusline(nested, env, d)).toMatch(/^project-line/);
    expect(d.exec).toHaveBeenCalledWith('project-line', nested, '/p/sub');
    // A statusline that calls Hangar again (`env hangar …`, an absolute path) runs nothing.
    const inner = deps({ '/p/.claude/settings.json': line('project-line') });
    expect(await statusline(nested, { ...env, HANGAR_STATUSLINE: '1' }, inner)).toBe('');
    expect(inner.exec).not.toHaveBeenCalled();
  });

  it('prints the statusline of the person even when nothing can be reported', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const user = { '/home/p/.claude/settings.json': line('user-line') };
    expect(await statusline(input, env, deps(user, down))).toMatch(/^user-line/);
    const noLimit = deps(user);
    expect(await statusline('{"cwd":"/x"}', env, noLimit)).toMatch(/^user-line/);
    expect(noLimit.exec).toHaveBeenCalledWith('user-line', '{"cwd":"/x"}', '/x');
    expect(noLimit.fetch).not.toHaveBeenCalled();
    const broken = deps(user);
    expect(await statusline('kein json', env, broken)).toMatch(/^user-line/);
    const failing = deps(user);
    failing.exec = vi.fn(async () => {
      throw new Error('exit 1');
    });
    expect(await statusline(input, env, failing)).toBe('');
  });
});
