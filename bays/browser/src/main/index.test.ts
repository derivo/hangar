import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BayContext } from '@hangar/sdk';
import bay from './index';
import { fakeContext } from './test-ctx';
import type { BrowserState } from './types';

async function setup(dataDir?: string) {
  const fake = fakeContext(dataDir);
  await bay.activate(fake.ctx);
  return fake;
}

const lastState = (fake: Awaited<ReturnType<typeof setup>>) =>
  fake.ctx.ui.send.mock.calls.filter(([c]) => c === 'state').at(-1)![1] as BrowserState;

describe('browser bay: agents', () => {
  it('opens a tab in a partition of its own per session and returns the tab', async () => {
    const fake = await setup();
    const tab = await fake.call('tab.open', { url: 'localhost:5173' }, fake.session('s1'));

    expect(tab).toMatchObject({ id: 't1', url: 'http://localhost:5173' });
    expect(fake.browser.open).toHaveBeenCalledWith('http://localhost:5173', {
      partition: 'session-dev.hangar.agents-s1',
    });
    await fake.call('tab.open', { url: 'https://a.test' }, fake.session('s2'));
    expect(fake.browser.open).toHaveBeenLastCalledWith('https://a.test', {
      partition: 'session-dev.hangar.agents-s2',
    });
  });

  it('reaches only its own tabs', async () => {
    const fake = await setup();
    await fake.call('tab.open', { url: 'https://a.test' }, fake.session('s1'));
    await fake.call('tab.open', { url: 'https://b.test' }, fake.session('s2'));
    await fake.invoke('tab.open', 'https://user.test');

    expect(await fake.call('tab.list', {}, fake.session('s1'))).toEqual([
      expect.objectContaining({ id: 't1', url: 'https://a.test' }),
    ]);
    for (const [name, args] of [
      ['tab.navigate', { id: 't2', url: 'https://x.test' }],
      ['tab.close', { id: 't2' }],
      ['page.text', { id: 't3' }],
      ['page.click', { id: 't2', selector: 'a' }],
      ['page.fill', { id: 't2', selector: 'input', value: 'x' }],
      ['page.screenshot', { id: 't3' }],
    ] as const) {
      await expect(fake.call(name, args, fake.session('s1'))).rejects.toThrow('Unknown tab "');
    }
    expect(fake.tabs.size).toBe(3);
  });

  it('gives tabs opened by a page to the owner of the opener', async () => {
    const fake = await setup();
    await fake.call('tab.open', { url: 'https://a.test' }, fake.session('s1'));
    fake.popup('t1', 'https://popup.test');

    expect(await fake.call('tab.list', {}, fake.session('s1'))).toHaveLength(2);
    expect(lastState(fake).tabs.map((t) => t.owner)).toEqual(['agent', 'agent']);
  });

  it('navigates and closes its tabs', async () => {
    const fake = await setup();
    await fake.call('tab.open', { url: 'https://a.test' }, fake.session('s1'));

    expect(
      await fake.call('tab.navigate', { id: 't1', url: 'b.test' }, fake.session('s1')),
    ).toMatchObject({
      url: 'https://b.test',
    });
    expect(await fake.call('tab.close', { id: 't1' }, fake.session('s1'))).toEqual({ ok: true });
    expect(fake.tabs.size).toBe(0);
  });

  it('rejects addresses it does not load and invalid arguments with exact texts', async () => {
    const fake = await setup();
    await expect(
      fake.call('tab.open', { url: 'file:///etc/passwd' }, fake.session('s1')),
    ).rejects.toThrow('Only http and https addresses can be opened: file:///etc/passwd');
    await expect(fake.call('tab.open', {}, fake.session('s1'))).rejects.toThrow(
      'Invalid arguments: url: Invalid input: expected string, received undefined',
    );
    await expect(fake.call('page.click', { id: 't1' }, fake.session('s1'))).rejects.toThrow(
      'Invalid arguments: selector:',
    );
  });

  it('closes the tabs of a session when it ends, and only those (ADR 0016)', async () => {
    const fake = await setup();
    await fake.call('tab.open', { url: 'https://a.test' }, fake.session('s1'));
    fake.popup('t1', 'https://popup.test');
    await fake.call('tab.open', { url: 'https://b.test' }, fake.session('s2'));
    await fake.invoke('tab.open', 'https://user.test');

    fake.endSession('s1');
    expect([...fake.tabs.keys()]).toEqual(['t3', 't4']);
    fake.endSession('s9');
    fake.endSession('s2', 'dev.other.bay');
    expect(fake.tabs.size).toBe(2);
  });

  it('lets bays use the browser too, in a partition per bay', async () => {
    const fake = await setup();
    await fake.call(
      'tab.open',
      { url: 'https://a.test' },
      { caller: { kind: 'bay', bayId: 'x.y' } },
    );

    expect(fake.browser.open).toHaveBeenCalledWith('https://a.test', { partition: 'bay-x.y' });
  });

  it('reads text, clicks and fills via scripts in the page', async () => {
    const fake = await setup();
    await fake.call('tab.open', { url: 'https://a.test' }, fake.session('s1'));
    const s1 = fake.session('s1');

    fake.tabs.get('t1')!.result = 'Hello';
    expect(await fake.call('page.text', { id: 't1' }, s1)).toEqual({
      text: 'Hello',
      truncated: false,
    });
    fake.tabs.get('t1')!.result = 'x'.repeat(100_001);
    expect(await fake.call('page.text', { id: 't1' }, s1)).toEqual({
      text: 'x'.repeat(100_000),
      truncated: true,
    });

    fake.tabs.get('t1')!.result = true;
    expect(await fake.call('page.click', { id: 't1', selector: '#go' }, s1)).toEqual({ ok: true });
    expect(fake.browser.evaluate).toHaveBeenLastCalledWith('t1', expect.stringContaining('"#go"'));
    expect(await fake.call('page.fill', { id: 't1', selector: '#q', value: 'a"b' }, s1)).toEqual({
      ok: true,
    });
    expect(fake.browser.evaluate).toHaveBeenLastCalledWith(
      't1',
      expect.stringContaining('"a\\"b"'),
    );

    fake.tabs.get('t1')!.result = false;
    await expect(fake.call('page.click', { id: 't1', selector: '#nope' }, s1)).rejects.toThrow(
      'No element matches "#nope"',
    );
    await expect(
      fake.call('page.fill', { id: 't1', selector: '#nope', value: '' }, s1),
    ).rejects.toThrow('No element matches "#nope"');
  });

  it('saves screenshots as PNG in the data folder and returns the path', async () => {
    const fake = await setup();
    await fake.call('tab.open', { url: 'https://a.test' }, fake.session('s1'));

    const { path } = (await fake.call('page.screenshot', { id: 't1' }, fake.session('s1'))) as {
      path: string;
    };
    expect(path.startsWith(join(fake.ctx.dataDir, 'screenshots'))).toBe(true);
    expect(path.endsWith('.png')).toBe(true);
    expect([...readFileSync(path)]).toEqual([137, 80, 78, 71]);
  });
});

