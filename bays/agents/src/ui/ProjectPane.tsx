import { useCallback, useEffect, useRef, useState } from 'react';
import { PORT_BLOCK, type Project, type ProjectDetails, type SessionView } from '../main/types';
import type { AgentsApi } from './api';
import { formatEnv, parseEnv } from './env-text';
import { branchOf, sessionName, t } from './messages';
import { SecretsHint } from './SecretsHint';

interface Props {
  project: Project;
  sessions: SessionView[];
  api: Pick<
    AgentsApi,
    | 'projectDetails'
    | 'deleteBranch'
    | 'setProjectEnv'
    | 'setProjectShared'
    | 'closeSession'
    | 'secrets'
  >;
  /** Runs an action and shows its error, if any; a running action with the same key is not repeated. */
  run(action: () => Promise<unknown>, key?: string): Promise<void>;
  onOpenSession(sessionId: string): void;
  onCreateSession(): void;
  onRemoveProject(): void;
  /** Moves the project one place in the tree; missing at the start or end of the order. */
  onMoveUp?(): void;
  onMoveDown?(): void;
  /** Puts a session at `index` among the project's sessions (WCAG 2.5.7, without dragging). */
  onMoveSession?(sessionId: string, index: number): void;
}

/** Overview of a project: its sessions with their git state, orphaned branches, env for new sessions. */
export function ProjectPane({ project, sessions, api, run, ...props }: Props) {
  const [details, setDetails] = useState<ProjectDetails>();
  const [envText, setEnvText] = useState(() => formatEnv(project.env ?? {}));
  const sessionKey = sessions.map((s) => s.id).join();

  // Removing the project closes its sessions first, which reloads the git state of a
  // project that is gone a moment later: answers after leaving the overview are dropped.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Only the newest load counts: an earlier refresh may answer last.
  const loads = useRef(0);
  const load = useCallback(
    () =>
      run(async () => {
        const n = ++loads.current;
        try {
          const next = await api.projectDetails(project.id);
          if (mounted.current && n === loads.current) setDetails(next);
        } catch (e) {
          if (mounted.current) throw e;
        }
      }),
    [api, project.id, run],
  );
  useEffect(() => {
    void load();
  }, [load, sessionKey]);

  const git = (id: string) => details?.worktrees.find((w) => w.sessionId === id);
  const show = (value: number | null | undefined, format: (n: number) => string) =>
    value === undefined ? '' : value === null ? t.unknown : format(value);

  return (
    <section className="project-pane" aria-labelledby="project-title">
      <header className="project-head chamfer">
        <div>
          <h1 id="project-title">{project.name}</h1>
          <p className="project-path" title={t.pathLabel}>
            {project.path}
          </p>
        </div>
        <div className="project-actions">
          <button type="button" className="button" onClick={() => void load()}>
            {t.refresh}
          </button>
          <button
            type="button"
            className="button"
            disabled={!props.onMoveUp}
            onClick={props.onMoveUp}
          >
            {t.moveProjectUp}
          </button>
          <button
            type="button"
            className="button"
            disabled={!props.onMoveDown}
            onClick={props.onMoveDown}
          >
            {t.moveProjectDown}
          </button>
          <button type="button" className="button" onClick={props.onRemoveProject}>
            {t.removeProject}
          </button>
        </div>
      </header>

      <div className="project-section">
        <div className="project-section-head">
          <h2 id="project-sessions">{t.sessions}</h2>
          <button
            type="button"
            className="button button-primary"
            // The further clicks of a double click (detail 2, 3 …) do not repeat it.
            onClick={(e) => e.detail <= 1 && props.onCreateSession()}
          >
            {t.newSession}
          </button>
        </div>
        {sessions.length === 0 ? (
          <p className="muted">{t.noSessions}</p>
        ) : (
          <>
            <p className="muted">{t.gitHint}</p>
            <div className="table-scroll">
              <table className="project-sessions" aria-labelledby="project-sessions">
                <thead>
                  <tr>
                    <th scope="col">{t.statusColumn}</th>
                    <th scope="col">{t.session}</th>
                    <th scope="col">{t.branch}</th>
                    <th scope="col">{t.ports}</th>
                    <th scope="col">{t.changes}</th>
                    <th scope="col">{t.newCommits}</th>
                    <td />
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s, index) => {
                    const name = sessionName(s);
                    return (
                      <tr key={s.id}>
                        <td className={`status-${s.status}`}>
                          <span
                            className="light"
                            role="img"
                            aria-label={t.status[s.status]}
                            title={t.status[s.status]}
                          />
                        </td>
                        <th scope="row">
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => props.onOpenSession(s.id)}
                          >
                            {name}
                          </button>
                        </th>
                        <td className="mono">{branchOf(s)}</td>
                        <td className="mono">
                          {s.portBase}–{s.portBase + PORT_BLOCK - 1}
                        </td>
                        <td>{show(git(s.id)?.changes, t.files)}</td>
                        <td>{show(git(s.id)?.ahead, t.count)}</td>
                        <td className="row-actions">
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={t.moveSessionUp(name)}
                            title={t.moveSessionUp(name)}
                            disabled={index === 0}
                            onClick={() => props.onMoveSession?.(s.id, index - 1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={t.moveSessionDown(name)}
                            title={t.moveSessionDown(name)}
                            disabled={index === sessions.length - 1}
                            onClick={() => props.onMoveSession?.(s.id, index + 1)}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={t.closeSessionNamed(name)}
                            title={t.closeSession}
                            onClick={() => {
                              if (window.confirm(t.confirmCloseSession)) {
                                void run(() => api.closeSession(s.id), `close:${s.id}`);
                              }
                            }}
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="project-section">
        <h2 id="project-orphans">{t.orphans}</h2>
        <p className="muted">{t.orphansHint}</p>
        {details && details.orphans.length === 0 && <p className="muted">{t.noOrphans}</p>}
        {details && details.orphans.length > 0 && (
          <ul className="orphans" aria-labelledby="project-orphans">
            {details.orphans.map((o) => (
              <li key={o.branch}>
                <code>{o.branch}</code>
                <span className="muted">
                  {t.newCommits}: {t.count(o.ahead)}
                </span>
                <button
                  type="button"
                  className="button"
                  aria-label={t.deleteBranchNamed(o.branch)}
                  onClick={() => {
                    if (window.confirm(t.confirmDeleteBranch(o.branch, o.ahead))) {
                      void run(async () => {
                        await api.deleteBranch(project.id, o.branch);
                        await load();
                      }, `branch:${o.branch}`);
                    }
                  }}
                >
                  {t.deleteBranch}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="project-section">
        <label className="share-toggle">
          <input
            type="checkbox"
            checked={project.shared === true}
            aria-describedby="project-share-hint"
            onChange={(e) => {
              const shared = e.target.checked;
              void run(() => api.setProjectShared(project.id, shared), `share:${project.id}`);
            }}
          />
          {t.share}
        </label>
        <p id="project-share-hint" className="muted">
          {t.shareHint}
        </p>
      </div>

      <div className="project-section env-editor">
        <h2 id="project-env">{t.projectEnv}</h2>
        <p id="project-env-hint" className="muted">
          {t.projectEnvHint}
        </p>
        <textarea
          aria-labelledby="project-env"
          aria-describedby="project-env-hint project-env-secrets"
          rows={4}
          value={envText}
          spellCheck={false}
          onChange={(e) => setEnvText(e.target.value)}
        />
        <SecretsHint api={api} id="project-env-secrets" />
        <div className="env-actions">
          <button
            type="button"
            className="button button-primary"
            onClick={() =>
              void run(() => api.setProjectEnv(project.id, parseEnv(envText)), `env:${project.id}`)
            }
          >
            {t.save}
          </button>
        </div>
      </div>
    </section>
  );
}
