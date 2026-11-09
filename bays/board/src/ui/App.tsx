import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { BoardApi, ProjectRef } from './api';
import { TASK_STATUSES, type Task } from '../main/board';
import { t } from './messages';

/** Hangar wraps errors from the main part; people only need the message itself. */
const messageOf = (e: unknown) =>
  String(e instanceof Error ? e.message : e).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );

const PROJECTS_MS = 3000;

/** The chosen project, per viewer; storage may be missing (private window). */
const stored = {
  get: () => {
    try {
      return localStorage.getItem('project') ?? undefined;
    } catch {
      return undefined;
    }
  },
  set: (id: string) => {
    try {
      localStorage.setItem('project', id);
    } catch {
      // Only a convenience.
    }
  },
};

export function App({ api }: { api: BoardApi }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<ProjectRef[] | null>();
  const [chosen, setChosen] = useState(stored.get);
  const [error, setError] = useState('');
  /** An action on a card: its failure stands above the columns until the next one. */
  const act = (run: () => Promise<unknown>) => {
    setError('');
    run().catch((e: unknown) => setError(messageOf(e)));
  };

  useEffect(() => {
    let pushed = false;
    // Without an answer the next event brings the tasks.
    api.state().then(
      (s) => pushed || setTasks(s),
      () => {},
    );
    return api.onState((s) => {
      pushed = true;
      setTasks(s);
    });
  }, [api]);

  // Projects live in the agent bay, which sends no events here: asked again every few seconds,
  // one question at a time (the first may wait for the permission dialog).
  useEffect(() => {
    let asking = false;
    const ask = () => {
      if (asking) return;
      asking = true;
      api
        .projects()
        // Not reached (the server's connection closed): the next round asks again.
        .then(setProjects, () => {})
        .finally(() => (asking = false));
    };
    ask();
    const timer = setInterval(ask, PROJECTS_MS);
    return () => clearInterval(timer);
  }, [api]);

  if (projects === undefined) return null;
  const project = projects?.find((p) => p.id === chosen) ?? projects?.[0];
  const choose = (id: string) => {
    setChosen(id);
    stored.set(id);
  };

  return (
    <main className="layout">
      <header className="head">
        <h1>{t.title}</h1>
        {project && (
          <label className="project">
            {t.project}
            <select value={project.id} onChange={(e) => choose(e.target.value)}>
              {projects!.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>
      {projects === null && <p className="muted">{t.noAgents}</p>}
      {projects?.length === 0 && <p className="muted">{t.noProjects}</p>}
      {project && (
        <>
          <p role="alert" className="error">
            {error}
          </p>
          <div className="columns">
            {TASK_STATUSES.map((status) => (
              <Column
                key={status}
                api={api}
                act={act}
                status={status}
                tasks={tasks.filter((x) => x.projectId === project.id && x.status === status)}
              >
                {/* New tasks are open and come last, so they are created where they appear. */}
                {status === 'open' && <AddForm api={api} projectId={project.id} />}
              </Column>
            ))}
          </div>
          <p className="muted hint">{t.hint}</p>
        </>
      )}
    </main>
  );
}

/** Collapsed to a button; opens as a card at the end of the column, like a list's "Add a card". */
function AddForm({ api, projectId }: { api: BoardApi; projectId: string }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const reopenFocus = useRef(false);
  /** Counts closings: an answer for a draft closed meanwhile must not touch the next one. */
  const draft = useRef(0);

  useEffect(() => {
    if (open) titleRef.current?.focus();
    else if (reopenFocus.current) openRef.current?.focus();
  }, [open]);

  const close = () => {
    setTitle('');
    setDescription('');
    setError('');
    reopenFocus.current = true;
    draft.current++;
    setOpen(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return setError(t.titleMissing);
    const mine = draft.current;
    try {
      await api.add(projectId, { title: title.trim(), description: description.trim() });
      if (mine !== draft.current) return;
      setTitle('');
      setDescription('');
      setError('');
      titleRef.current?.focus();
    } catch (err) {
      if (mine === draft.current) setError(messageOf(err));
    }
  };

  if (!open) {
    return (
      <button ref={openRef} className="add-open" type="button" onClick={() => setOpen(true)}>
        <span aria-hidden="true">+</span> {t.openAdd}
      </button>
    );
  }
  return (
    <form
      className="add"
      aria-label={t.add}
      onSubmit={(e) => void submit(e)}
      onKeyDown={(e) => e.key === 'Escape' && close()}
      noValidate
    >
      <input
        ref={titleRef}
        aria-label={t.taskTitle}
        placeholder={t.taskTitle}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={200}
      />
      <textarea
        aria-label={t.description}
        placeholder={t.descriptionPlaceholder}
        rows={2}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <p role="alert" className="error">
        {error}
      </p>
      <div className="actions">
        <button
          className="button button-primary"
          type="submit"
          // Not the second click of a double click: the first one added the task (ADR 0028).
          onClick={(e) => e.detail > 1 && e.preventDefault()}
        >
          {t.create}
        </button>
        <button className="button button-quiet" type="button" onClick={close}>
          {t.cancel}
        </button>
      </div>
    </form>
  );
}

type Act = (run: () => Promise<unknown>) => void;

function Column({
  api,
  act,
  status,
  tasks,
  children,
}: {
  api: BoardApi;
  act: Act;
  status: Task['status'];
  tasks: Task[];
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <section className="column" aria-labelledby={id}>
      <h2>
        <span id={id}>{t.columns[status]}</span> <span className="muted">{tasks.length}</span>
      </h2>
      {tasks.length === 0 ? (
        <p className="muted">{t.empty}</p>
      ) : (
        <ul className="tasks">
          {tasks.map((task) => (
            <Card key={task.id} api={api} act={act} task={task} />
          ))}
        </ul>
      )}
      {children}
    </section>
  );
}

function Card({ api, act, task }: { api: BoardApi; act: Act; task: Task }) {
  const remove = () => {
    if (window.confirm(t.confirmRemove(task.title))) act(() => api.remove(task.id));
  };
  const action = (label: string, aria: string, run: () => void) => (
    // Not the second click of a double click (ADR 0028).
    <button
      className="button"
      type="button"
      aria-label={aria}
      onClick={(e) => e.detail < 2 && run()}
    >
      {label}
    </button>
  );
  return (
    <li className="card">
      <h3>{task.title}</h3>
      {task.description && <p className="description">{task.description}</p>}
      <p className="muted meta">
        {task.createdBy === null ? t.byPerson : t.byAgent(task.createdBy)}
      </p>
      {task.status === 'doing' && task.sessionName && (
        <p className="taken">{t.takenBy(task.sessionName)}</p>
      )}
      {task.notes.length > 0 && (
        <ul className="notes" aria-label={t.notes}>
          {task.notes.map((n, i) => (
            <li key={i}>
              <span className="muted">{n.by}:</span> {n.text}
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        {task.status !== 'done' &&
          action(t.finish, t.finishLabel(task.title), () => act(() => api.done(task.id)))}
        {task.status === 'doing' &&
          action(t.release, t.releaseLabel(task.title), () => act(() => api.reopen(task.id)))}
        {task.status === 'done' &&
          action(t.reopen, t.reopenLabel(task.title), () => act(() => api.reopen(task.id)))}
        {task.status !== 'doing' && action(t.remove, t.removeLabel(task.title), remove)}
      </div>
    </li>
  );
}
