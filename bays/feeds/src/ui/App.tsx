import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { FeedSettings, FeedState, Item } from '../main/feeds';
import { errorMessage, type FeedsApi } from './api';
import { t } from './messages';
import { parseFeed } from './parse';

// ponytail: one interval for all feeds (bay settings); per-feed TTL if anyone needs it.

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'full' });
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { timeStyle: 'short' });
const stamp = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Subscriptions on top, below their entries as one history, newest last – like a chat. */
export function App({ api }: { api: FeedsApi }) {
  const [state, setState] = useState<FeedState>();
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const gear = useRef<HTMLButtonElement>(null);
  const running = useRef(new Set<string>());
  const log = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);

  /** Fetches and parses each feed; one at a time per feed. */
  const refresh = useCallback(
    (urls: string[]) =>
      Promise.all(
        urls
          .filter((u) => !running.current.has(u))
          .map(async (u) => {
            running.current.add(u);
            try {
              await api.ingest(u, parseFeed(await api.fetch(u), u));
            } catch (e) {
              await api.failed(u, errorMessage(e)).catch(() => {});
            } finally {
              running.current.delete(u);
            }
          }),
      ),
    [api],
  );

  useEffect(() => {
    const off = api.onState(setState);
    void api.state().then((s) => {
      setState(s);
      void refresh(s.feeds.map((f) => f.url));
    });
    return off;
  }, [api, refresh]);

  // Every `minutes` (setting "Abruf-Intervall"); a change restarts the timer.
  const minutes = state?.settings.intervalMinutes;
  useEffect(() => {
    if (!minutes) return;
    const timer = setInterval(
      () => void api.state().then((s) => refresh(s.feeds.map((f) => f.url))),
      minutes * 60_000,
    );
    return () => clearInterval(timer);
  }, [api, refresh, minutes]);

  // New subscriptions, also from agents (feed.add), are fetched at once.
  const feeds = state?.feeds ?? [];
  const items = state?.items ?? [];
  useEffect(() => {
    void refresh((state?.feeds ?? []).filter((f) => !f.fetchedAt).map((f) => f.url));
  }, [state?.feeds, refresh]);

  // Like a chat: stay at the newest entry unless the person scrolled up. The newest entry, not
  // the count: a full history keeps its length.
  const newest = items.at(-1);
  useLayoutEffect(() => {
    const el = log.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [newest]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.add(url);
      setUrl('');
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <main className="layout">
      <header className="head">
        <h1>{t.title}</h1>
        <form className="add" aria-label={t.subscribe} onSubmit={add} noValidate>
          <input
            type="url"
            aria-label={t.url}
            placeholder="https://example.org/feed.xml"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="button button-primary" type="submit">
            {t.add}
          </button>
          <button
            className="button"
            type="button"
            onClick={() => void refresh(feeds.map((f) => f.url))}
          >
            {t.refresh}
          </button>
        </form>
        <button
          ref={gear}
          className="button button-quiet gear"
          type="button"
          aria-label={t.settings}
          title={t.settings}
          disabled={!state}
          onClick={() => setEditing(true)}
        >
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <circle cx="12" cy="12" r="7" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
          </svg>
        </button>
        <p className="error" role="alert">
          {error}
        </p>
      </header>

      {feeds.length === 0 ? (
        <p className="muted">{t.empty}</p>
      ) : (
        <ul className="feeds" aria-label={t.subscriptions}>
          {feeds.map((f) => (
            <li key={f.url} className={f.error ? 'feed feed-error' : 'feed'} title={f.url}>
              <span>{f.error ? t.failed(f.title, f.error) : f.title}</span>
              <button
                className="button button-quiet"
                type="button"
                aria-label={t.remove(f.title)}
                onClick={() => void api.remove(f.url)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div
        className="log"
        role="log"
        aria-label={t.history}
        tabIndex={0}
        ref={log}
        onScroll={(e) => {
          const el = e.currentTarget;
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {items.length === 0 ? <p className="muted">{t.noItems}</p> : <ol>{entries(items)}</ol>}
      </div>
      <p className="muted hint">{t.hint}</p>
      {editing && state && (
        <SettingsDialog
          settings={state.settings}
          save={api.saveSettings}
          close={() => {
            setEditing(false);
            gear.current?.focus();
          }}
        />
      )}
    </main>
  );
}

/** Modal with the bay's own settings; main validates, its message shows in the dialog. */
function SettingsDialog({
  settings,
  save,
  close,
}: {
  settings: FeedSettings;
  save: (s: FeedSettings) => Promise<void>;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const [minutes, setMinutes] = useState(String(settings.intervalMinutes));
  const [maxItems, setMaxItems] = useState(String(settings.maxItems));
  const [error, setError] = useState('');

  const open = useRef(true);
  useEffect(() => {
    dialog.current?.showModal();
    first.current?.focus();
    return () => void (open.current = false);
  }, []);
  // The page outside is inert until the modal closes; only then can the gear take focus.
  const done = () => {
    dialog.current?.close();
    close();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      // Empty stays empty (NaN), so main rejects it instead of reading 0.
      await save({ intervalMinutes: Number(minutes || NaN), maxItems: Number(maxItems || NaN) });
      // Closed meanwhile: a dialog opened since is not this one's to close.
      if (open.current) done();
    } catch (err) {
      if (open.current) setError(errorMessage(err));
    }
  };

  return (
    <dialog
      ref={dialog}
      className="settings"
      aria-modal="true"
      aria-labelledby="settings-title"
      // The backdrop belongs to the dialog element; its content sits in the inner form.
      onClick={(e) => e.target === e.currentTarget && done()}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        done();
      }}
    >
      <form aria-label={t.settingsForm} onSubmit={submit} noValidate>
        <h2 id="settings-title">{t.settings}</h2>
        <fieldset>
          <legend>{t.fetching}</legend>
          <label htmlFor="settings-interval">{t.interval}</label>
          <input
            id="settings-interval"
            ref={first}
            type="number"
            min={1}
            max={1440}
            aria-describedby="settings-interval-hint"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
          <p id="settings-interval-hint" className="muted hint">
            {t.intervalHint}
          </p>
        </fieldset>
        <fieldset>
          <legend>{t.history}</legend>
          <label htmlFor="settings-max">{t.maxItems}</label>
          <input
            id="settings-max"
            type="number"
            min={100}
            max={10000}
            aria-describedby="settings-max-hint"
            value={maxItems}
            onChange={(e) => setMaxItems(e.target.value)}
          />
          <p id="settings-max-hint" className="muted hint">
            {t.maxItemsHint}
          </p>
        </fieldset>
        <p className="error" role="alert">
          {error}
        </p>
        <div className="actions">
          <button className="button" type="button" onClick={done}>
            {t.cancel}
          </button>
          <button className="button button-primary" type="submit">
            {t.save}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** The entries in the order they arrived, with a day line where the arrival day changes. */
function entries(items: Item[]) {
  return items.flatMap((item, i) => {
    const prev = items[i - 1];
    const newDay = !prev || day(prev.receivedAt) !== day(item.receivedAt);
    const entry = (
      <li key={`${item.feedUrl}\n${item.id}`} className="entry">
        <article>
          <p className="meta">
            <span className="source">{item.feedTitle}</span>{' '}
            {item.published ? (
              <time dateTime={item.published}>{stamp(item.published)}</time>
            ) : (
              <time dateTime={item.receivedAt}>{time(item.receivedAt)}</time>
            )}
          </p>
          {item.link ? (
            <a href={item.link} target="_blank" rel="noreferrer">
              {item.title}
            </a>
          ) : (
            <strong>{item.title}</strong>
          )}
          {item.summary && <p className="summary">{item.summary}</p>}
        </article>
      </li>
    );
    return newDay
      ? [
          <li key={`day-${i}`} className="day">
            {day(item.receivedAt)}
          </li>,
          entry,
        ]
      : [entry];
  });
}
