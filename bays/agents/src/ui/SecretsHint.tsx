import { useEffect, useState } from 'react';
import type { AgentsApi } from './api';
import { t } from './messages';

/** Which passwords a variable can refer to, below an env editor (ADR 0021). */
export function SecretsHint({ api, id }: { api: Pick<AgentsApi, 'secrets'>; id: string }) {
  const [names, setNames] = useState<string[] | null>();
  useEffect(() => {
    let live = true;
    // No answer (the server's connection closed): no hint rather than a wrong one.
    api.secrets().then(
      (s) => live && setNames(s && s.map((x) => x.name)),
      () => {},
    );
    return () => void (live = false);
  }, [api]);
  if (names === undefined) return null;
  return (
    <p id={id} className="muted">
      {names === null
        ? t.secretsMissing
        : names.length === 0
          ? t.secretsEmpty
          : t.secretsAvailable(names.join(', '))}
    </p>
  );
}
