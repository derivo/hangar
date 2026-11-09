import { join } from 'node:path';
import { Bus, FilePermissionStore, type Prompter, type RemoteAccess } from '@hangar/bus';
import { startMcpServer, TokenRegistry } from '@hangar/mcp';
import { Scheduler } from '@hangar/scheduler';
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
  /** Stops the scheduler and the MCP server; the caller starts the scheduler. */
  close(): Promise<void>;
}

/** Bus, permissions, MCP server, scheduler and agent sessions, without Electron. */
export async function startCore(options: CoreOptions): Promise<Core> {
  const { dataDir } = options;
  const tokens = new TokenRegistry();
  const bus = new Bus({
    permissions: new FilePermissionStore(join(dataDir, 'permissions.json')),
    prompter: options.prompter,
    ...(options.remote && { remote: options.remote }),
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
