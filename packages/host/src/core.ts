import { join } from 'node:path';
import {
  Bus,
  FilePermissionStore,
  type ActivityEvent,
  type Prompter,
  type RemoteAccess,
} from '@hangar/bus';
import { startMcpServer, TokenRegistry } from '@hangar/mcp';
import { Scheduler } from '@hangar/scheduler';
import { ActivityLog } from './activity-log';
import { FileInboxStore } from './inbox-store';
import type { HostServices } from './bay-runtime';
import { writeCliShim } from './cli-shim';

export interface CoreOptions {
  /** Holds `permissions.json`, `jobs.json`, `bays/` (bay data) and `bin/` (CLI launcher). */
  dataDir: string;
  version: string;
  prompter: Prompter;
  /** Runtime and script the `hangar` launcher starts. */
  cli: { execPath: string; cliPath: string };
  onJobsChanged(): void;
  /** Membership and share lists of the workspaces (ADR 0030); without it no remote call passes. */
  remote?: RemoteAccess;
  /** After each logged workspace call, e.g. a new inbox entry (ADR 0046). */
  onActivity?(event: ActivityEvent): void;
}

/** The parts of `HostServices` that need no window, dialog or tray. */
export type CoreServices = Pick<
  HostServices,
  | 'dataRoot'
  | 'hangarVersion'
  | 'scheduler'
  | 'provide'
  | 'call'
  | 'registerAgentSession'
  | 'unregisterAgentSession'
>;

export interface Core {
  bus: Bus;
  tokens: TokenRegistry;
  scheduler: Scheduler;
  mcpUrl: string;
  services: CoreServices;
  /** Workspace calls in and out (`workspace-log.jsonl`, ADR 0046). */
  activity: ActivityLog;
  /** Logs a call and reports it; the relay's outgoing calls come in here. */
  record(event: ActivityEvent): void;
  /** Stops the scheduler and the MCP server; the caller starts the scheduler. */
  close(): Promise<void>;
}

/** Bus, permissions, MCP server, scheduler and agent sessions, without Electron. */
export async function startCore(options: CoreOptions): Promise<Core> {
  const { dataDir } = options;
  const tokens = new TokenRegistry();
  const activity = new ActivityLog(join(dataDir, 'workspace-log.jsonl'));
  const record = (event: ActivityEvent) => {
    activity.add(event);
    options.onActivity?.(event);
  };
  const bus = new Bus({
    permissions: new FilePermissionStore(join(dataDir, 'permissions.json')),
    prompter: options.prompter,
    ...(options.remote && { remote: options.remote }),
    inbox: new FileInboxStore(join(dataDir, 'inbox.json')),
    onActivity: record,
  });
  const server = await startMcpServer({ bus, tokens, version: options.version });
  const cliDir = join(dataDir, 'bin');
  writeCliShim(cliDir, options.cli.execPath, options.cli.cliPath);
  const scheduler = new Scheduler({
    file: join(dataDir, 'jobs.json'),
    onChange: options.onJobsChanged,
  });
  return {
    bus,
    tokens,
    activity,
    record,
    scheduler,
    mcpUrl: server.url,
    services: {
      dataRoot: join(dataDir, 'bays'),
      hangarVersion: options.version,
      scheduler,
      provide: (bayId, spec, handler) => bus.register(bayId, spec, handler),
      call: (caller, target, args) => bus.call(caller, target, args),
      registerAgentSession: (bayId, sessionId) => {
        bus.startSession(sessionId);
        return { token: tokens.issue(bayId, sessionId), mcpUrl: server.url, cliDir };
      },
      unregisterAgentSession: (_bayId, sessionId) => {
        tokens.revoke(sessionId);
        bus.endSession(sessionId);
      },
    },
    close: async () => {
      scheduler.stop();
      await server.close();
    },
  };
}
