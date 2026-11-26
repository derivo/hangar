import { useEffect, useRef, useState } from 'react';
import { t } from '../messages';
import type { ShellApi, ShellState } from '../shared';

interface Props {
  api: Pick<ShellApi, 'getState' | 'onState' | 'setBayInSidebar'>;
}

/**
 * One switch per found bay of the app (ADR 0050): on puts it into the sidebar and starts it,
 * off removes it like the context menu. Follows the sidebar through `shell:state`.
 */
export function BaySwitches({ api }: Props) {
  const [state, setState] = useState<ShellState>();
  const [error, setError] = useState<string>();
  const busy = useRef(new Set<string>());
  useEffect(() => {
    void api.getState().then(setState);
    return api.onState(setState);
  }, [api]);
  if (!state) return null;

  // Sorted by name, so a row stays where it is when it is switched.
  const bays = [
    ...state.bays.map((b) => ({ ...b, on: true })),
    ...state.available.map((b) => ({ ...b, on: false })),
  ].sort((a, b) => a.name.localeCompare(b.name));

  // One switch per bay at a time until the answer (ADR 0028).
  const toggle = async (id: string, on: boolean) => {
    if (busy.current.has(id)) return;
    busy.current.add(id);
    setError(undefined);
    try {
      await api.setBayInSidebar(id, on);
    } catch (e) {
      setError(
        (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''),
      );
    } finally {
      busy.current.delete(id);
    }
  };

  return (
    <>
      <h3>{t.baysInSidebar}</h3>
      <p className="muted">{t.baysInSidebarHint}</p>
      <ul className="bay-switches">
        {bays.map((bay) => (
          <li key={bay.id}>
            <img src={bay.icon} alt="" />
            <button
              type="button"
              role="switch"
              aria-checked={bay.on}
              className="bay-switch"
              onClick={() => void toggle(bay.id, !bay.on)}
            >
              {bay.name}
              <span className="bay-switch-track" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
