import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { nextRun, parseCron } from './cron';

/** Outcome of one run. */
export interface JobRun {
  at: number;
  durationMs: number;
  ok: boolean;
  /** Text the handler returned, or the error message; at most 500 characters. */
  output: string;
}

/** A scheduled job; bays store data in `payload`, never code. */
export interface Job {
  id: string;
  bayId: string;
  label: string;
  /** Five-field cron expression in local time (ADR 0013). */
  schedule: string;
  payload?: unknown;
  paused: boolean;
  createdAt: number;
  /** Next run is the first match after this: creation, last run or resume. */
  since: number;
  lastRun?: JobRun;
}

export interface JobView extends Job {
  nextRun?: number;
  running: boolean;
  /** The bay registered a handler (is loaded). */
  available: boolean;
}

export interface NewJob {
  label: string;
  schedule: string;
  payload?: unknown;
}

/** Runs a job; resolve with a short result text, throw to report failure. */
export type JobHandler = (job: Job) => unknown;

export interface SchedulerOptions {
  file: string;
  now?: () => number;
  /** Called after jobs or their results changed. */
  onChange?: () => void;
}

const OUTPUT_LIMIT = 500;
const clip = (text: string) =>
  text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT - 1)}…` : text;

/** Persistent cron jobs, checked periodically; no Electron (ADR 0013). */
export class Scheduler {
  private jobs: Job[] = [];
  private readonly handlers = new Map<string, JobHandler>();
  private readonly running = new Set<string>();
  private readonly now: () => number;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now ?? Date.now;
    if (existsSync(options.file)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(options.file, 'utf8'));
        if (Array.isArray(parsed)) this.jobs = parsed as Job[];
      } catch {
        // start empty rather than fail Hangar's start
      }
    }
  }

  handle(bayId: string, handler: JobHandler): void {
    this.handlers.set(bayId, handler);
  }

  unhandle(bayId: string): void {
    this.handlers.delete(bayId);
  }

  add(bayId: string, input: NewJob): Job {
    parseCron(input.schedule);
    const now = this.now();
    const job: Job = {
      id: randomUUID(),
      bayId,
      label: input.label,
      schedule: input.schedule.trim(),
      ...(input.payload !== undefined && { payload: input.payload }),
      paused: false,
      createdAt: now,
      since: now,
    };
    this.jobs.push(job);
    this.changed();
    return job;
  }

  list(bayId?: string): JobView[] {
    return this.jobs
      .filter((j) => !bayId || j.bayId === bayId)
      .map((j) => ({
        ...j,
        nextRun: j.paused ? undefined : nextRun(parseCron(j.schedule), j.since),
        running: this.running.has(j.id),
        available: this.handlers.has(j.bayId),
      }));
  }

  remove(id: string): void {
    this.job(id);
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.changed();
  }

  setPaused(id: string, paused: boolean): void {
    const job = this.job(id);
    job.paused = paused;
    if (!paused) job.since = this.now();
    this.changed();
  }

  /** Runs a job now, regardless of schedule or pause. */
  async runNow(id: string): Promise<JobRun> {
    const job = this.job(id);
    if (this.running.has(id)) throw new Error('Job is already running');
    if (!this.handlers.has(job.bayId)) throw new Error(`Bay "${job.bayId}" is not loaded`);
    return this.run(job);
  }

  /** Runs every job that was due since its last run, at most once each. */
  async tick(): Promise<void> {
    const now = this.now();
    const due = this.list().filter(
      (j) => j.available && !j.running && j.nextRun !== undefined && j.nextRun <= now,
    );
    await Promise.all(due.map((j) => this.run(this.job(j.id))));
  }

  start(intervalMs = 15_000): void {
    // a failed check (e.g. disk full) is retried on the next interval
    this.timer = setInterval(() => void this.tick().catch(console.error), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private async run(job: Job): Promise<JobRun> {
    const at = this.now();
    this.running.add(job.id);
    let ok = true;
    let output: string;
    try {
      job.since = at;
      this.changed();
      const result = await this.handlers.get(job.bayId)!(job);
      output = typeof result === 'string' ? result : '';
    } catch (err) {
      ok = false;
      output = err instanceof Error ? err.message : String(err);
    } finally {
      this.running.delete(job.id);
    }
    const run = { at, durationMs: this.now() - at, ok, output: clip(output) };
    // the job may have been removed meanwhile; then the result is dropped
    job.lastRun = run;
    this.changed();
    return run;
  }

  private job(id: string): Job {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new Error(`Unknown job "${id}"`);
    return job;
  }

  private changed(): void {
    const { file } = this.options;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(this.jobs, null, 2));
    renameSync(`${file}.tmp`, file);
    this.options.onChange?.();
  }
}
