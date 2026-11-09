import { describe, expect, it } from 'vitest';
import { IDLE_AFTER_MS, afterOutput, afterQuiet, isSessionStatus } from './status';

describe('status heuristic', () => {
  it('turns idle into working on output and leaves reported states alone', () => {
    expect(afterOutput('idle')).toBe('working');
    expect(afterOutput('working')).toBe('working');
    expect(afterOutput('waiting')).toBe('waiting');
    expect(afterOutput('done')).toBe('done');
  });

  it('falls back to idle after 30 s without output, only from working', () => {
    expect(IDLE_AFTER_MS).toBe(30_000);
    expect(afterQuiet('working', 0, 29_999)).toBe('working');
    expect(afterQuiet('working', 0, 30_000)).toBe('idle');
    expect(afterQuiet('waiting', 0, 60_000)).toBe('waiting');
    expect(afterQuiet('done', 0, 60_000)).toBe('done');
  });

  it('recognises valid statuses', () => {
    expect(['working', 'waiting', 'done', 'idle'].every(isSessionStatus)).toBe(true);
    expect(isSessionStatus('busy')).toBe(false);
    expect(isSessionStatus(3)).toBe(false);
  });
});
