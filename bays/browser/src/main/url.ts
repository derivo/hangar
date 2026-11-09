/** Turns an address bar entry into a URL Hangar loads, or `undefined` (http, https, about:blank only). */
export function normalizeUrl(input: string): string | undefined {
  const text = input.trim();
  if (!text || /\s/.test(text)) return undefined;
  if (/^[\w.-]+:\d+(\/|$)/.test(text)) return `http://${text}`;
  if (/^https?:\/\/./i.test(text) || text === 'about:blank') return text;
  if (/^[a-z][a-z\d+.-]*:/i.test(text)) return undefined;
  const host = text.split('/')[0]!;
  if (host === 'localhost' || /^\d+(\.\d+){3}$/.test(host)) return `http://${text}`;
  // No search engine; an entry without a dot is not an address.
  return host.includes('.') ? `https://${text}` : undefined;
}
