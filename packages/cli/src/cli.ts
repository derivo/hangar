// The `hangar` command. Dependency-free and erasable TypeScript, so Node can run it directly.
import { parseArgs } from 'node:util';

const BAY = 'dev.hangar.agents';
const STATUSES = ['working', 'waiting', 'background', 'done', 'idle'];
const SEGMENTS = '<key> <value> --type <text|path|bar|badge> [--max <n>]';
const HANDOVER = '"<task>" [--branch <b>] [--context "<text>"] [--project <p>] [--remote <url>]';

const de = {
  usage: `hangar – meldet einer Hangar-Session Status, Beschreibung und Statusleiste

Aufruf:
  hangar status <working|waiting|background|done|idle> [--hook]
  hangar describe "<Text>"
  hangar statusbar set ${SEGMENTS}
  hangar statusline   (statusLine von Claude Code: meldet das 5h-Kontingent)
  hangar handover     (zeigt die Übergabe dieser Session)
  hangar handover create ${HANDOVER}
                      (übergibt Arbeit an eine neue Session)

Optionen:
  -q, --quiet   Fehler verschlucken und immer mit 0 enden (für Claude-Code-Hooks)
  --hook        liest die Eingabe des Hooks: „done“ wird „background“, solange
                eine Hintergrundaufgabe läuft

Braucht HANGAR_MCP_URL und HANGAR_TOKEN, die Hangar in jeder Session-Shell setzt.
`,
  segmentUsage: `Aufruf: hangar statusbar set ${SEGMENTS}`,
  invalidStatus: (statuses: string) => `Status fehlt oder ist ungültig (${statuses})`,
  missingDescription: 'Beschreibung fehlt',
  maxNotANumber: '--max muss eine Zahl sein',
  notInSession: 'Nicht in einer Hangar-Session: HANGAR_MCP_URL und HANGAR_TOKEN fehlen.',
  unreachable: (reason: string) => `Hangar nicht erreichbar: ${reason}`,
  httpError: (status: number, error: string) => `Hangar antwortet mit ${status}: ${error}`,
  toolError: 'Fehler',
  missingTask: 'Auftrag fehlt',
  noHandover: 'Diese Session hat keine Übergabe.',
  handoverFrom: (from: string, remote: boolean) =>
    remote ? `Übergabe von ${from}, einer anderen Instanz` : `Übergabe von ${from}`,
  task: 'Auftrag',
  context: 'Kontext',
  handedOver: (id: string) => `Übergeben an die neue Session ${id}.`,
};

const en: typeof de = {
  usage: `hangar – reports status, description and status bar to a Hangar session

Usage:
  hangar status <working|waiting|background|done|idle> [--hook]
  hangar describe "<text>"
  hangar statusbar set ${SEGMENTS}
  hangar statusline   (Claude Code statusLine: reports the 5-hour limit)
  hangar handover     (shows the handover of this session)
  hangar handover create ${HANDOVER}
                      (hands work over to a new session)

Options:
  -q, --quiet   swallow errors and always exit with 0 (for Claude Code hooks)
  --hook        read the hook's input: "done" becomes "background" while a
                background task runs

Needs HANGAR_MCP_URL and HANGAR_TOKEN, which Hangar sets in every session shell.
`,
  segmentUsage: `Usage: hangar statusbar set ${SEGMENTS}`,
  invalidStatus: (statuses) => `Status is missing or invalid (${statuses})`,
  missingDescription: 'Description is missing',
  maxNotANumber: '--max must be a number',
  notInSession: 'Not in a Hangar session: HANGAR_MCP_URL and HANGAR_TOKEN are missing.',
  unreachable: (reason) => `Hangar is not reachable: ${reason}`,
  httpError: (status, error) => `Hangar answered with ${status}: ${error}`,
  toolError: 'Error',
  missingTask: 'Task is missing',
  noHandover: 'This session has no handover.',
  handoverFrom: (from, remote) =>
    remote ? `Handover from ${from}, another instance` : `Handover from ${from}`,
  task: 'Task',
  context: 'Context',
  handedOver: (id) => `Handed over to the new session ${id}.`,
};
type Messages = typeof de;

/** German if the locale variables ask for it (same order as `setlocale`), otherwise English. */
const messagesFor = (env: Env): Messages =>
  (env.LC_ALL || env.LC_MESSAGES || env.LANG || '').startsWith('de') ? de : en;

export interface Result {
  code: number;
  out: string;
  err: string;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Hooks run synchronously in Claude Code; a hanging Hangar must not hang them. */
export const TIMEOUT_MS = 3000;
type Env = Record<string, string | undefined>;

class UsageError extends Error {}

interface Handover {
  origin: 'local' | 'remote';
  from: string;
  task: string;
  branch?: string;
  remote?: string;
  context?: string;
}

/** A tool call and, for commands that answer, how to print the result. */
interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  print?: (result: unknown) => string;
}

