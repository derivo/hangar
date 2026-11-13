import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { BrowserApi } from './api';
import type { BrowserState } from '../main/types';
import { normalizeUrl } from '../main/url';
import { ErrorsPanel } from './ErrorsPanel';
import { FindBar, isModKey } from './FindBar';
import { t } from './messages';

interface Props {
  api: BrowserApi;
}

/** Hangar wraps errors from the main part; people only need the message itself. */
const messageOf = (e: unknown) =>
  String(e instanceof Error ? e.message : e).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );

export function App({ api }: Props) {
  const [state, setState] = useState<BrowserState>({ tabs: [] });
  const [selected, setSelected] = useState<string>();
  /** "New tab": no tab shown, the address bar opens a new one. */
  const [newTab, setNewTab] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const page = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  /** The tab the find bar is open for, and a counter to focus its field again. */
  const [findTab, setFindTab] = useState<string>();
  const [findFocus, setFindFocus] = useState(0);

  useEffect(() => {
    // An event can overtake the first answer; it is newer then.
    let pushed = false;
    void api.state().then((s) => pushed || setState(s));
    return api.onState((s) => {
      pushed = true;
      setState(s);
    });
  }, [api]);

  // The selected tab; the first at start, the last when the selected one closed.
  const current = state.tabs.some((x) => x.id === selected)
    ? selected
    : selected === undefined
      ? state.tabs[0]?.id
      : state.tabs.at(-1)?.id;
  const tab = newTab ? undefined : state.tabs.find((x) => x.id === current);
  const tabId = tab?.id;
  // A page that failed to load gives way to the error page (ADR 0042).
  const shownId = tab?.error ? undefined : tabId;

  const openFind = (id: string | undefined) => {
    if (!id) return;
    setFindTab(id);
    setFindFocus((n) => n + 1);
  };
  useEffect(() => api.onFind(openFind), [api]);
  useEffect(() => {
    const keyDown = (e: KeyboardEvent) => {
      if (!isModKey(e) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'f') return;
      e.preventDefault();
      openFind(tabId);
    };
    window.addEventListener('keydown', keyDown);
    return () => window.removeEventListener('keydown', keyDown);
  }, [tabId]);

  // Another tab closes the find bar for good: it does not come back with the tab (OpenCode).
  const [findOn, setFindOn] = useState(tabId);
  if (tabId !== findOn) {
    setFindOn(tabId);
    setFindTab(undefined);
  }

  // The address bar follows the shown page until the next navigation.
  const shown = `${tabId}|${tab?.url}`;
  const [lastShown, setLastShown] = useState(shown);
  if (shown !== lastShown) {
    setLastShown(shown);
    setDraft(tab?.url ?? '');
    setError(undefined);
  }

  // The page itself is a host view laid over the page area (ADR 0015).
  useLayoutEffect(() => {
    const el = page.current!;
    // A tab closed in the main process is unknown there until the next state arrives: ignore
    // that; anything else is a bug and stays loud.
    const ignore = (e: unknown) => {
      if (!/Unknown tab/.test(String(e))) throw e;
    };
    const place = () => {
      if (!shownId) return void api.show(undefined).catch(ignore);
      const r = el.getBoundingClientRect();
      void api.show(shownId, { x: r.x, y: r.y, width: r.width, height: r.height }).catch(ignore);
    };
    const observer = new ResizeObserver(place);
    observer.observe(el);
    return () => observer.disconnect();
  }, [api, shownId]);

  // Actions still running, by key: pressing the button again before the answer does nothing.
  const pending = useRef(new Set<string>());
  const run = async (action: () => Promise<void>, key?: string) => {
    if (key && pending.current.has(key)) return;
    if (key) pending.current.add(key);
    try {
      await action();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      if (key) pending.current.delete(key);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return setError(t.addressMissing);
    const url = normalizeUrl(draft);
    if (!url) return setError(t.addressInvalid);
    void run(
      async () => {
        if (tab) await api.navigate(tab.id, url);
        else {
          setSelected(await api.open(url));
          setNewTab(false);
        }
      },
      tab ? `navigate:${tab.id}` : 'open',
    );
  };

  const select = (id: string) => {
    setSelected(id);
    setNewTab(false);
  };

  const openNewTab = () => {
    setNewTab(true);
    setDraft('');
    setError(undefined);
    input.current?.focus();
  };

  const status = tab?.loading ? t.loading : '';
  const external = tab && /^https?:\/\//i.test(tab.url) ? tab.url : undefined;

  return (
    <div className="layout">
      <div className="tabbar">
        <ul aria-label={t.tabs} className="tabs">
          {state.tabs.map((x) => {
            const title = x.title || x.url || t.untitled;
            const active = x.id === tab?.id;
            const failed = x.error ? t.tabLoadFailed : x.errors && t.tabErrors(x.errors);
            return (
              <li key={x.id} className={`tab${active ? ' tab-active' : ''}`}>
                <button
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  className="tab-select"
                  onClick={() => select(x.id)}
                >
                  {x.owner === 'agent' && (
                    <span className="agent-mark" title={t.agentTabHint}>
                      {t.agentTab}
                    </span>
                  )}
                  {x.owner === 'agent' && ' '}
                  <span className="tab-title">
                    {title}
                    {/* The space as text: name computations drop it inside the hidden span. */}
                    {failed && ' '}
                    {failed && <span className="visually-hidden">{failed}</span>}
                  </span>
                  {failed && (
                    <span className="tab-errors" aria-hidden="true">
                      {x.error ? '!' : x.errors}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t.closeTab(title)}
                  // The further clicks of a double click (detail 2, 3 …) would hit the next tab.
                  onClick={(e) => e.detail <= 1 && void run(() => api.close(x.id), `close:${x.id}`)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          className="icon-button"
          aria-label={t.newTab}
          title={t.newTab}
          onClick={openNewTab}
        >
          +
        </button>
      </div>
      <form className="toolbar" onSubmit={submit} noValidate>
        <button
          type="button"
          className="icon-button"
          aria-label={t.back}
          title={t.back}
          disabled={!tab?.canGoBack}
          onClick={() => tab && void run(() => api.back(tab.id))}
        >
          ←
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={t.forward}
          title={t.forward}
          disabled={!tab?.canGoForward}
          onClick={() => tab && void run(() => api.forward(tab.id))}
        >
          →
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={t.reload}
          title={t.reload}
          disabled={!tab}
          onClick={() => tab && void run(() => api.reload(tab.id))}
        >
          ↻
        </button>
        <input
          ref={input}
          className="address"
          type="text"
          aria-label={t.address}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'address-error' : undefined}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        {tab?.zoom && (
          <button
            type="button"
            className="button"
            aria-label={t.resetZoom(tab.zoom)}
            title={t.resetZoom(tab.zoom)}
            onClick={() => void run(() => api.resetZoom(tab.id))}
          >
            {tab.zoom} %
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label={t.openExternal}
          title={t.openExternal}
          disabled={!external}
          onClick={() => external && api.openExternal(external)}
        >
          ↗
        </button>
        {tab && (
          <button
            type="button"
            className={`button${tab.errors ? ' error' : ''}`}
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen(!panelOpen)}
          >
            {t.errorsButton(tab.errors ?? 0)}
          </button>
        )}
        <button
          type="submit"
          className="button"
          // Not the second click of a double click: the first one opened the tab (ADR 0028).
          onClick={(e) => e.detail > 1 && e.preventDefault()}
        >
          {t.open}
        </button>
      </form>
      {tab && findTab === tab.id && (
        <FindBar
          api={api}
          tab={tab}
          focusKey={findFocus}
          onClose={() => {
            setFindTab(undefined);
            void run(() => api.focus(tab.id));
          }}
        />
      )}
      <div className="messages">
        {error && (
          <p id="address-error" role="alert" className="error">
            {error}
          </p>
        )}
        {tab?.status !== undefined && tab.status >= 400 && (
          <p className="error">{t.httpStatus(tab.status)}</p>
        )}
        <p role="status" className="muted">
          {status}
        </p>
      </div>
      <div className="main">
        <div ref={page} id="page" className="page">
          {!tab && <p className="muted empty">{t.empty}</p>}
          {tab?.error && (
            <div role="alert" className="load-error">
              <h2 className="error">{t.loadFailedTitle}</h2>
              <p className="error">{tab.error}</p>
              {tab.error.startsWith('ERR_CERT_') && <p>{t.certHint}</p>}
              <p className="muted">{tab.url}</p>
              {tab.certificate && (
                <>
                  <p className="muted">
                    {t.certificate(tab.certificate.host, tab.certificate.fingerprint)}
                  </p>
                  <p>{t.trustHint}</p>
                </>
              )}
              <p className="actions">
                <button
                  type="button"
                  className="button"
                  onClick={() => void run(() => api.reload(tab.id))}
                >
                  {t.reload}
                </button>
                {tab.certificate && (
                  <button
                    type="button"
                    className="button"
                    // Host and fingerprint shown here: the click trusts only those (Codex).
                    onClick={() =>
                      void run(
                        () => api.trustCertificate(tab.id, tab.certificate!),
                        `trust:${tab.id}`,
                      )
                    }
                  >
                    {t.trustHost}
                  </button>
                )}
                {external && (
                  <button
                    type="button"
                    className="button"
                    onClick={() => api.openExternal(external)}
                  >
                    {t.openExternal}
                  </button>
                )}
              </p>
            </div>
          )}
        </div>
        {tab && panelOpen && <ErrorsPanel api={api} tab={tab} />}
      </div>
    </div>
  );
}
