import { describe, expect, it } from 'vitest';
import { normalizeUrl } from './url';

describe('normalizeUrl', () => {
  it.each([
    ['https://example.com', 'https://example.com'],
    ['  http://example.com/a  ', 'http://example.com/a'],
    ['about:blank', 'about:blank'],
    ['example.com', 'https://example.com'],
    ['example.com/path?q=1', 'https://example.com/path?q=1'],
    ['localhost', 'http://localhost'],
    ['localhost:5173', 'http://localhost:5173'],
    ['localhost:5173/app', 'http://localhost:5173/app'],
    ['127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['myhost:3000', 'http://myhost:3000'],
  ])('%s → %s', (input, url) => {
    expect(normalizeUrl(input)).toBe(url);
  });

  it.each([
    '',
    '   ',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ftp://x',
    'two words',
    'nodot',
  ])('rejects %j', (input) => {
    expect(normalizeUrl(input)).toBeUndefined();
  });
});
