import { parseCron } from '@hangar/scheduler';
import type { BayContext, Job, JobView } from '@hangar/sdk';
import type { SessionManager } from './sessions';
import { t } from './messages';

/** What an agent bay job stores: a command run in one session's worktree (ADR 0013, 0014). */
interface SessionJob {
  sessionId: string;
  command: string;
}

const payloadOf = (job: Job) => job.payload as SessionJob;

/** Runs, adds and cleans up the agent bay's jobs. */
export class SessionJobs {
  constructor(
    private readonly ctx: BayContext,
    private readonly manager: SessionManager,
  ) {
    ctx.jobs.onRun(async (job) => {
      const { sessionId, command } = payloadOf(job);
      const { exitCode, lastLine } = await manager.runCommand(sessionId, command);
      const text = t.jobResult(exitCode, lastLine);
      if (exitCode !== 0) throw new Error(text);
      return text;
    });
  }

  /** From the bay UI: errors for people. */
  addFromUi(sessionId: string, command: string, schedule: string): Job {
    if (!this.manager.view().sessions.some((s) => s.id === sessionId))
      throw new Error(t.unknownSession(sessionId));
    if (!command.trim()) throw new Error(t.commandMissing);
    if (!schedule.trim()) throw new Error(t.scheduleMissing);
    try {
      parseCron(schedule);
    } catch {
      throw new Error(t.invalidSchedule(schedule));
    }
    return this.add(sessionId, command, schedule);
  }

  /** Throws the scheduler's English error for an invalid schedule (agents read it). */
  add(sessionId: string, command: string, schedule: string): Job {
    const payload: SessionJob = { sessionId, command: command.trim() };
    return this.ctx.jobs.add({ label: payload.command, schedule, payload });
  }

  of(sessionId: string): JobView[] {
    return this.ctx.jobs.list().filter((j) => payloadOf(j).sessionId === sessionId);
  }

  removeAll(sessionId: string): void {
    for (const job of this.of(sessionId)) this.ctx.jobs.remove(job.id);
  }
}
