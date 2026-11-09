import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { t } from './messages';

/** Files Hangar writes into every worktree; excluded from git via info/exclude. */
export const AGENT_CONFIG_FILES = ['.mcp.json', '.claude/settings.local.json'];

/** Claude Code expands ${VAR} from the session shell's environment. */
const MCP_SERVER = {
  type: 'http',
  url: '${HANGAR_MCP_URL}',
  headers: { Authorization: 'Bearer ${HANGAR_TOKEN}' },
};

/** Reports Claude Code's 5-hour limit, then runs the person's own statusline (ADR 0024). */
const STATUS_LINE = { type: 'command', command: 'hangar statusline' };

/** Hook event → status reported through the CLI. `--quiet` never blocks Claude Code. */
export const HOOK_STATUS: Record<string, string> = {
  UserPromptSubmit: 'working',
  Notification: 'waiting',
  Stop: 'done',
};

/**
 * Notification types that need the person. `idle_prompt` comes about 60 s after a reply,
 * also while the agent waits on CI in the background, so it is not "waiting for input".
 */
const WAITING_NOTIFICATIONS = [
  'permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
];

type Json = Record<string, unknown>;
interface HookGroup {
  matcher?: string;
  hooks: { type: string; command: string }[];
}

function readJson(file: string): Json {
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Json) : {};
  } catch {
    return {};
  }
}

/**
 * A repository may contain these paths as symbolic links; writing through them would
 * change files outside the worktree. Refuse instead.
 */
function assertNoSymlink(worktree: string, relative: string): void {
  let path = worktree;
  for (const part of relative.split('/')) {
    path = join(path, part);
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
      const shown = relative.slice(0, relative.indexOf(part) + part.length);
      throw new Error(t.symlink(shown));
    }
  }
}

function writeJson(file: string, value: Json): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const isHangarHook = (hook: { command?: string }) => hook.command?.startsWith('hangar ') ?? false;

/** Removes Hangar's own hooks; other hooks in the same group stay, empty groups go. */
function withoutHangarHooks(groups: HookGroup[]): HookGroup[] {
  return groups
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isHangarHook(h)) }))
    .filter((g) => g.hooks.length > 0);
}

/**
 * Writes the MCP configuration and the status hooks for Claude Code into a worktree.
 * Existing settings are kept; Hangar's own entries are replaced, so this is idempotent.
 */
export function writeAgentConfig(worktree: string): void {
  for (const file of AGENT_CONFIG_FILES) assertNoSymlink(worktree, file);
  const mcpFile = join(worktree, '.mcp.json');
  const mcp = readJson(mcpFile);
  writeJson(mcpFile, {
    ...mcp,
    mcpServers: { ...(mcp.mcpServers as Json | undefined), hangar: MCP_SERVER },
  });

  const settingsFile = join(worktree, '.claude', 'settings.local.json');
  const settings = readJson(settingsFile);
  const enabled = (settings.enabledMcpjsonServers as string[] | undefined) ?? [];
  const hooks = { ...(settings.hooks as Record<string, HookGroup[]> | undefined) };
  for (const [event, status] of Object.entries(HOOK_STATUS)) {
    // The Stop hook's input names running background tasks: `done` then becomes `background`.
    const hook = {
      type: 'command',
      command: `hangar --quiet status ${status}${event === 'Stop' ? ' --hook' : ''}`,
    };
    const matchers = event === 'Notification' ? WAITING_NOTIFICATIONS : [undefined];
    hooks[event] = [
      ...withoutHangarHooks(hooks[event] ?? []),
      ...matchers.map((matcher) => ({ ...(matcher && { matcher }), hooks: [hook] })),
    ];
  }
  writeJson(settingsFile, {
    ...settings,
    enabledMcpjsonServers: enabled.includes('hangar') ? enabled : [...enabled, 'hangar'],
    hooks,
    // A statusline set here by the person wins; that session then reports no limit.
    statusLine: (settings.statusLine as Json | undefined) ?? STATUS_LINE,
  });
}