/** Without control characters except newline and tab: the text may come from elsewhere. */
// eslint-disable-next-line no-control-regex -- finds control characters on purpose
const plain = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');

/** The handover as lines a person and an agent can read. */
function printHandover(h: Handover | null, m: Messages): string {
  if (!h) return `${m.noHandover}\n`;
  return plain(handoverLines(h, m));
}

function handoverLines(h: Handover, m: Messages): string {
  const lines = [m.handoverFrom(h.from, h.origin === 'remote'), `${m.task}: ${h.task}`];
  if (h.branch) lines.push(`Branch: ${h.branch}${h.remote ? ` (${h.remote})` : ''}`);
  else if (h.remote) lines.push(`Remote: ${h.remote}`);
  if (h.context) lines.push(`${m.context}: ${h.context}`);
  return `${lines.join('\n')}\n`;
}

/** Reads a hook's input; gives up after `timeoutMs` or on a read error, so a hook never hangs. */
export async function readInput(input: AsyncIterable<unknown>, timeoutMs = 1000): Promise<string> {
  let text = '';
  const read = (async () => {
    for await (const chunk of input) text += String(chunk);
  })().catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)));
  await Promise.race([read, timeout]);
  clearTimeout(timer);
  return text;
}

/** Whether the Stop hook's input names a background task that still runs. */
function backgroundRunning(stdin: string): boolean {
  try {
    const input = JSON.parse(stdin) as { background_tasks?: { status?: unknown }[] };
    return input.background_tasks?.some((t) => t.status === 'running') ?? false;
  } catch {
    return false;
  }
}

/** Maps command-line arguments to a tool call; `readStdin` gives the hook input (`--hook`). */
async function toToolCall(
  argv: string[],
  m: Messages,
  readStdin: () => Promise<string>,
): Promise<ToolCall | 'help'> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      type: { type: 'string' },
      max: { type: 'string' },
      quiet: { type: 'boolean', short: 'q' },
      branch: { type: 'string' },
      context: { type: 'string' },
      project: { type: 'string' },
      remote: { type: 'string' },
      hook: { type: 'boolean' },
    },
  });
  const [command, ...rest] = positionals;
  switch (command) {
    case 'status': {
      const status = rest[0];
      if (!status || !STATUSES.includes(status)) {
        throw new UsageError(m.invalidStatus(STATUSES.join(', ')));
      }
      const background = values.hook && status === 'done' && backgroundRunning(await readStdin());
      return {
        name: `${BAY}/session.setStatus`,
        args: { status: background ? 'background' : status },
      };
    }
    case 'describe': {
      if (rest.length === 0) throw new UsageError(m.missingDescription);
      return { name: `${BAY}/session.setDescription`, args: { description: rest.join(' ') } };
    }
    case 'statusbar': {
      const [sub, key, value] = rest;
      if (sub !== 'set') throw new UsageError(m.usage);
      if (key === undefined || value === undefined || !values.type) {
        throw new UsageError(m.segmentUsage);
      }
      const args: Record<string, unknown> = { key, value, type: values.type };
      if (values.max !== undefined) {
        const max = Number(values.max);
        if (!Number.isFinite(max)) throw new UsageError(m.maxNotANumber);
        args.max = max;
      }
      return { name: `${BAY}/statusbar.set`, args };
    }
    case 'handover': {
      const [sub, ...words] = rest;
      if (sub === undefined)
        return {
          name: `${BAY}/handover.get`,
          args: {},
          print: (result) => printHandover(result as Handover | null, m),
        };
      if (sub !== 'create') throw new UsageError(m.usage);
      if (words.length === 0) throw new UsageError(m.missingTask);
      const { branch, context, project, remote } = values;
      return {
        name: `${BAY}/handover.create`,
        args: {
          task: words.join(' '),
          ...(branch !== undefined && { branch }),
          ...(context !== undefined && { context }),
          ...(project !== undefined && { project }),
          ...(remote !== undefined && { remote }),
        },
        print: (result) => {
          const id = (result as { sessionId?: string } | null)?.sessionId;
          return id ? `${m.handedOver(id.slice(0, 8))}\n` : '';
        },
      };
    }
    case 'help':
      return 'help';
    default:
      throw new UsageError(m.usage);
  }
}

