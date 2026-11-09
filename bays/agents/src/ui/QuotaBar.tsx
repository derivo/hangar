import { useEffect, useState } from 'react';
import { QUOTA_PROVIDERS, type QuotaProvider, type Quotas, type QuotaWindow } from '../main/types';
import { t } from './messages';

const GAUGE_CELLS = 10;
const NAMES: Record<QuotaProvider, string> = { claude: 'Claude', codex: 'Codex' };

/** Share free and reset text of one window; a window whose reset has passed starts over. */
function windowState({ usedPercent, resetsAt }: QuotaWindow, now: number, date: boolean) {
  const over = resetsAt !== undefined && resetsAt * 1000 <= now;
  const left = over ? 100 : Math.round(100 - Math.min(Math.max(usedPercent, 0), 100));
  const at = new Date((resetsAt ?? 0) * 1000);
  const reset =
    !over && resetsAt !== undefined ? (date ? t.quotaResetDate(at) : t.quotaReset(at)) : '';
  return { left, reset, text: [t.quotaLeft(left), reset].filter(Boolean).join(', ') };
}

/** Footer with what is left of Claude's and Codex's 5-hour and weekly limit (ADR 0024). */
export function QuotaBar({
  api,
  now = Date.now,
}: {
  api: { quota(): Promise<Quotas>; onQuota(l: (q: Quotas) => void): () => void };
  now?: () => number;
}) {
  const [quotas, setQuotas] = useState<Quotas>({});
  useEffect(() => {
    api.quota().then(setQuotas, () => {});
    return api.onQuota(setQuotas);
  }, [api]);
  // A reset passes without new values: check the time once a minute.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  const shown = QUOTA_PROVIDERS.filter((p) => quotas[p]);
  if (shown.length === 0) return null;
  return (
    <footer className="quota-bar" role="group" aria-label={t.quotas}>
      {shown.map((provider) => {
        // Codex's log may be older than a reset.
        const quota = quotas[provider]!;
        const { left, reset, text } = windowState(quota, now(), false);
        const week = quota.week && windowState(quota.week, now(), true);
        const lit = Math.round((left / 100) * GAUGE_CELLS);
        return (
          <span key={provider} className="quota">
            <span className="quota-name">{NAMES[provider]}</span>
            <span className="quota-window">5h</span>
            <span
              className="gauge"
              role="meter"
              aria-label={`${NAMES[provider]} 5h`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={left}
              aria-valuetext={text}
            >
              {Array.from({ length: GAUGE_CELLS }, (_, i) => (
                <i key={i} className={i < lit ? 'on' : undefined} />
              ))}
            </span>
            <span className="quota-left">{t.quotaLeft(left)}</span>
            {reset && <span className="quota-reset">{reset}</span>}
            {week && (
              <span
                className="quota-week"
                role="meter"
                aria-label={`${NAMES[provider]} 7d`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={week.left}
                aria-valuetext={week.text}
              >
                <span className="quota-window">7d</span>
                <span className="quota-left">{t.quotaLeft(week.left)}</span>
                {week.reset && <span className="quota-reset">{week.reset}</span>}
              </span>
            )}
          </span>
        );
      })}
    </footer>
  );
}
