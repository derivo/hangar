import { describe, expect, it } from 'vitest';
import { addShortcut, isUrl, shortcutName, shortcutUrl, validShortcuts } from './shortcuts';

describe('shortcuts (ADR 0027)', () => {
  it('takes http and https addresses, trimmed and normalized', () => {
    expect(shortcutUrl('  https://example.com  ')).toBe('https://example.com/');
    expect(shortcutUrl('HTTP://Example.com/a?b=1#c')).toBe('http://example.com/a?b=1#c');
  });

  it.each([
    '',
    '   ',
    'example.com',
    'localhost:3000',
    'ftp://example.com',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'http://',
    'https:example',
  ])('rejects %j', (text) => {
    expect(() => shortcutUrl(text)).toThrow('Invalid URL');
  });

  it('names a path by its last part without .app and a website by its host', () => {
    expect(shortcutName('/Applications/Visual Studio Code.app')).toBe('Visual Studio Code');
    expect(shortcutName('/Users/anna/code/shop/')).toBe('shop');
    expect(shortcutName('C:\\Tools\\notes.txt')).toBe('notes.txt');
    expect(shortcutName('https://www.example.com/tickets')).toBe('www.example.com');
    expect(isUrl('https://example.com/')).toBe(true);
    expect(isUrl('/Applications/https.app')).toBe(false);
  });

  it('appends a new target and keeps an existing one only once', () => {
    const one = addShortcut([], '/Applications/Mail.app', 'a');
    expect(one).toEqual([{ id: 'a', target: '/Applications/Mail.app' }]);
    expect(addShortcut(one, '/Applications/Mail.app', 'b')).toBe(one);
    expect(addShortcut(one, 'https://example.com/', 'b')).toEqual([
      ...one,
      { id: 'b', target: 'https://example.com/' },
    ]);
  });

  it('keeps only stored entries with an id and an absolute path or http(s) address', () => {
    expect(validShortcuts('x')).toEqual([]);
    expect(
      validShortcuts([
        { id: 'a', target: '/Applications/Mail.app' },
        { id: 'b', target: 'https://example.com/' },
        { id: 'c', target: 'C:\\Tools\\notes.txt' },
        { id: 'g', target: '\\\\server\\share\\Projekt' },
        { id: 'd', target: 'relative/path' },
        { id: 'h', target: 'C:relative' },
        { id: 'e', target: 'javascript:alert(1)' },
        { id: 'f', target: 3 },
        { target: '/tmp' },
        { id: 'a', target: '/tmp' },
        null,
      ]),
    ).toEqual([
      { id: 'a', target: '/Applications/Mail.app' },
      { id: 'b', target: 'https://example.com/' },
      { id: 'c', target: 'C:\\Tools\\notes.txt' },
      { id: 'g', target: '\\\\server\\share\\Projekt' },
    ]);
  });
});
