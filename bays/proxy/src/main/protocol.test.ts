import { Protocol, type AddonEvent } from './protocol';

function setup(opts: { writable?: () => boolean; maxLines?: number; maxBytes?: number } = {}) {
  const written: string[] = [];
  const events: AddonEvent[] = [];
  const protocol = new Protocol(
    (line) => {
      written.push(line);
      return opts.writable ? opts.writable() : true;
    },
    (e) => events.push(e),
    { maxLines: opts.maxLines, maxBytes: opts.maxBytes },
  );
  const sent = () => written.map((l) => JSON.parse(l) as { id: number; op: string });
  return { protocol, written, events, sent };
}

afterEach(() => vi.useRealTimers());

describe('Protocol', () => {
  it('sends a command as one JSON line and resolves with its reply', async () => {
    const { protocol, written, sent } = setup();
    const done = protocol.request('listen', { port: 4000, password: 'pw' });
    expect(written[0]).toMatch(/\n$/);
    expect(sent()[0]).toEqual({ id: 1, op: 'listen', port: 4000, password: 'pw' });
    protocol.receive('{"type":"reply","id":1,"ok":true}\n');
    await expect(done).resolves.toBeUndefined();
  });

  it('rejects with the error of a failed reply', async () => {
    const { protocol } = setup();
    const done = protocol.request('listen', { port: 4000 });
    protocol.receive('{"type":"reply","id":1,"ok":false,"error":"address in use"}\n');
    await expect(done).rejects.toThrow('address in use');
  });

  it('gives up after 5 s and counts a late reply as unknown', async () => {
    vi.useFakeTimers();
    const { protocol } = setup();
    const done = protocol.request('capture', { on: false });
    const check = expect(done).rejects.toThrow('capture: no answer within 5 s');
    await vi.advanceTimersByTimeAsync(5000);
    await check;
    protocol.receive('{"type":"reply","id":1,"ok":true}\n');
    expect(protocol.warnings.unknown).toBe(1);
  });

  it('joins lines split across chunks and hands events on', () => {
    const { protocol, events } = setup();
    protocol.receive('{"type":"hello","ver');
    protocol.receive('sion":"12.3.1"}\n{"type":"flow.error","id":"a","error":"x"}\r\n');
    expect(events).toEqual([
      { type: 'hello', version: '12.3.1' },
      { type: 'flow.error', id: 'a', error: 'x' },
    ]);
  });

  it('counts broken and unknown lines as warnings, never throws', () => {
    const { protocol, events } = setup();
    protocol.receive('not json\n[1]\n{"type":"nope"}\n\n{"type":"dropped","count":3}\n');
    expect(events).toEqual([]);
    expect(protocol.warnings).toEqual({ broken: 2, unknown: 1, overflow: 0, dropped: 3 });
    protocol.receive('{"type":"warning","message":"broken command line"}\n');
    expect(protocol.warnings.broken).toBe(3);
  });

  it('drops an incoming line above the byte limit up to its end', () => {
    const { protocol, events } = setup({ maxBytes: 64 });
    protocol.receive(`{"type":"hello","version":"${'x'.repeat(40)}`);
    protocol.receive(`${'y'.repeat(40)}`);
    protocol.receive('"}\n{"type":"hello","version":"1"}\n');
    expect(events).toEqual([{ type: 'hello', version: '1' }]);
    expect(protocol.warnings.broken).toBe(1);
  });

  it('queues commands while the pipe is full and sends them on drain', async () => {
    let free = false;
    const { protocol, written } = setup({ writable: () => free });
    void protocol.request('capture', { on: true });
    void protocol.request('capture', { on: false });
    expect(written).toHaveLength(1);
    free = true;
    protocol.drain();
    expect(written).toHaveLength(2);
  });

  it('refuses commands beyond the queue limit by lines', async () => {
    const { protocol } = setup({ writable: () => false, maxLines: 2 });
    void protocol.request('capture', { on: true }); // written, pipe now full
    void protocol.request('capture', { on: true });
    void protocol.request('capture', { on: true });
    await expect(protocol.request('capture', { on: true })).rejects.toThrow(
      'command queue is full',
    );
    expect(protocol.warnings.overflow).toBe(1);
  });

  it('refuses commands beyond the queue limit by bytes', async () => {
    const { protocol } = setup({ writable: () => false, maxBytes: 100 });
    void protocol.request('capture', { on: true });
    void protocol.request('ignore', { hosts: ['a'.repeat(40)] });
    await expect(protocol.request('ignore', { hosts: ['b'.repeat(40)] })).rejects.toThrow(
      'command queue is full',
    );
    expect(protocol.warnings.overflow).toBe(1);
  });

  it('never sends a queued command after its timeout', async () => {
    vi.useFakeTimers();
    let free = false;
    const { protocol, written } = setup({ writable: () => free });
    void protocol.request('capture', { on: true }).catch(() => {});
    const late = protocol.request('listen', { port: 4000 });
    const check = expect(late).rejects.toThrow('listen: no answer within 5 s');
    await vi.advanceTimersByTimeAsync(5000);
    await check;
    free = true;
    protocol.drain();
    expect(written.map((l) => JSON.parse(l).op)).toEqual(['capture']);
  });

  it('drops a complete incoming line above the byte limit', () => {
    const { protocol, events } = setup({ maxBytes: 40 });
    protocol.receive(
      `{"type":"hello","version":"${'x'.repeat(40)}"}\n{"type":"hello","version":"1"}\n`,
    );
    expect(events).toEqual([{ type: 'hello', version: '1' }]);
    expect(protocol.warnings.broken).toBe(1);
  });

  it('rejects everything open when closed, and later requests at once', async () => {
    const { protocol } = setup({ writable: () => false });
    const first = protocol.request('capture', { on: true });
    const queued = protocol.request('capture', { on: true });
    protocol.close('engine stopped');
    await expect(first).rejects.toThrow('engine stopped');
    await expect(queued).rejects.toThrow('engine stopped');
    await expect(protocol.request('capture', { on: true })).rejects.toThrow('engine stopped');
  });
});
