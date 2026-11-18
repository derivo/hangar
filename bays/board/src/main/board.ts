import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const TASK_STATUSES = ['open', 'doing', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Where text from another instance came from, by the authenticated caller (ADR 0046). */
export interface Origin {
  /** Name of the instance in the member list, else its fingerprint. */
  instance: string;
  fingerprint: string;
  workspace: string;
}

export interface TaskNote {
  at: string;
  text: string;
  /** Name of the session that wrote it. */
  by: string;
  /** Written by another instance. */
  origin?: Origin;
  /** The accepted inbox call that wrote it; a repeat adds nothing (ADR 0046). */
  executionId?: string;
}

/** A task of a project of the agent bay (ADR 0037). */
export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  /** Session that took it; kept when done, gone when open again. */
  sessionId?: string;
  sessionName?: string;
  /** Session name of the agent that added it; `null`: the person. */
  createdBy: string | null;
  /** Added by another instance. */
  origin?: Origin;
  /** The accepted inbox call that added it; a repeat returns this task (ADR 0046). */
  executionId?: string;
  notes: TaskNote[];
  createdAt: string;
  updatedAt: string;
}

/** Who acts on a task: an agent session, with the name the agent bay gives it. */
export interface Actor {
  sessionId: string;
  name: string;
  /** An agent of another instance. */
  origin?: Origin;
  /** Set when an accepted inbox call acts (ADR 0046). */
  executionId?: string;
}

/** The tasks in `board.json`; every change is written at once. */
export class Board {
  private tasks: Task[];

  constructor(
    private readonly file: string,
    private readonly changed: (tasks: Task[]) => void,
    private readonly now = () => new Date().toISOString(),
  ) {
    this.tasks = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Task[]) : [];
  }

  list(projectId?: string): Task[] {
    return projectId ? this.tasks.filter((t) => t.projectId === projectId) : this.tasks;
  }

  add(projectId: string, title: string, description: string, by: Actor | null): Task {
    const repeat = by?.executionId && this.tasks.find((t) => t.executionId === by.executionId);
    if (repeat) return repeat;
    const at = this.now();
    const task: Task = {
      id: randomUUID(),
      projectId,
      title,
      description,
      status: 'open',
      createdBy: by?.name ?? null,
      ...(by?.origin && { origin: by.origin }),
      ...(by?.executionId && { executionId: by.executionId }),
      notes: [],
      createdAt: at,
      updatedAt: at,
    };
    this.tasks.push(task);
    this.write();
    return task;
  }

  /** A task of `projectId`, if given; another project's is unknown, so nothing leaks. */
  get(id: string, projectId?: string): Task {
    const task = this.tasks.find((t) => t.id === id && (!projectId || t.projectId === projectId));
    if (!task) throw new Error('Unknown task');
    return task;
  }

  claim(task: Task, by: Actor): Task {
    if (task.status === 'done') throw new Error('Task is done');
    this.ownable(task, by);
    return this.update(task, { status: 'doing', sessionId: by.sessionId, sessionName: by.name });
  }

  note(task: Task, text: string, by: Actor): Task {
    this.ownable(task, by);
    if (this.repeated(task, by)) return task;
    return this.update(task, { notes: [...task.notes, this.noteOf(text, by)] });
  }

  done(task: Task, note: string | undefined, by?: Actor): Task {
    if (by) this.ownable(task, by);
    if (by && this.repeated(task, by)) return task;
    const notes = note && by ? [...task.notes, this.noteOf(note, by)] : task.notes;
    return this.update(task, { status: 'done', notes });
  }

  reopen(task: Task): Task {
    return this.update(task, { status: 'open', sessionId: undefined, sessionName: undefined });
  }

  remove(id: string): void {
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.write();
  }

  /** The session ended: what it worked on is open again (ADR 0016). */
  sessionEnded(sessionId: string): void {
    for (const task of this.tasks)
      if (task.status === 'doing' && task.sessionId === sessionId) this.reopen(task);
  }

  private noteOf(text: string, by: Actor): TaskNote {
    return {
      at: this.now(),
      text,
      by: by.name,
      ...(by.origin && { origin: by.origin }),
      ...(by.executionId && { executionId: by.executionId }),
    };
  }

  /** The accepted inbox call already wrote its note (a run before a crash). */
  private repeated(task: Task, by: Actor): boolean {
    return !!by.executionId && task.notes.some((n) => n.executionId === by.executionId);
  }

  /** Taken by another session, also once done (ADR 0037). */
  private ownable(task: Task, by: Actor): void {
    if (task.sessionId && task.sessionId !== by.sessionId)
      throw new Error(`Task is taken by session ${task.sessionName}`);
  }

  private update(task: Task, patch: Partial<Task>): Task {
    Object.assign(task, patch, { updatedAt: this.now() });
    if (task.sessionId === undefined) {
      delete task.sessionId;
      delete task.sessionName;
    }
    this.write();
    return task;
  }

  private write(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.tasks, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
    this.changed(this.tasks);
  }
}
