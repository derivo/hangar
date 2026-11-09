import { z } from 'zod';
import type { BayContext, CallInfo } from '@hangar/sdk';
import type { SessionJobs } from './jobs';
import type { QuotaTracker } from './quota';
import type { SessionManager } from './sessions';
import { SESSION_STATUSES } from './status';

const SetDescription = z.object({ description: z.string().max(200) });
const SetStatus = z.object({ status: z.enum(SESSION_STATUSES) });
const SegmentKey = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,40}$/, '1–40 characters from A-Z, a-z, 0-9, _ . -');
const SetSegment = z
  .object({
    key: SegmentKey,
    value: z.union([z.string(), z.number()]).transform(String).pipe(z.string().max(200)),
    type: z.enum(['text', 'path', 'bar', 'badge']),
    max: z.number().positive().optional(),
  })
  .refine((s) => s.type !== 'bar' || (s.max !== undefined && Number.isFinite(Number(s.value))), {
    message: 'type bar needs max and a numeric value',
  });
const RemoveSegment = z.object({ key: SegmentKey });
const QuotaWindow = z.object({
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.number().positive().optional(),
});
const ReportQuota = QuotaWindow.extend({
  // Codex is read from its logs; only Claude Code reports, through `hangar statusline`.
  provider: z.literal('claude'),
  week: QuotaWindow.optional(),
});
// A branch name git cannot read as an option or a range (ADR 0031).
const BranchName = z
  .string()
  .regex(/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/, 'a branch name')
  .refine((b) => !b.endsWith('/') && !b.endsWith('.lock'), 'a branch name');
// Only https and ssh: `file://` would read local repositories, `ext::` runs commands.
const GitRemote = z
  .string()
  .regex(/^(https:\/\/|ssh:\/\/|git@)[^\s]{1,500}$/, 'an https or ssh Git URL');
// Shown in another session and printed in its terminal: no escape sequences (ADR 0031).
const Text = (max: number) =>
  z
    .string()
    .max(max)
    // eslint-disable-next-line no-control-regex -- finds control characters on purpose
    .regex(/^[^\u0000-\u0008\u000b-\u001f\u007f-\u009f]*$/, 'no control characters');
const CreateHandover = z.object({
  task: Text(2000).trim().min(1),
  context: Text(4000).optional(),
  project: z.string().max(200).optional(),
  branch: BranchName.optional(),
  remote: GitRemote.optional(),
});
const SessionInfo = z.object({ sessionId: z.string().min(1) });
const AddJob = z.object({
  command: z.string().trim().min(1).max(1000),
  schedule: z.string().max(100),
});

/** Functions are for agents: the session is always the caller's own session. */
function ownSession(info: CallInfo): string {
  if (info.caller.kind !== 'session') throw new Error('Only callable from an agent session');
  return info.caller.sessionId;
}

function parse<T extends z.ZodType>(schema: T, args: unknown): z.output<T> {
  const result = schema.safeParse(args);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new Error(`Invalid arguments: ${issue.path.join('.') || 'args'}: ${issue.message}`);
  }
  return result.data;
}

const schema = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input' }) as Record<string, unknown>;

