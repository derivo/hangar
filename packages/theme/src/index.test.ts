import { describe, expect, it } from 'vitest';
import { themeCss, readToken } from './index';

const colorTokens = [...themeCss.matchAll(/^\s+(--hangar-color-[\w-]+):/gm)].map((m) => m[1]);

describe('theme tokens', () => {
  const block = (start: string) => themeCss.slice(themeCss.indexOf(start)).split('}')[0]!;
  const value = (css: string, name: string) =>
    new RegExp(`${name}: (#[0-9a-f]{6});`).exec(css)![1]!;
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };

  it('defines every color token in light mode and both dark-mode blocks', () => {
    const light = new Set(colorTokens);
    // each color token appears once for light, once in the media query, once for [data-theme=dark]
    for (const token of light) {
      expect(colorTokens.filter((t) => t === token)).toHaveLength(3);
    }
    expect(light.size).toBeGreaterThan(10);
  });

  it('switches on prefers-color-scheme and an explicit data-theme attribute', () => {
    expect(themeCss).toContain('@media (prefers-color-scheme: dark)');
    expect(themeCss).toContain(":root[data-theme='dark']");
    expect(themeCss).toContain(":root:not([data-theme='light'])");
  });

  it('keeps every tab color at WCAG AA contrast against the backgrounds in both modes', () => {
    const colors = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'violet', 'pink'];
    for (const css of [block(':root {'), block(":root[data-theme='dark'] {")]) {
      for (const color of colors) {
        for (const bg of ['bg', 'surface', 'surface-raised']) {
          const ratio = contrast(
            value(css, `--hangar-color-tab-${color}`),
            value(css, `--hangar-color-${bg}`),
          );
          expect(ratio, `${color} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('keeps text, accent and status colors readable on every background in both modes', () => {
    for (const css of [block(':root {'), block(":root[data-theme='dark'] {")]) {
      for (const fg of ['text', 'text-muted', 'accent', 'focus', 'danger', 'waiting-text']) {
        for (const bg of ['bg', 'surface', 'surface-raised', 'terminal-bg']) {
          const ratio = contrast(
            value(css, `--hangar-color-${fg}`),
            value(css, `--hangar-color-${bg}`),
          );
          expect(ratio, `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const [fg, bg] of [
        ['accent-text', 'accent'],
        ['badge-text', 'badge'],
        ['dock-text', 'dock'],
      ] as const) {
        expect(
          contrast(value(css, `--hangar-color-${fg}`), value(css, `--hangar-color-${bg}`)),
          fg,
        ).toBeGreaterThanOrEqual(4.5);
      }
      // Lights and lines of the status: non-text contrast (WCAG 1.4.11).
      for (const status of ['working', 'waiting', 'done', 'idle']) {
        const ratio = contrast(
          value(css, `--hangar-color-status-${status}`),
          value(css, '--hangar-color-surface'),
        );
        expect(ratio, status).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('is black and orange, with straight corners and Michroma for headings', () => {
    expect(readToken('--hangar-color-accent')).toBe('#b34a00');
    expect(value(block(":root[data-theme='dark'] {"), '--hangar-color-accent')).toBe('#ff8a2a');
    expect(readToken('--hangar-font-display')).toMatch(/^'Michroma'/);
    expect(themeCss).not.toContain('--hangar-cut');
  });

  it('reads the light value of a token', () => {
    expect(readToken('--hangar-color-accent')).toBe('#b34a00');
    expect(readToken('--hangar-space-2')).toBe('8px');
  });

  it('returns undefined for unknown tokens', () => {
    expect(readToken('--hangar-nope')).toBeUndefined();
  });
});
