// Languages and text catalogs (ADR 0009). Free of dependencies, so bay UIs can import it.

/** Languages Hangar ships. Every bay brings a catalog for each of them. */
export type Locale = 'de' | 'en';

/**
 * Language of the running app. `en-XA` is the pseudo-locale for tests: English text,
 * accented and about 40 % longer, so hard-coded and cut-off texts stand out.
 */
export type UiLocale = Locale | 'en-XA';

/** `true` for `de`, `en` and `en-XA`. */
export function isUiLocale(value: unknown): value is UiLocale {
  return value === 'de' || value === 'en' || value === 'en-XA';
}

/**
 * First German or English entry of a language list such as
 * `app.getPreferredSystemLanguages()` (`de-DE`) or `LANG` (`de_DE.UTF-8`); English otherwise.
 */
export function resolveLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const language = tag.split(/[-_.]/)[0]!.toLowerCase();
    if (language === 'de' || language === 'en') return language;
  }
  return 'en';
}

/**
 * Picks a bay's catalog for the app language.
 *
 * @example
 * ```ts
 * const de = { hello: 'Hallo', greet: (name: string) => `Hallo ${name}` };
 * const en: typeof de = { hello: 'Hello', greet: (name) => `Hello ${name}` };
 * const t = catalogFor({ de, en }, window.hangar.locale);
 * ```
 */
export function catalogFor<C extends object>(catalogs: Record<Locale, C>, locale: UiLocale): C {
  return locale === 'en-XA' ? pseudoLocalize(catalogs.en) : catalogs[locale];
}

const ACCENTS: Record<string, string> = {
  a: 'á',
  e: 'é',
  i: 'í',
  o: 'ó',
  u: 'ú',
  y: 'ý',
  n: 'ñ',
  c: 'ç',
  A: 'Á',
  E: 'É',
  I: 'Í',
  O: 'Ó',
  U: 'Ú',
};
/** Stands in for a placeholder value while the text around it is pseudo-localized. */
const MARK = '\u0001';
const MARKED = new RegExp(`${MARK}(\\d+)${MARK}`, 'g');

function pseudo(text: string): string {
  const accented = text.replace(/[aeiouyncAEIOU]/g, (ch) => ACCENTS[ch]!);
  return `[${accented}${'~'.repeat(Math.ceil(text.length * 0.4))}]`;
}

/**
 * Pseudo-localizes every text of a catalog. Texts with placeholders keep the values
 * (names, paths) unchanged; their functions receive markers instead of the real string
 * arguments. Other arguments (numbers, dates) pass unchanged, so formatting still works.
 */
export function pseudoLocalize<C extends object>(catalog: C): C {
  return Object.fromEntries(
    Object.entries(catalog).map(([key, value]: [string, unknown]) => {
      if (typeof value === 'string') return [key, pseudo(value)];
      if (typeof value === 'function') {
        return [
          key,
          (...args: unknown[]) =>
            pseudo(
              String(
                value(...args.map((a, i) => (typeof a === 'string' ? `${MARK}${i}${MARK}` : a))),
              ),
            ).replace(MARKED, (_, i: string) => String(args[Number(i)])),
        ];
      }
      return [key, pseudoLocalize(value as object)];
    }),
  ) as C;
}
