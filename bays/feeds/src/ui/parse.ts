import type { ParsedFeed, ParsedItem } from '../main/feeds';
import { t } from './messages';

const SUMMARY = 500;
/** As many as the history keeps; feeds list the newest first. */
const MAX_ITEMS = 1000;

const child = (el: Element | undefined, name: string) =>
  el && [...el.children].find((c) => c.localName === name);
const children = (el: Element | undefined, name: string) =>
  el ? [...el.children].filter((c) => c.localName === name) : [];

/**
 * Text of an element, whitespace collapsed. RSS descriptions and Atom `type="html"` carry
 * escaped HTML; Atom text and XHTML are text already.
 */
function plain(el: Element | undefined, html = false): string {
  const raw = el?.textContent ?? '';
  const text = html
    ? (new DOMParser().parseFromString(raw, 'text/html').body.textContent ?? '')
    : raw;
  return text.replace(/\s+/g, ' ').trim();
}

/** Atom text construct: HTML only with `type="html"`. */
const atomText = (el: Element | undefined) => plain(el, el?.getAttribute('type') === 'html');

function link(href: string | null | undefined, base: string): string {
  try {
    const url = new URL(href?.trim() ?? '', base);
    return /^https?:$/.test(url.protocol) && href?.trim() ? url.href : '';
  } catch {
    return '';
  }
}

function date(el: Element | undefined): string | undefined {
  const d = new Date(el?.textContent?.trim() ?? '');
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

function item(fields: Omit<ParsedItem, 'id' | 'summary'> & { id?: string; summary: string }) {
  const summary =
    fields.summary.length > SUMMARY ? `${fields.summary.slice(0, SUMMARY - 1)}…` : fields.summary;
  const out: ParsedItem = {
    id: fields.id || fields.link || fields.title,
    title: fields.title,
    link: fields.link,
    summary,
  };
  if (fields.published) out.published = fields.published;
  return out;
}

/** RSS 2.0, RSS 1.0 (RDF) and Atom; `base` resolves relative links. */
export function parseFeed(xml: string, base: string): ParsedFeed {
  const root = new DOMParser().parseFromString(xml, 'application/xml').documentElement;
  if (root.localName === 'feed') {
    return {
      title: atomText(child(root, 'title')),
      items: children(root, 'entry')
        .slice(0, MAX_ITEMS)
        .map((e) => {
          const alternate = children(e, 'link').find(
            (l) => (l.getAttribute('rel') ?? 'alternate') === 'alternate',
          );
          return item({
            id: child(e, 'id')?.textContent?.trim(),
            title: atomText(child(e, 'title')),
            link: link(alternate?.getAttribute('href'), base),
            summary: atomText(child(e, 'summary') ?? child(e, 'content')),
            published: date(child(e, 'published') ?? child(e, 'updated')),
          });
        }),
    };
  }
  if (root.localName !== 'rss' && root.localName !== 'RDF') throw new Error(t.notAFeed);
  const channel = child(root, 'channel');
  // RSS 2.0 nests the items in the channel, RSS 1.0 puts them next to it.
  return {
    title: plain(child(channel, 'title')),
    items: [...children(channel, 'item'), ...children(root, 'item')].slice(0, MAX_ITEMS).map((i) =>
      item({
        id: child(i, 'guid')?.textContent?.trim(),
        title: plain(child(i, 'title')),
        link: link(child(i, 'link')?.textContent, base),
        summary: plain(child(i, 'description') ?? child(i, 'encoded'), true),
        published: date(child(i, 'pubDate') ?? child(i, 'date')),
      }),
    ),
  };
}
