import { useEffect, useState } from 'react';
import { t } from '../messages';
import type { OverviewView, ShellApi } from '../shared';

interface Props {
  api: Pick<ShellApi, 'getOverview'>;
}

/** Hangar at a glance: its version, global git identity, installed bays. */
export function Overview({ api }: Props) {
  const [view, setView] = useState<OverviewView>();
  useEffect(() => void api.getOverview().then(setView), [api]);
  if (!view) return null;
  const { git } = view;
  const missing = (['name', 'email'] as const).filter((key) => !git[key]);

  return (
    <section className="settings" aria-labelledby="overview-title">
      <h1 id="overview-title">{t.overview}</h1>

      <h2>{t.version}</h2>
      <ul className="facts" aria-label={t.version}>
        <Fact label="Hangar" value={view.version} />
      </ul>

      <h2>Git</h2>
      {git.installed ? (
        <>
          <ul className="facts" aria-label="Git">
            <Fact label={t.name} value={git.name} />
            <Fact label={t.email} value={git.email} />
          </ul>
          {missing.length > 0 && (
            <p className="muted">
              {t.gitSetHint}{' '}
              {missing.map((key) => (
                <code key={key} className="command">
                  {`git config --global user.${key} "…"`}
                </code>
              ))}
            </p>
          )}
        </>
      ) : (
        <p className="muted">{t.gitMissing}</p>
      )}

      <h2>Bays</h2>
      <table className="bays">
        <thead>
          <tr>
            <th scope="col">{t.name}</th>
            <th scope="col">{t.bayId}</th>
            <th scope="col">{t.version}</th>
          </tr>
        </thead>
        <tbody>
          {view.bays.map((bay) => (
            <tr key={bay.id}>
              <th scope="row">{bay.name}</th>
              <td>
                <code>{bay.id}</code>
              </td>
              <td>{bay.version}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.errors.length > 0 && (
        <>
          <h3>{t.notLoaded}</h3>
          <ul className="permission-list">
            {view.errors.map((e) => (
              <li key={e.label}>{`${e.label}: ${e.error}`}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Fact({ label, value }: { label: string; value?: string }) {
  return (
    <li>
      <span>{label}</span>
      {value ? <b>{value}</b> : <b className="muted">{t.notSet}</b>}
    </li>
  );
}
