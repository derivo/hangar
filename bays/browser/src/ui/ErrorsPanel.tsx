import { useEffect, useState } from 'react';
import type { PageError } from '@hangar/sdk';
import type { BrowserApi } from './api';
import type { TabView } from '../main/types';
import { t } from './messages';

interface Props {
  api: BrowserApi;
  /** A new object with every state: the list is fetched again then. */
  tab: TabView;
}

const timeOf = (time: number) => new Date(time).toTimeString().slice(0, 8);

/** Errors and warnings the host collected for the page (ADR 0042). */
export function ErrorsPanel({ api, tab }: Props) {
  const [errors, setErrors] = useState<PageError[]>([]);
  const [warnings, setWarnings] = useState(false);

  useEffect(() => {
    let current = true;
    // The tab may be gone meanwhile (closed by an agent): nothing to show then.
    void api.errors(tab.id).then(
      (list) => current && setErrors(list),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [api, tab]);

  const shown = warnings ? errors : errors.filter((e) => e.level === 'error');
  return (
    <section className="errors-panel" aria-label={t.errorsPanel}>
      <label className="muted">
        <input type="checkbox" checked={warnings} onChange={(e) => setWarnings(e.target.checked)} />{' '}
        {t.showWarnings}
      </label>
      {shown.length === 0 ? (
        <p className="muted">{t.noErrors}</p>
      ) : (
        <ol>
          {shown.map((e, i) => (
            <li key={`${e.time}-${i}`} className={e.level === 'error' ? 'error' : 'muted'}>
              <span className="muted">{timeOf(e.time)}</span> {t.kinds[e.kind]}
              {e.level === 'warning' && ` (${t.warning})`}:{' '}
              <span className="message">{e.message}</span>
              {e.source && (
                <span className="muted source">
                  {' '}
                  {e.source}
                  {e.line ? `:${e.line}` : ''}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
