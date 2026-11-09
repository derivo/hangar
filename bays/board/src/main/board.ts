import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const TASK_STATUSES = ['open', 'doing', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskNote {
  at: string;
  text: string;
  /** Name of the session that wrote it. */
  by: string;
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
  notes: TaskNote[];
  createdAt: string;
  updatedAt: string;
}

/** Who acts on a task: an agent session, with the name the agent bay gives it. */
export interface Actor {
  sessionId: string;
  name: string;
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
    const at = this.now();
    const task: Task = {
      id: randomUUID(),
      projectId,
      title,
      description,
      status: 'open',
      createdBy: by?.name ?? null,
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
    return this.update(task, { notes: [...task.notes, { at: this.now(), text, by: by.name }] });
  }

  done(task: Task, note: string | undefined, by?: Actor): Task {
    if (by) this.ownable(task, by);
    const notes =
      note && by ? [...task.notes, { at: this.now(), text: note, by: by.name }] : task.notes;
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
