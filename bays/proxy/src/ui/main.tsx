import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {} from '@hangar/sdk'; // declares window.hangar
import type { EngineStatus } from '../main/engine';
import { setLocale, t } from './messages';
import './styles.css';

// A status line until the flow list arrives (ADR 0049, step 5).
function App() {
  const [status, setStatus] = useState<EngineStatus>();
  useEffect(() => {
    // With a local server the bay may not be connected yet: ask again until it answers.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () =>
      window.hangar
        .invoke<EngineStatus>('status')
        .then(setStatus)
        .catch(() => (timer = setTimeout(ask, 2000)));
    void ask();
    const off = window.hangar.on('status', (s) => setStatus(s as EngineStatus));
    return () => {
      clearTimeout(timer);
      off();
    };
  }, []);
  return (
    <main>
      <h1>{t.title}</h1>
      {status && (
        <p role="status">
          {t.engine}: {t.states[status.state]}
          {status.version && ` (${t.version(status.version)})`}
          {status.reason && ` – ${status.reason}`}
        </p>
      )}
    </main>
  );
}

setLocale(window.hangar.locale);
createRoot(document.getElementById('root')!).render(<App />);
