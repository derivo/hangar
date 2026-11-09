import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { PORT_BLOCK, TAB_COLORS, type SessionView, type TabColor } from '../main/types';
import type { AgentsApi } from './api';
import { formatEnv, parseEnv } from './env-text';
import { branchOf, sessionName, t } from './messages';
import { SecretsHint } from './SecretsHint';
import { Statusbar } from './Statusbar';
import type { TerminalRegistry } from './terminals';

/** Asked from the context menu of the project tree: focus the description, open a form. */
export interface PaneRequest {
  id: string;
  action: 'describe' | 'env' | 'job';
}

interface Props {
  session: SessionView;
  projectName: string;
  /** The focused field of the grid: its terminal takes the keyboard. */
  active: boolean;
  api: Pick<AgentsApi, 'update' | 'restart' | 'closeSession' | 'addJob' | 'secrets'>;
  terminals: Pick<TerminalRegistry, 'attach' | 'fit' | 'focus' | 'setCopyOnSelect'>;
  /** Runs an action and shows its error, if any; a running action with the same key is not repeated. */
  run(action: () => Promise<unknown>, key?: string): Promise<void>;
  /** Buttons of the grid field holding this session. */
  fieldActions?: ReactNode;
  /** Symbol button left of „×“ top right: undock, or dock in a window of its own. */
  windowAction?: ReactNode;
  request?: PaneRequest;
  /** The request is done: it must not run again when the pane shows anew. */
  onRequestDone?(): void;
}

