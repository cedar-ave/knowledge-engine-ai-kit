import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

export function extractArticle(html, url = 'https://example.com/') {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const meta = (sel) => doc.querySelector(sel)?.getAttribute('content') || undefined;
  const published = meta('meta[property="article:published_time"]') ||
    doc.querySelector('time[datetime]')?.getAttribute('datetime') || undefined;
  const art = new Readability(doc).parse();
  if (!art) return null;
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  return { title: art.title, byline: art.byline, published, markdown: td.turndown(art.content) };
}
