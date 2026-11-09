import { describe, expect, it } from 'vitest';
import { catalogFor, isUiLocale, pseudoLocalize, resolveLocale } from './i18n';

describe('resolveLocale', () => {
  it.each([
    [['de-DE', 'en-US'], 'de'],
    [['de_AT.UTF-8'], 'de'],
    [['fr-FR', 'de-CH'], 'de'],
    [['en-GB', 'de-DE'], 'en'],
    [['fr-FR'], 'en'],
    [['C'], 'en'],
    [[], 'en'],
  ])('%j → %s', (preferred, locale) => {
    expect(resolveLocale(preferred)).toBe(locale);
  });
});

describe('isUiLocale', () => {
  it('accepts the shipped languages and the pseudo-locale only', () => {
    expect(['de', 'en', 'en-XA', 'fr', undefined].map(isUiLocale)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });
});

const catalogs = {
  de: { hello: 'Hallo', greet: (name: string) => `Hallo ${name}`, nested: { bye: 'Tschüss' } },
  en: { hello: 'Hello', greet: (name: string) => `Hello ${name}`, nested: { bye: 'Bye' } },
};

describe('catalogFor', () => {
  it('returns the catalog of the language', () => {
    expect(catalogFor(catalogs, 'de').hello).toBe('Hallo');
    expect(catalogFor(catalogs, 'en').greet('Ada')).toBe('Hello Ada');
  });

  it('pseudo-localizes the English catalog for en-XA', () => {
    const t = catalogFor(catalogs, 'en-XA');
    expect(t.hello).toBe('[Hélló~~]');
    expect(t.nested.bye).toBe('[Býé~~]');
  });
});

describe('pseudoLocalize', () => {
  it('accents and lengthens the text, but keeps placeholder values as they are', () => {
    const t = pseudoLocalize(catalogs.en);
    expect(t.greet('Ada')).toBe('[Hélló Ada~~~~]');
  });

  it('passes numbers, booleans and dates on unchanged, so formatting still works', () => {
    const t = pseudoLocalize({
      run: (ok: boolean, ms: number) => `${ok ? 'ok' : 'failed'} (${Math.round(ms / 1000)} s)`,
      year: (d: Date) => `in ${d.getUTCFullYear()}`,
    });
    expect(t.run(false, 4200)).toBe('[fáíléd (4 s)~~~~~]');
    expect(t.year(new Date('2026-10-29T00:00:00Z'))).toBe('[íñ 2026~~~]');
  });
});
