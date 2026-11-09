import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baySetting, readSettings, uiLocale, writeSettings, type AppSettings } from './settings';

const file = () => join(mkdtempSync(join(tmpdir(), 'hangar-settings-')), 'settings.json');

describe('settings', () => {
  it('defaults to the stable channel and the system language when the file is missing or broken', () => {
    const defaults = {
      updateChannel: 'stable',
      language: 'system',
      theme: 'system',
      bays: [],
      baySettings: {},
      shortcuts: [],
    };
    const f = file();
    expect(readSettings(f)).toEqual(defaults);
    writeFileSync(f, '{kaputt');
    expect(readSettings(f)).toEqual(defaults);
    writeFileSync(
      f,
      JSON.stringify({ updateChannel: 'nightly', language: 'fr', theme: 'blue', bays: 'x' }),
    );
    expect(readSettings(f)).toEqual(defaults);
  });

  it('persists channel, language, color scheme and the bays of the sidebar', () => {
    const f = file();
    const settings = {
      updateChannel: 'beta',
      language: 'en',
      theme: 'dark',
      bays: ['dev.hangar.agents', 'dev.hangar.browser'],
      baySettings: { 'dev.hangar.agents': { copyOnSelect: true } },
      shortcuts: [{ id: 'a', target: 'https://example.com/' }],
    } as const;
    writeSettings(f, {
      ...settings,
      bays: [...settings.bays],
      baySettings: { 'dev.hangar.agents': { copyOnSelect: true } },
      shortcuts: [...settings.shortcuts],
    });
    expect(readSettings(f)).toEqual(settings);
  });

  it('persists the shortcuts of the sidebar and drops invalid ones (ADR 0027)', () => {
    const f = file();
    writeFileSync(
      f,
      JSON.stringify({
        shortcuts: [
          { id: 'a', target: '/Applications/Mail.app' },
          { id: 'b', target: 'ftp://example.com' },
        ],
      }),
    );
    expect(readSettings(f).shortcuts).toEqual([{ id: 'a', target: '/Applications/Mail.app' }]);
  });

  it('keeps the choice of the local server only as a boolean, and only when made (ADR 0036)', () => {
    const f = file();
    writeFileSync(f, JSON.stringify({ localServer: false }));
    expect(readSettings(f).localServer).toBe(false);
    // Another setting written later keeps it.
    writeSettings(f, { ...readSettings(f), theme: 'dark' });
    expect(readSettings(f)).toMatchObject({ theme: 'dark', localServer: false });
    writeFileSync(f, JSON.stringify({ localServer: 'yes' }));
    expect('localServer' in readSettings(f)).toBe(false);
  });

  it('keeps only bay ids that are strings (ADR 0017)', () => {
    const f = file();
    writeFileSync(f, JSON.stringify({ bays: ['dev.hangar.agents', 3, null] }));
    expect(readSettings(f).bays).toEqual(['dev.hangar.agents']);
  });

  it('keeps only boolean and text bay settings and falls back to the declared default (ADR 0023)', () => {
    const f = file();
    writeFileSync(
      f,
      '{"baySettings":{"a":{"on":true,"text":"x","n":1},"b":"x","c":null,"__proto__":{"on":true}}}',
    );
    const settings = readSettings(f);
    expect(Object.keys(settings.baySettings)).toEqual(['a', 'b', 'c', '__proto__']);
    expect({ ...settings.baySettings.a }).toEqual({ on: true, text: 'x' });
    expect({ ...settings.baySettings.b }).toEqual({});
    // `__proto__` stays a bay id and changes no prototype.
    expect(Object.getPrototypeOf(settings.baySettings)).toBeNull();
    const declared = [
      { key: 'on', type: 'boolean' as const, default: false, label: { de: 'An', en: 'On' } },
      { key: 'off', type: 'boolean' as const, default: true, label: { de: 'Aus', en: 'Off' } },
    ];
    const stored = settings.baySettings.a;
    expect(baySetting(stored, declared, 'on')).toBe(true);
    expect(baySetting(stored, declared, 'off')).toBe(true);
    expect(baySetting(stored, declared, 'missing')).toBe(false);
    expect(baySetting(undefined, declared, 'off')).toBe(true);
    // Keys like `constructor` must not read what a plain object inherits.
    const inherited = [
      { key: 'constructor', type: 'boolean' as const, default: true, label: { de: 'K', en: 'C' } },
    ];
    expect(baySetting({}, inherited, 'constructor')).toBe(true);
  });

  it('keeps text bay settings; a value of the wrong type falls back to the default (ADR 0025)', () => {
    const f = file();
    writeFileSync(f, '{"baySettings":{"a":{"prompt":"%~ ","on":"ja","n":3}}}');
    const stored = readSettings(f).baySettings.a;
    expect({ ...stored }).toEqual({ prompt: '%~ ', on: 'ja' });
    const declared = [
      { key: 'prompt', type: 'text' as const, default: '> ', label: { de: 'P', en: 'P' } },
      { key: 'on', type: 'boolean' as const, default: true, label: { de: 'An', en: 'On' } },
    ];
    expect(baySetting(stored, declared, 'prompt')).toBe('%~ ');
    expect(baySetting(stored, declared, 'on')).toBe(true);
    expect(baySetting({ prompt: false }, declared, 'prompt')).toBe('> ');
    expect(baySetting({ prompt: '' }, declared, 'prompt')).toBe('');
  });

  it('takes the language from HANGAR_LOCALE, then the setting, then the system', () => {
    const system = {
      updateChannel: 'stable',
      language: 'system',
      theme: 'system',
      bays: [],
      baySettings: {},
      shortcuts: [],
    } satisfies AppSettings as AppSettings;
    const english: AppSettings = { ...system, language: 'en' };
    expect(uiLocale(system, undefined, ['de-DE'])).toBe('de');
    expect(uiLocale(system, undefined, ['fr-FR'])).toBe('en');
    expect(uiLocale(english, undefined, ['de-DE'])).toBe('en');
    expect(uiLocale(english, 'de', ['en-US'])).toBe('de');
    expect(uiLocale(english, 'en-XA', ['de-DE'])).toBe('en-XA');
    expect(uiLocale(system, 'fr', ['de-DE'])).toBe('de');
  });
});