async function callTool(
  env: Env,
  m: Messages,
  fetch: Fetch,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
) {
  const { HANGAR_MCP_URL: url, HANGAR_TOKEN: token } = env;
  if (!url || !token) {
    throw new Error(m.notInSession);
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      // Also covers reading the body below.
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
  } catch (e) {
    throw new Error(m.unreachable((e as Error).message), { cause: e });
  }
  const body = (await response.json()) as {
    error?: string | { message: string };
    result?: { isError?: boolean; content?: { text?: string }[] };
  };
  if (!response.ok) {
    throw new Error(m.httpError(response.status, String(body.error)));
  }
  if (typeof body.error === 'object') throw new Error(body.error.message);
  if (body.result?.isError) throw new Error(body.result.content?.[0]?.text ?? m.toolError);
  const text = body.result?.content?.[0]?.text;
  return text === undefined ? undefined : (JSON.parse(text) as unknown);
}

/** Runs the CLI; never throws. */
export async function run(
  argv: string[],
  env: Env,
  fetch: Fetch,
  timeoutMs = TIMEOUT_MS,
  readStdin = async () => '',
): Promise<Result> {
  const quiet = argv.includes('--quiet') || argv.includes('-q');
  const m = messagesFor(env);
  try {
    const call = await toToolCall(argv, m, readStdin);
    if (call === 'help') return { code: 0, out: m.usage, err: '' };
    const result = await callTool(env, m, fetch, call.name, call.args, timeoutMs);
    return { code: 0, out: call.print?.(result) ?? '', err: '' };
  } catch (e) {
    if (quiet) return { code: 0, out: '', err: '' };
    // Exit code 1, never 2: Claude Code treats 2 from a hook as "block".
    return { code: 1, out: '', err: `${(e as Error).message}\n` };
  }
}

/** Reporting from the statusline must not delay Claude Code's status line noticeably. */
export const STATUSLINE_TIMEOUT_MS = 1000;

export interface StatuslineDeps {
  fetch: Fetch;
  home: string;
  /** Throws if the file cannot be read. */
  readFile(path: string): string;
  /** Runs a shell command with `stdin` in `cwd` and resolves with its stdout. */
  exec(command: string, stdin: string, cwd: string): Promise<string>;
}

type StatuslineInput = {
  cwd?: string;
  workspace?: { current_dir?: string; project_dir?: string };
  rate_limits?: Record<string, { used_percentage?: unknown; resets_at?: unknown } | undefined>;
};

function parseInput(stdin: string): StatuslineInput {
  try {
    const parsed: unknown = JSON.parse(stdin);
    return parsed && typeof parsed === 'object' ? (parsed as StatuslineInput) : {};
  } catch {
    return {};
  }
}

function quotaWindow(limit: { used_percentage?: unknown; resets_at?: unknown } | undefined) {
  if (typeof limit?.used_percentage !== 'number') return undefined;
  return {
    usedPercent: limit.used_percentage,
    ...(typeof limit.resets_at === 'number' && { resetsAt: limit.resets_at }),
  };
}

/** The person's own statusLine command: project settings first, then user settings. */
function ownStatusline(cwd: string, env: Env, deps: StatuslineDeps): string | undefined {
  const user = env.CLAUDE_CONFIG_DIR || `${deps.home}/.claude`;
  for (const file of [`${cwd}/.claude/settings.json`, `${user}/settings.json`]) {
    let command: unknown;
    try {
      command = (JSON.parse(deps.readFile(file)) as { statusLine?: { command?: unknown } })
        .statusLine?.command;
    } catch {
      continue;
    }
    // Hangar's own entry would call itself forever.
    if (typeof command === 'string' && command.trim() && !command.startsWith('hangar ')) {
      return command;
    }
  }
  return undefined;
}

/**
 * `hangar statusline` (ADR 0024): reports Claude Code's 5-hour limit to the agent bay and
 * prints what the person's own statusline prints for the same input. Never throws.
 */
export async function statusline(stdin: string, env: Env, deps: StatuslineDeps): Promise<string> {
  const input = parseInput(stdin);
  const cwd = input.workspace?.current_dir || input.cwd || '.';
  // Claude Code reads project settings from where it started, not from a later `cd`.
  const project = input.workspace?.project_dir || cwd;
  const week = quotaWindow(input.rate_limits?.seven_day);
  // A window Claude Code leaves out has not started yet (or just reset): nothing used.
  const five = quotaWindow(input.rate_limits?.five_hour) ?? (week && { usedPercent: 0 });
  const report = five
    ? callTool(
        env,
        messagesFor(env),
        deps.fetch,
        `${BAY}/quota.report`,
        { provider: 'claude', ...five, ...(week && { week }) },
        STATUSLINE_TIMEOUT_MS,
      ).catch(() => {})
    : undefined;
  // Set for the person's statusline: if that calls Hangar again, it runs nothing further.
  const command = env.HANGAR_STATUSLINE ? undefined : ownStatusline(project, env, deps);
  const out = command ? deps.exec(command, stdin, cwd).catch(() => '') : '';
  const [, text] = await Promise.all([report, out]);
  return text;
}
