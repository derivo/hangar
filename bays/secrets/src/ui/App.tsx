import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { SecretsApi } from './api';
import type { SecretInfo } from '../main/vault';
import { t } from './messages';

/** Hangar wraps errors from the main part; people only need the message itself. */
const messageOf = (e: unknown) =>
  String(e instanceof Error ? e.message : e).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );

export function App({ api }: { api: SecretsApi }) {
  const [entries, setEntries] = useState<SecretInfo[]>();
  const [status, setStatus] = useState('');

  useEffect(() => {
    let pushed = false;
    void api.list().then((s) => pushed || setEntries(s));
    return api.onState((s) => {
      pushed = true;
      setEntries(s);
    });
  }, [api]);

  return (
    <main className="layout">
      <h1>{t.title}</h1>
      <p className="muted">{t.intro}</p>
      <AddForm api={api} onSaved={(name) => setStatus(t.saved(name))} />
      <p role="status" className="muted">
        {status}
      </p>
      {entries?.length === 0 && <p className="muted">{t.empty}</p>}
      <ul className="entries">
        {entries?.map((e) => (
          <Entry key={e.name} api={api} entry={e} onSaved={(name) => setStatus(t.saved(name))} />
        ))}
      </ul>
    </main>
  );
}

function AddForm({ api, onSaved }: { api: SecretsApi; onSaved: (name: string) => void }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError(t.nameMissing);
    if (!value) return setError(t.valueMissing);
    try {
      await api.save({ name: name.trim(), value, description: description.trim() });
      setName('');
      setValue('');
      setDescription('');
      setError('');
      onSaved(name.trim());
    } catch (err) {
      setError(messageOf(err));
    }
  };

  return (
    <form className="add" aria-label={t.add} onSubmit={(e) => void submit(e)} noValidate>
      <h2>{t.add}</h2>
      <label>
        {t.name}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-describedby="name-hint"
        />
      </label>
      <span id="name-hint" className="muted hint">
        {t.nameHint}
      </span>
      <label>
        {t.value}
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="new-password"
        />
      </label>
      <label>
        {t.description}
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={200}
        />
      </label>
      <button
        className="button"
        type="submit"
        // Not the second click of a double click: the first one saved (ADR 0028).
        onClick={(e) => e.detail > 1 && e.preventDefault()}
      >
        {t.save}
      </button>
      <p role="alert" className="error">
        {error}
      </p>
    </form>
  );
}

function Entry({
  api,
  entry,
  onSaved,
}: {
  api: SecretsApi;
  entry: SecretInfo;
  onSaved: (name: string) => void;
}) {
  const [replacing, setReplacing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const replaceButton = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (replacing) field.current?.focus();
  }, [replacing]);

  const close = () => {
    setReplacing(false);
    setValue('');
    setError('');
    // Focus back where it was, after the field is gone.
    setTimeout(() => replaceButton.current?.focus());
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value) return setError(t.valueMissing);
    try {
      await api.save({ name: entry.name, value, description: entry.description });
      close();
      onSaved(entry.name);
    } catch (err) {
      setError(messageOf(err));
    }
  };
  const escape = (e: KeyboardEvent) => e.key === 'Escape' && close();
  const remove = () => {
    if (window.confirm(t.confirmRemove(entry.name))) void api.remove(entry.name);
  };

  return (
    <li className="entry">
      <div className="entry-head">
        <code className="entry-name">{entry.name}</code>
        <span className="muted">{entry.description}</span>
        <span className="muted entry-date">
          {t.changed(new Date(entry.updatedAt).toLocaleString())}
        </span>
        <button
          ref={replaceButton}
          className="button"
          type="button"
          aria-label={t.replaceLabel(entry.name)}
          aria-expanded={replacing}
          onClick={() => setReplacing(true)}
        >
          {t.replace}
        </button>
        <button
          className="button"
          type="button"
          aria-label={t.removeLabel(entry.name)}
          onClick={(e) => e.detail < 2 && remove()}
        >
          {t.remove}
        </button>
      </div>
      {replacing && (
        <form className="replace" onSubmit={(e) => void submit(e)} onKeyDown={escape} noValidate>
          <label>
            {t.newValue(entry.name)}
            <input
              ref={field}
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <button
            className="button"
            type="submit"
            // Not the second click of a double click: the first one saved (ADR 0028).
            onClick={(e) => e.detail > 1 && e.preventDefault()}
          >
            {t.save}
          </button>
          <button className="button" type="button" onClick={close}>
            {t.cancel}
          </button>
          <p role="alert" className="error">
            {error}
          </p>
        </form>
      )}
    </li>
  );
}
