import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { t } from '../messages';
import type { Catalog, CatalogEntry, ShellApi } from '../shared';

interface Props {
  api: Pick<ShellApi, 'getBayCatalog' | 'prepareBay' | 'confirmBay' | 'cancelBay' | 'rollbackBay'>;
}

const shown = (e: Error) =>
  e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Bays of the index: install, update, roll back; each after confirmation (ADR 0034). */
export function BayCatalog({ api }: Props) {
  const [catalog, setCatalog] = useState<Catalog | null>();
  const [error, setError] = useState('');
  const load = useCallback(
    () => api.getBayCatalog().then(setCatalog, (e: Error) => setError(t.bayActionFailed(shown(e)))),
    [api],
  );
  useEffect(() => void load(), [load]);
  // One action at a time (ADR 0028): a second click before the reloaded list does nothing.
  const busy = useRef(false);
  const act = (event: MouseEvent, action: () => Promise<void>) => {
    if (event.detail > 1 || busy.current) return;
    busy.current = true;
    setError('');
    void action()
      .catch((e: Error) => setError(t.bayActionFailed(shown(e))))
      .finally(() => load())
      .finally(() => (busy.current = false));
  };
  const install = (bay: CatalogEntry) => async () => {
    const prepared = await api.prepareBay(bay.id, bay.available!);
    if (window.confirm(t.confirmInstall(prepared))) await api.confirmBay(prepared.token);
    else await api.cancelBay(prepared.token);
  };
  const rollback = (bay: CatalogEntry) => async () => {
    if (window.confirm(t.confirmRollback(bay.id, bay.previous!, bay.rollbackLosesData))) {
      await api.rollbackBay(bay.id);
    }
  };

  return (
    <>
      <h2 id="bay-catalog-title">{t.installBays}</h2>
      <p className="muted">{t.installBaysHint}</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {catalog?.error && (
        <p className="error" role="alert">
          {t.bayActionFailed(catalog.error)}
        </p>
      )}
      {catalog === null && <p>{t.noBayIndex}</p>}
      {catalog?.bays.length === 0 && !catalog.error && <p>{t.noBaysInIndex}</p>}
      {catalog && catalog.bays.length > 0 && (
        <ul className="bay-catalog" aria-labelledby="bay-catalog-title">
          {catalog.bays.map((bay) => {
            const nameId = `bay-catalog-${bay.id}`;
            return (
              <li key={bay.id}>
                <span id={nameId} className="bay-catalog-name">
                  {bay.id}
                </span>
                <span className="muted">
                  {bay.current ? t.installedVersion(bay.current) : t.notInstalled}
                </span>
                {bay.next && <span className="muted">{t.nextStartVersion(bay.next)}</span>}
                <span className="bay-catalog-actions">
                  {bay.canInstall && (
                    <button
                      type="button"
                      className="button"
                      aria-describedby={nameId}
                      onClick={(e) => act(e, install(bay))}
                    >
                      {bay.current ? t.updateBay(bay.available!) : t.installBay(bay.available!)}
                    </button>
                  )}
                  {bay.canRollback && (
                    <button
                      type="button"
                      className="button"
                      aria-describedby={nameId}
                      onClick={(e) => act(e, rollback(bay))}
                    >
                      {t.rollbackBay(bay.previous!)}
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
