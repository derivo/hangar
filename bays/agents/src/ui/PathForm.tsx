import { useEffect, useId, useRef, useState } from 'react';
import { errorMessage } from './api';
import { t } from './messages';

interface Props {
  /** Name of the server the bay runs on. */
  server: string;
  add(path: string): Promise<unknown>;
  onDone(): void;
}

/** Adds a project on a server by path: there is no folder dialog there (ADR 0018). */
export function PathForm({ server, add, onDone }: Props) {
  const [path, setPath] = useState('');
  const [error, setError] = useState<string>();
  // While the server answers the path stays as sent and is sent once.
  const [busy, setBusy] = useState(false);
  const open = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    // Back to where the form was opened from (the "+" in the tree).
    const opener = document.activeElement as HTMLElement | null;
    open.current = true;
    input.current?.focus();
    return () => {
      // A late answer belongs to this form only, not to one opened again.
      open.current = false;
      opener?.focus();
    };
  }, []);

  const submit = async () => {
    if (busy) return;
    const value = path.trim();
    if (!value) return setError(t.enterPath);
    setBusy(true);
    try {
      await add(value);
      if (open.current) onDone();
    } catch (e) {
      if (open.current) setError(errorMessage(e));
    } finally {
      if (open.current) setBusy(false);
    }
  };

  return (
    <form
      className="env-editor"
      aria-label={t.addProject}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDone();
      }}
    >
      <label className="job-field">
        {t.pathOn(server)}
        <input
          ref={input}
          value={path}
          readOnly={busy}
          spellCheck={false}
          placeholder="/home/…/projekt"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => {
            setPath(e.target.value);
            setError(undefined);
          }}
        />
      </label>
      {error && (
        <p id={`${id}-error`} className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="env-actions">
        <button type="submit" className="button button-primary" aria-disabled={busy}>
          {t.add}
        </button>
        <button type="button" className="button" onClick={onDone}>
          {t.cancel}
        </button>
      </div>
    </form>
  );
}
