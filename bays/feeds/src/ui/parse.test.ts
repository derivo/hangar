import { describe, expect, it } from 'vitest';
import { parseFeed } from './parse';

const BASE = 'https://example.org/feed.xml';

describe('parseFeed', () => {
  it('reads RSS 2.0 items with HTML descriptions as plain text', () => {
    const feed = parseFeed(
      `<?xml version="1.0"?>
      <rss version="2.0"><channel>
        <title>Blog &amp; Co</title>
        <image><title>Logo</title></image>
        <item>
          <title>Zweiter</title>
          <link>/posts/2</link>
          <guid>p2</guid>
          <description>&lt;p&gt;Hallo   &lt;b&gt;Welt&lt;/b&gt;&lt;/p&gt;</description>
          <pubDate>Tue, 03 Nov 2026 10:00:00 GMT</pubDate>
        </item>
        <item><title>Erster</title><link>javascript:alert(1)</link></item>
      </channel></rss>`,
      BASE,
    );
    expect(feed.title).toBe('Blog & Co');
    expect(feed.items).toEqual([
      {
        id: 'p2',
        title: 'Zweiter',
        link: 'https://example.org/posts/2',
        summary: 'Hallo Welt',
        published: '2026-11-03T10:00:00.000Z',
      },
      // No guid: the link, then the title identify it; only http(s) links are kept.
      { id: 'Erster', title: 'Erster', link: '', summary: '' },
    ]);
  });

  it('reads Atom entries', () => {
    const feed = parseFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom">
        <title type="html">&lt;i&gt;Atom&lt;/i&gt;</title>
        <entry>
          <title>Eintrag</title>
          <link rel="edit" href="https://example.org/edit/1"/>
          <link href="https://example.org/1"/>
          <id>urn:1</id>
          <content type="html">&lt;p&gt;Inhalt&lt;/p&gt;</content>
          <updated>2026-11-04T08:00:00Z</updated>
        </entry>
      </feed>`,
      BASE,
    );
    expect(feed).toEqual({
      title: 'Atom',
      items: [
        {
          id: 'urn:1',
          title: 'Eintrag',
          link: 'https://example.org/1',
          summary: 'Inhalt',
          published: '2026-11-04T08:00:00.000Z',
        },
      ],
    });
  });

  it('reads RSS 1.0 (RDF) items and shortens long summaries', () => {
    const feed = parseFeed(
      `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
        <channel><title>RDF</title></channel>
        <item><title>A</title><link>https://example.org/a</link>
          <description>${'x'.repeat(600)}</description><dc:date>kaputt</dc:date></item>
      </rdf:RDF>`,
      BASE,
    );
    const [item] = feed.items;
    expect(item!.id).toBe('https://example.org/a');
    expect(item!.summary).toHaveLength(500);
    expect(item!.summary.endsWith('…')).toBe(true);
    expect(item!.published).toBeUndefined();
  });

  it('keeps Atom text as text and reads XHTML content', () => {
    const feed = parseFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title>
        <entry><id>1</id><title type="text">Using &lt;T&gt; in C++</title>
          <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Hallo <b>Welt</b></p></div></content>
        </entry>
      </feed>`,
      BASE,
    );
    expect(feed.items[0]).toMatchObject({ title: 'Using <T> in C++', summary: 'Hallo Welt' });
  });

  it('keeps the newest 1000 entries of a long feed', () => {
    const items = Array.from({ length: 1001 }, (_, i) => `<item><guid>${i}</guid></item>`);
    const feed = parseFeed(`<rss><channel>${items.join('')}</channel></rss>`, BASE);
    expect(feed.items).toHaveLength(1000);
    expect(feed.items.at(-1)!.id).toBe('999');
  });

  it('rejects what is no feed', () => {
    expect(() => parseFeed('<html><body>nope</body></html>', BASE)).toThrow(
      'Kein RSS- oder Atom-Feed',
    );
    expect(() => parseFeed('kein xml', BASE)).toThrow('Kein RSS- oder Atom-Feed');
  });
});
