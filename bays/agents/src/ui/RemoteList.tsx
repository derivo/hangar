import type { RemoteProject } from '../main/share';
import { t } from './messages';

/**
 * What other instances of the workspaces share (ADR 0030): read only, every project marked with
 * the instance and workspace it comes from.
 */
export function RemoteList({ projects }: { projects: RemoteProject[] }) {
  if (projects.length === 0) return null;
  return (
    <section className="remote" aria-labelledby="remote-title">
      <h2 id="remote-title">{t.remote}</h2>
      <ul className="tree-list">
        {projects.map((p) => {
          const origin = t.remoteOrigin(p.project, p.name, p.workspace);
          return (
            <li
              key={`${p.workspace}\n${p.instance}\n${p.project}`}
              className="remote-project"
              aria-label={origin}
            >
              <span className="tree-project-name">{p.project}</span>
              <span className="remote-origin" title={p.instance}>
                {p.name} ({p.workspace})
              </span>
              {p.sessions.length === 0 ? (
                <p className="muted remote-empty">{t.noRemoteSessions}</p>
              ) : (
                <ul className="tree-sessions">
                  {p.sessions.map((s, i) => (
                    <li key={i} className={`remote-session status-${s.status}`}>
                      <span
                        className="light"
                        role="img"
                        aria-label={t.status[s.status]}
                        title={t.status[s.status]}
                      />
                      <span className="tree-session-title">
                        {s.description || s.branch || t.projectFolder}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
