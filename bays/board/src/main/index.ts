import { join } from 'node:path';
import { z } from 'zod';
import type { BayContext, BayMain, CallInfo } from '@hangar/sdk';
import { Board, TASK_STATUSES, type Actor } from './board';
import { messages } from './messages';

const AGENTS = 'dev.hangar.agents';

// Shown in the UI and to other agents: no control characters (escape sequences).
const Text = (max: number) =>
  z
    .string()
    .max(max)
    // eslint-disable-next-line no-control-regex -- finds control characters on purpose
    .regex(/^[^\u0000-\u0008\u000b-\u001f\u007f-\u009f]*$/, 'no control characters');
// Agents of another instance name a project the person shared (ADR 0037, Nachtrag).
const project = z.string().max(200).optional();
const Id = z.object({ id: z.string().min(1), project });
const List = z.object({ status: z.enum(TASK_STATUSES).optional(), project });
const Add = z.object({
  title: Text(200).trim().min(1),
  description: Text(4000).optional(),
  project,
});
const Note = z.object({ id: z.string().min(1), text: Text(2000).trim().min(1), project });
const Done = z.object({ id: z.string().min(1), note: Text(2000).trim().optional(), project });

function parse<T extends z.ZodType>(schema: T, args: unknown): z.output<T> {
  const result = schema.safeParse(args ?? {});
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new Error(`Invalid arguments: ${issue.path.join('.') || 'args'}: ${issue.message}`);
  }
  return result.data;
}

const schema = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input' }) as Record<string, unknown>;

/** Tasks per project for the person and the agents of the agent bay (ADR 0037). */
const bay: BayMain = {
  activate(ctx: BayContext) {
    const t = messages(ctx.locale);
    const board = new Board(join(ctx.dataDir, 'board.json'), (tasks) =>
      ctx.ui.send('state', tasks),
    );
    /**
     * The calling agent and its project, as the agent bay knows them. An agent of another
     * instance names a shared project; its session id is only a label, its instance is checked.
     */
    const caller = async (info: CallInfo, name?: string) => {
      const { caller } = info;
      if (caller.kind === 'remote') {
        const projects = await ctx.call<{ id: string; name: string; shared?: boolean }[]>(
          `${AGENTS}/project.list`,
        );
        const [found, other] = projects.filter((p) => p.name === name && p.shared === true);
        if (!found) throw new Error('No such shared project');
        // Two shared projects of one name: the first would depend on the tree order.
        if (other) throw new Error('Project name is ambiguous');
        const actor: Actor = {
          sessionId: `remote:${caller.instance}/${caller.sessionId ?? ''}`,
          name: `${caller.instance.slice(0, 16)} (${caller.workspace})`,
        };
        return { projectId: found.id, actor };
      }
      if (caller.kind !== 'session')
        throw new Error('Only callable from an agent session or another instance');
      if (caller.bayId !== AGENTS)
        throw new Error('Only callable from an agent session of the agent bay');
      const s = await ctx.call<{ projectId: string; name: string }>(`${AGENTS}/session.info`, {
        sessionId: caller.sessionId,
      });
      const actor: Actor = { sessionId: caller.sessionId, name: s.name };
      return { projectId: s.projectId, actor };
    };
    /**
     * The task of the caller's project. Taken by a session that ended while the board did not
     * run (removed from the sidebar): open again, as on a session end it hears.
     */
    const task = async (id: string, projectId: string, actor: Actor) => {
      const found = board.get(id, projectId);
      const other = found.status === 'doing' ? found.sessionId : undefined;
      // A session of another instance: its end never reaches this board; the person frees it.
      if (other && other !== actor.sessionId && !other.startsWith('remote:')) {
        const ended = await ctx.call(`${AGENTS}/session.info`, { sessionId: other }).then(
          () => false,
          (e: Error) => e.message === 'Unknown session',
        );
        if (ended) board.sessionEnded(other);
      }
      return found;
    };
    ctx.provide(
      'task.list',
      async (args, info) => {
        const { status, project } = parse(List, args);
        const { projectId } = await caller(info, project);
        return board.list(projectId).filter((x) => !status || x.status === status);
      },
      schema(List),
    );
    ctx.provide(
      'task.add',
      async (args, info) => {
        const { title, description = '', project } = parse(Add, args);
        const { projectId, actor } = await caller(info, project);
        return board.add(projectId, title, description, actor);
      },
      schema(Add),
    );
    ctx.provide(
      'task.claim',
      async (args, info) => {
        const { id, project } = parse(Id, args);
        const { projectId, actor } = await caller(info, project);
        return board.claim(await task(id, projectId, actor), actor);
      },
      schema(Id),
    );
    ctx.provide(
      'task.note',
      async (args, info) => {
        const { id, text, project } = parse(Note, args);
        const { projectId, actor } = await caller(info, project);
        return board.note(await task(id, projectId, actor), text, actor);
      },
      schema(Note),
    );
    ctx.provide(
      'task.done',
      async (args, info) => {
        const { id, note, project } = parse(Done, args);
        const { projectId, actor } = await caller(info, project);
        return board.done(await task(id, projectId, actor), note || undefined, actor);
      },
      schema(Done),
    );
    ctx.onAgentSessionEnded(({ bayId, sessionId }) => {
      if (bayId === AGENTS) board.sessionEnded(sessionId);
    });

    const ui = ctx.ui;
    ui.handle('state', () => board.list());
    // `null` when the agent bay is not there to name the projects.
    ui.handle('projects', () => ctx.call(`${AGENTS}/project.list`).catch(() => null));
    ui.handle('add', (projectId, task) => {
      const { title, description = '' } = task as { title: string; description?: string };
      if (!title.trim()) throw new Error(t.titleMissing);
      if (title.trim().length > 200) throw new Error(t.titleTooLong);
      if (description.trim().length > 4000) throw new Error(t.descriptionTooLong);
      return board.add(projectId as string, title.trim(), description.trim(), null);
    });
    ui.handle('reopen', (id) => board.reopen(board.get(id as string)));
    ui.handle('done', (id) => board.done(board.get(id as string), undefined));
    ui.handle('remove', (id) => board.remove(id as string));
  },
};

export default bay;
