import { useEffect, useRef, useState } from 'react';
import { Sidebar } from './Sidebar';
import { Overview } from './Overview';
import { Settings } from './Settings';
import { UPDATE_HINT_HEIGHT, type ShellApi, type ShellState } from '../shared';
import { t } from '../messages';

export function App({ api }: { api: ShellApi }) {
  const [state, setState] = useState<ShellState>();

  useEffect(() => {
    void api.getState().then(setState);
    return api.onState(setState);
  }, [api]);

  if (!state) return null;
  const local = state.localServer;
  const localBay = local?.bays.some((b) => b.id === state.selected) ? local : undefined;
  return (
    <div className="shell">
      <Sidebar state={state} api={api} onSelect={(s) => api.select(s)} />
      <main className="content">
        {state.selected === 'overview' && <Overview api={api} />}
        {state.selected === 'settings' && <Settings api={api} />}
        {state.selected === null && <p className="empty">{t.noBay}</p>}
        {localBay && localBay.status !== 'connected' && (
          <section className="local-server-down">
            <h1>{localBay.status === 'connecting' ? t.localServerStarting : t.localServerDown}</h1>
            <p>{t.localServerDownHint}</p>
            {localBay.error && <p className="local-server-error">{localBay.error}</p>}
            <div className="local-server-actions">
              <button
                type="button"
                className="button"
                onClick={() => void api.restartLocalServer()}
              >
                {t.restart}
              </button>
              <button type="button" className="button" onClick={() => api.openLocalServerLog()}>
                {t.openLog}
              </button>
            </div>
          </section>
        )}
        {localBay?.status === 'connected' && localBay.update && (
          <UpdateHint
            api={api}
            text={t.updateReady(localBay.update.running, localBay.update.ready)}
            restarting={!!localBay.restarting}
          />
        )}
      </main>
    </div>
  );
}

/** „Neue Version bereit“ above a bay of the local server; as tall as its text needs. */
function UpdateHint({
  api,
  text,
  restarting,
}: {
  api: ShellApi;
  text: string;
  restarting: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const observer = new ResizeObserver(() => api.setHintHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [api]);
  return (
    <section
      ref={ref}
      className="update-hint"
      aria-label={t.updateHint}
      style={{ minHeight: `${UPDATE_HINT_HEIGHT}px` }}
    >
      <p>{text}</p>
      {restarting ? (
        <span role="status">{t.localServerStarting}</span>
      ) : (
        <button type="button" className="button" onClick={() => void api.restartLocalServer()}>
          {t.restartLocalServer}
        </button>
      )}
    </section>
  );
}
