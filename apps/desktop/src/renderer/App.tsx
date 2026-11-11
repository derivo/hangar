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
  const server = state.servers.find((s) => s.bays.some((b) => b.id === state.selected));
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
            <p role="status" className="local-server-retry">
              {localBay.retry !== undefined && t.reconnecting(localBay.retry)}
            </p>
            {localBay.log && <ServerLog lines={localBay.log} />}
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
        {server?.update && (
          <UpdateHint
            api={api}
            text={t.serverUpdateReady(server.name, server.update.running, server.update.ready)}
            restarting={!!server.restarting}
            server={server.id}
          />
        )}
      </main>
    </div>
  );
}

/**
 * The local server's log like `tail -f`: new lines at the bottom, followed while scrolled to
 * the end. Pausing holds the lines shown (WCAG 2.2.2).
 */
function ServerLog({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  const atEnd = useRef(true);
  const [held, setHeld] = useState<string[]>();
  const shown = held ?? lines;
  useEffect(() => {
    const el = ref.current!;
    if (atEnd.current) el.scrollTop = el.scrollHeight;
  }, [shown]);
  return (
    <>
      <button
        type="button"
        className="button local-server-log-pause"
        aria-pressed={!!held}
        onClick={() => setHeld(held ? undefined : lines)}
      >
        {t.pauseLog}
      </button>
      {/* Focusable: the region scrolls, also by keyboard. */}
      <pre
        ref={ref}
        role="log"
        aria-label={t.localServerLog}
        tabIndex={0}
        className="local-server-log"
        onScroll={(e) => {
          const el = e.currentTarget;
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 2;
        }}
      >
        {shown.length > 0 ? shown.join('\n') : t.localServerLogEmpty}
      </pre>
    </>
  );
}

/**
 * „Neue Version bereit“ above a bay of the local server, or of the server set up over SSH with
 * the id `server` (ADR 0041); as tall as its text needs.
 */
function UpdateHint({
  api,
  text,
  restarting,
  server,
}: {
  api: ShellApi;
  text: string;
  restarting: boolean;
  server?: string;
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
        <span role="status">{server ? t.serverRestarting : t.localServerStarting}</span>
      ) : (
        <button
          type="button"
          className="button"
          onClick={() => void (server ? api.restartServer(server) : api.restartLocalServer())}
        >
          {server ? t.restartServer : t.restartLocalServer}
        </button>
      )}
    </section>
  );
}
