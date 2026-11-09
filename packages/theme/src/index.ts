import css from './tokens.css?raw';

/** The complete theme stylesheet (CSS custom properties, light and dark mode). */
export const themeCss: string = css;

/** Returns the light-mode value of a token, e.g. for non-CSS consumers like xterm.js. */
export function readToken(name: string): string | undefined {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(themeCss);
  return match?.[1]?.trim();
}
