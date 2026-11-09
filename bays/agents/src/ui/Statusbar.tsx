import type { StatusbarSegment } from '../main/types';
import { t } from './messages';

/** Number of cells in a bar segment's gauge. */
const GAUGE_CELLS = 10;

/** A session's status bar (spec §6): segments set by agents via MCP or the CLI. */
export function Statusbar({ segments }: { segments: StatusbarSegment[] }) {
  if (segments.length === 0) return null;
  return (
    <div className="statusbar" role="group" aria-label={t.statusbar}>
      {segments.map((s) => (
        <span key={s.key} className={`segment segment-type-${s.type}`}>
          <span className="segment-key">{s.key}</span>
          <SegmentValue segment={s} />
        </span>
      ))}
    </div>
  );
}

function SegmentValue({ segment: s }: { segment: StatusbarSegment }) {
  switch (s.type) {
    case 'path':
      return (
        <span className="segment-value segment-path" title={s.value}>
          {s.value}
        </span>
      );
    case 'bar': {
      const value = Number(s.value) || 0;
      const max = s.max ?? 100;
      const lit = Math.round((Math.min(Math.max(value, 0), max) / max) * GAUGE_CELLS);
      return (
        <>
          {/* Segmented gauge instead of <meter>, which cannot be styled like this. */}
          <span
            className="gauge"
            role="meter"
            aria-label={s.key}
            aria-valuemin={0}
            aria-valuemax={max}
            aria-valuenow={value}
          >
            {Array.from({ length: GAUGE_CELLS }, (_, i) => (
              <i key={i} className={i < lit ? 'on' : undefined} />
            ))}
          </span>
          <span className="segment-value">
            {value} / {max}
          </span>
        </>
      );
    }
    case 'badge':
      return <span className="segment-badge chamfer">{s.value}</span>;
    default:
      return <span className="segment-value">{s.value}</span>;
  }
}
