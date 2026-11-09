import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { BrowserApi } from './api';
import type { BrowserState } from '../main/types';
import { normalizeUrl } from '../main/url';
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
      if (!tabId) return void api.show(undefined).catch(ignore);
      const r = el.getBoundingClientRect();
      void api.show(tabId, { x: r.x, y: r.y, width: r.width, height: r.height }).catch(ignore);
    };
    const observer = new ResizeObserver(place);
    observer.observe(el);
    return () => observer.disconnect();
  }, [api, tabId]);

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

  const status = tab?.error ? t.loadFailed(tab.error) : tab?.loading ? t.loading : '';

  return (
    <div className="layout">
      <div className="tabbar">
        <ul aria-label={t.tabs} className="tabs">
          {state.tabs.map((x) => {
            const title = x.title || x.url || t.untitled;
            const active = x.id === tab?.id;
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
                  <span className="tab-title">{title}</span>
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
          type="submit"
          className="button"
          // Not the second click of a double click: the first one opened the tab (ADR 0028).
          onClick={(e) => e.detail > 1 && e.preventDefault()}
        >
          {t.open}
        </button>
      </form>
      <div className="messages">
        {error && (
          <p id="address-error" role="alert" className="error">
            {error}
          </p>
        )}
        <p role="status" className="muted">
          {status}
        </p>
      </div>
      <div ref={page} id="page" className="page">
        {!tab && <p className="muted empty">{t.empty}</p>}
      </div>
    </div>
  );
}