export function SessionPane(props: Props) {
  const { session, projectName, active, api, terminals, run } = props;
  const termRef = useRef<HTMLDivElement>(null);
  // Draft while editing; otherwise the description follows the session (agent updates).
  const [draft, setDraft] = useState<string | null>(null);
  const description = draft ?? session.description;
  const [envOpen, setEnvOpen] = useState(false);
  const [envText, setEnvText] = useState('');
  const [jobOpen, setJobOpen] = useState(false);
  const [jobAdded, setJobAdded] = useState(false);
  const [command, setCommand] = useState('');
  const [schedule, setSchedule] = useState('');

  useEffect(() => {
    const el = termRef.current!;
    terminals.attach(session.id, el);
    const observer = new ResizeObserver(() => terminals.fit(session.id));
    observer.observe(el);
    return () => observer.disconnect();
  }, [session.id, terminals]);
  useEffect(() => {
    if (active) terminals.focus(session.id);
  }, [active, session.id, terminals]);
  // Sessions from before the setting have no value: they keep copying (ADR 0023).
  const copyOnSelect = session.copyOnSelect ?? true;
  useEffect(() => {
    terminals.setCopyOnSelect(session.id, copyOnSelect);
  }, [copyOnSelect, session.id, terminals]);
  const descriptionRef = useRef<HTMLInputElement>(null);
  const envRef = useRef<HTMLTextAreaElement>(null);
  const commandRef = useRef<HTMLInputElement>(null);
  const openEnv = () => {
    setEnvText(formatEnv(session.env));
    setEnvOpen(true);
  };
  const openJob = () => {
    setCommand('');
    setSchedule('');
    setJobAdded(false);
    setJobOpen(true);
  };
  // A new request opens its form while rendering (no effect), then the effect focuses it.
  const { request } = props;
  const [handled, setHandled] = useState<PaneRequest>();
  if (request !== handled) {
    setHandled(request);
    if (request?.action === 'env') openEnv();
    if (request?.action === 'job') openJob();
  }
  useEffect(() => {
    const field = { describe: descriptionRef, env: envRef, job: commandRef };
    if (!request) return;
    field[request.action].current!.focus();
    props.onRequestDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new request counts
  }, [request]);
  const envId = useId();
  const jobId = useId();
  const colorId = useId();

  const saveDescription = () => {
    if (draft !== null && draft.trim() !== session.description) {
      void run(() => api.update(session.id, { description: draft }));
    }
    setDraft(null);
  };

  const saveEnv = () =>
    run(async () => {
      await api.update(session.id, { env: parseEnv(envText) });
      setEnvOpen(false);
    }, `env:${session.id}`);

  const addJob = () =>
    run(async () => {
      await api.addJob(session.id, command, schedule);
      setJobOpen(false);
      setJobAdded(true);
    }, `job:${session.id}`);

  return (
    <section
      className="pane"
      aria-label={`${t.session} ${sessionName(session)}`}
      data-color={session.color}
      style={tabColorStyle(session.color)}
    >
      <header className="pane-header chamfer">
        <div className="pane-row">
          <input
            ref={descriptionRef}
            className="description"
            aria-label={t.description}
            placeholder={sessionName(session)}
            value={description}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={saveDescription}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          <span className="window-controls">
            {props.windowAction}
            <button
              type="button"
              className="icon-button"
              aria-label={t.closeSession}
              title={t.closeSession}
              onClick={() => {
                if (window.confirm(t.confirmCloseSession)) {
                  void run(() => api.closeSession(session.id), `close:${session.id}`);
                }
              }}
            >
              ×
            </button>
          </span>
        </div>
        <div className="pane-row">
          <button
            type="button"
            className="button"
            aria-expanded={envOpen}
            onClick={() => {
              setEnvText(formatEnv(session.env));
              setEnvOpen(!envOpen);
            }}
          >
            {t.envVars}
          </button>
          <button
            type="button"
            className="button"
            aria-expanded={jobOpen}
            onClick={() => {
              setCommand('');
              setSchedule('');
              setJobAdded(false);
              setJobOpen(!jobOpen);
            }}
          >
            {t.scheduleJob}
          </button>
          {props.fieldActions}
        </div>
        <div className="pane-row">
          <ul className="telemetry" aria-label={t.sessionData}>
            <li className="readout">
              <span>{t.project}</span>
              <b>{projectName}</b>
            </li>
            <li className="readout">
              <span>{t.branch}</span>
              <b>{branchOf(session)}</b>
            </li>
            <li className="readout">
              <span>{t.ports}</span>
              <b>
                {session.portBase}–{session.portBase + PORT_BLOCK - 1}
              </b>
            </li>
          </ul>
          <label className="copy-toggle">
            <input
              type="checkbox"
              checked={copyOnSelect}
              onChange={(e) =>
                void run(() => api.update(session.id, { copyOnSelect: e.target.checked }))
              }
            />
            {t.copyOnSelect}
          </label>
          <span className="tab-color">
            <label htmlFor={colorId}>{t.tabColor}</label>
            <select
              id={colorId}
              className="button"
              value={session.color ?? ''}
              onChange={(e) =>
                void run(() =>
                  api.update(session.id, { color: (e.target.value || null) as TabColor | null }),
                )
              }
            >
              <option value="">{t.colors.none}</option>
              {TAB_COLORS.map((color) => (
                <option key={color} value={color}>
                  {t.colors[color]}
                </option>
              ))}
            </select>
          </span>
          <span className={`pane-status chamfer status-${session.status}`}>
            <span className="light" aria-hidden="true" />
            {t.status[session.status]}
          </span>
        </div>
      </header>
      {envOpen && (
        <div className="env-editor">
          <label htmlFor={envId}>{t.envEditor}</label>
          <textarea
            ref={envRef}
            id={envId}
            aria-describedby={`${envId}-secrets`}
            rows={5}
            value={envText}
            spellCheck={false}
            onChange={(e) => setEnvText(e.target.value)}
          />
          <SecretsHint api={api} id={`${envId}-secrets`} />
          <div className="env-actions">
            <button type="button" className="button button-primary" onClick={() => void saveEnv()}>
              {t.saveEnv}
            </button>
            <button type="button" className="button" onClick={() => setEnvOpen(false)}>
              {t.cancel}
            </button>
          </div>
        </div>
      )}
      {jobOpen && (
        <form
          className="env-editor"
          aria-label={t.scheduleJob}
          onSubmit={(e) => {
            e.preventDefault();
            void addJob();
          }}
        >
          <label className="job-field">
            {t.jobCommand}
            <input
              ref={commandRef}
              value={command}
              spellCheck={false}
              onChange={(e) => setCommand(e.target.value)}
            />
          </label>
          <label className="job-field">
            {t.jobSchedule}
            <input
              value={schedule}
              placeholder="0 2 * * 1-5"
              spellCheck={false}
              aria-describedby={`${jobId}-hint`}
              onChange={(e) => setSchedule(e.target.value)}
            />
          </label>
          <p id={`${jobId}-hint`} className="job-hint">
            {t.jobScheduleHint}
          </p>
          <div className="env-actions">
            <button
              type="submit"
              className="button button-primary"
              // Not the second click of a double click: the first one planned the job (ADR 0028).
              onClick={(e) => e.detail > 1 && e.preventDefault()}
            >
              {t.addJob}
            </button>
            <button type="button" className="button" onClick={() => setJobOpen(false)}>
              {t.cancel}
            </button>
          </div>
        </form>
      )}
      {jobAdded && (
        <p className="job-added" role="status">
          {t.jobAdded}
        </p>
      )}
      {session.handover && (
        <section className="handover" aria-labelledby={`${envId}-handover`}>
          <h2 id={`${envId}-handover`}>{t.handoverFrom(session.handover.from)}</h2>
          <dl>
            <dt>{t.handoverTask}</dt>
            <dd>{session.handover.task}</dd>
            {session.handover.branch && (
              <>
                <dt>Branch</dt>
                <dd>
                  {session.handover.branch}
                  {session.handover.remote && ` (${session.handover.remote})`}
                </dd>
              </>
            )}
            {!session.handover.branch && session.handover.remote && (
              <>
                <dt>Remote</dt>
                <dd>{session.handover.remote}</dd>
              </>
            )}
            {session.handover.context && (
              <>
                <dt>{t.handoverContext}</dt>
                <dd>{session.handover.context}</dd>
              </>
            )}
          </dl>
          {session.handover.origin === 'remote' && <p className="muted">{t.handoverRemote}</p>}
        </section>
      )}
      <div className="console chamfer">
        <div className="console-terminal" ref={termRef} data-testid="terminal" />
        <Statusbar segments={session.statusbar} />
      </div>
      {!session.running && (
        <div className="shell-ended" role="status">
          {t.shellEnded}
          <button
            type="button"
            className="button button-primary"
            onClick={() => void run(() => api.restart(session.id), `restart:${session.id}`)}
          >
            {t.restart}
          </button>
        </div>
      )}
    </section>
  );
}

/** Sets `--tab-color` for the stripe of a colored tab (pane header, project tree). */
export function tabColorStyle(color: TabColor | undefined): CSSProperties | undefined {
  return color && ({ '--tab-color': `var(--hangar-color-tab-${color})` } as CSSProperties);
}