describe('browser bay: own UI', () => {
  it('opens user tabs in the persistent partition and sends the state', async () => {
    const fake = await setup();
    await fake.invoke('tab.open', 'example.com');

    expect(fake.browser.open).toHaveBeenCalledWith('https://example.com', {
      partition: 'user',
      persist: true,
    });
    expect(lastState(fake).tabs).toEqual([expect.objectContaining({ id: 't1', owner: 'user' })]);
    expect(await fake.invoke('state')).toEqual(lastState(fake));
  });

  it('navigates, goes back and forward, reloads, resets the zoom and closes any tab', async () => {
    const fake = await setup();
    await fake.call('tab.open', { url: 'https://a.test' }, fake.session('s1'));

    await fake.invoke('tab.navigate', 't1', 'b.test');
    expect(fake.browser.navigate).toHaveBeenCalledWith('t1', 'https://b.test');
    await fake.invoke('tab.back', 't1');
    await fake.invoke('tab.forward', 't1');
    await fake.invoke('tab.reload', 't1');
    await fake.invoke('tab.resetZoom', 't1');
    expect(fake.browser.resetZoom).toHaveBeenCalledWith('t1');
    expect(fake.browser.back).toHaveBeenCalledWith('t1');
    expect(fake.browser.forward).toHaveBeenCalledWith('t1');
    expect(fake.browser.reload).toHaveBeenCalledWith('t1');
    await fake.invoke('tab.close', 't1');
    expect(fake.tabs.size).toBe(0);
  });

  it('rejects addresses it does not load', async () => {
    const fake = await setup();
    await expect(fake.invoke('tab.open', 'file:///x')).rejects.toThrow(
      'Only http and https addresses can be opened: file:///x',
    );
  });

  it('restores the user tabs after a restart, not the agent tabs', async () => {
    const first = await setup();
    await first.invoke('tab.open', 'https://a.test');
    await first.invoke('tab.open', 'https://b.test');
    await first.call('tab.open', { url: 'https://agent.test' }, first.session('s1'));
    expect(JSON.parse(readFileSync(join(first.ctx.dataDir, 'tabs.json'), 'utf8'))).toEqual({
      tabs: ['https://a.test', 'https://b.test'],
    });

    const second = await setup(first.ctx.dataDir);
    expect(second.browser.open.mock.calls).toEqual([
      ['https://a.test', { partition: 'user', persist: true }],
      ['https://b.test', { partition: 'user', persist: true }],
    ]);
  });

  it('keeps tabs.json until every user tab has an address and drops closed tabs', async () => {
    const fake = await setup();
    const file = join(fake.ctx.dataDir, 'tabs.json');
    await fake.invoke('tab.open', 'https://a.test');
    fake.popup('t1', ''); // still loading: no address yet
    await fake.invoke('tab.close', 't1');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ tabs: ['https://a.test'] });
    await fake.invoke('tab.navigate', 't2', 'https://c.test');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ tabs: ['https://c.test'] });
  });

  it('names a wrong argument type for arguments that are not an object', async () => {
    const fake = await setup();
    await expect(fake.call('tab.list', {}, fake.session('s1'))).resolves.toEqual([]);
    await expect(fake.call('tab.open', 'x', fake.session('s1'))).rejects.toThrow(
      'Invalid arguments: args: Invalid input: expected object, received string',
    );
  });

  it('starts empty with a missing or broken tabs.json', async () => {
    const fake = await setup();
    expect(fake.browser.open).not.toHaveBeenCalled();
    writeFileSync(join(fake.ctx.dataDir, 'tabs.json'), '{');
    const again = await setup(fake.ctx.dataDir);
    expect(again.browser.open).not.toHaveBeenCalled();
  });

  it('needs the browser host module', async () => {
    const fake = fakeContext();
    const { browser: _b, ...withoutBrowser } = fake.ctx;
    expect(() => bay.activate(withoutBrowser as BayContext)).toThrow(
      'manifest.json needs "hostModules": ["browser"]',
    );
    expect(existsSync(join(fake.ctx.dataDir, 'tabs.json'))).toBe(false);
  });
});

describe('browser bay: agents of the local server (ADR 0036)', () => {
  it('opens their tabs apart from the agents of this app and closes them when the session ends', async () => {
    const fake = await setup();
    const local = {
      caller: { kind: 'local-server' as const, bayId: 'dev.hangar.agents', sessionId: 's1' },
    };
    await fake.call('tab.open', { url: 'https://a.test' }, local);
    expect(fake.browser.open).toHaveBeenLastCalledWith('https://a.test', {
      partition: 'session-local-server:dev.hangar.agents-s1',
    });
    await fake.call('tab.open', { url: 'https://b.test' }, fake.session('s1'));
    expect(await fake.call('tab.list', {}, local)).toEqual([
      expect.objectContaining({ url: 'https://a.test' }),
    ]);
    await fake.call(
      'tab.open',
      { url: 'https://c.test' },
      { caller: { kind: 'local-server', bayId: 'x.y' } },
    );
    expect(fake.browser.open).toHaveBeenLastCalledWith('https://c.test', {
      partition: 'bay-local-server:x.y',
    });
    fake.endSession('s1', 'local-server:dev.hangar.agents');
    expect([...fake.tabs.values()].map((t) => t.url)).toEqual(['https://b.test', 'https://c.test']);
  });
});