/** Registers the agent bay's bus functions (manifest `functions`). */
export function provideFunctions(
  ctx: BayContext,
  manager: SessionManager,
  jobs: SessionJobs,
  quotas: QuotaTracker,
): void {
  ctx.provide(
    'session.setDescription',
    (args, info) => {
      manager.update(ownSession(info), parse(SetDescription, args));
      return { ok: true };
    },
    schema(SetDescription),
  );
  ctx.provide(
    'session.setStatus',
    (args, info) => {
      manager.setStatus(ownSession(info), parse(SetStatus, args).status);
      return { ok: true };
    },
    schema(SetStatus),
  );
  ctx.provide(
    'statusbar.set',
    (args, info) => {
      const { max, ...segment } = parse(SetSegment, args);
      manager.setSegment(ownSession(info), max === undefined ? segment : { ...segment, max });
      return { ok: true };
    },
    schema(SetSegment),
  );
  ctx.provide(
    'statusbar.remove',
    (args, info) => {
      manager.removeSegment(ownSession(info), parse(RemoveSegment, args).key);
      return { ok: true };
    },
    schema(RemoveSegment),
  );
  ctx.provide(
    'job.add',
    (args, info) => {
      const sessionId = ownSession(info);
      const { command, schedule } = parse(AddJob, args);
      const job = jobs.add(sessionId, command, schedule);
      return { id: job.id, nextRun: jobs.of(sessionId).find((j) => j.id === job.id)!.nextRun };
    },
    schema(AddJob),
  );
  ctx.provide('job.list', (_args, info) =>
    jobs.of(ownSession(info)).map((j) => ({
      id: j.id,
      command: j.label,
      schedule: j.schedule,
      paused: j.paused,
      nextRun: j.nextRun,
      ...(j.lastRun && { lastRun: j.lastRun }),
    })),
  );
  ctx.provide(
    'handover.create',
    async (args, info) => {
      const { project: name, ...handover } = parse(CreateHandover, args);
      const { projects, sessions } = manager.view();
      const at = new Date().toISOString();
      const { caller } = info;
      /** The one project of that name; two of one name would depend on the tree order. */
      const named = (shared: boolean) => {
        const [found, other] = projects.filter(
          (p) => p.name === name && (!shared || p.shared === true),
        );
        if (other) throw new Error('Project name is ambiguous');
        return found;
      };
      if (caller.kind === 'session') {
        const sender = sessions.find((s) => s.id === caller.sessionId)!;
        const own = projects.find((p) => p.id === sender.projectId);
        // Its own project's name means its own project, even when another carries it too.
        const project = name === undefined || name === own?.name ? own : named(false);
        if (!project) throw new Error('No such project');
        const from = sender.description || sender.branch || project.name;
        const target = await manager.handover(
          project.id,
          { origin: 'local', from, ...handover, at },
          handover.branch,
        );
        return { sessionId: target.id };
      }
      if (caller.kind === 'remote') {
        // Only into a project the person shared; nothing of the other side is fetched.
        const project = named(true);
        if (!project) throw new Error('No such shared project');
        const instance =
          ctx.workspaces?.states().find((s) => s.instance === caller.instance)?.name ??
          caller.instance.slice(0, 16);
        const from = `${instance} (${caller.workspace})`;
        await manager.handover(project.id, { origin: 'remote', from, ...handover, at });
        return { ok: true };
      }
      throw new Error('Only callable from an agent session or another instance');
    },
    schema(CreateHandover),
  );
  ctx.provide('handover.get', async (_args, info) => {
    const id = ownSession(info);
    return manager.view().sessions.find((s) => s.id === id)?.handover ?? null;
  });
  ctx.provide(
    'quota.report',
    (args, info) => {
      ownSession(info);
      const { provider, ...quota } = parse(ReportQuota, args);
      quotas.report(provider, quota);
      return { ok: true };
    },
    schema(ReportQuota),
  );
  // Only for bays (manifest `bayOnly`): the board files tasks by project (ADR 0037).
  ctx.provide(
    'session.info',
    (args) => {
      const { sessionId } = parse(SessionInfo, args);
      const { projects, sessions } = manager.view();
      const s = sessions.find((x) => x.id === sessionId);
      if (!s) throw new Error('Unknown session');
      const project = projects.find((p) => p.id === s.projectId)!;
      // Same fallback as `labelSessions`.
      const name = s.description || s.branch || s.id.slice(0, 8);
      return { projectId: project.id, project: project.name, name };
    },
    schema(SessionInfo),
  );
  ctx.provide('project.list', () =>
    manager.view().projects.map(({ id, name, shared }) => ({ id, name, shared: shared === true })),
  );
}
