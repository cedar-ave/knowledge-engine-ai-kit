import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { paywallMarker, signInWall, demoteHeadings, insertCaptured, w3cDate, publishedFromHtml, bookmarkPageInputs, feedTitles, pickVtt, wordCount, tidyMarkdown, planItem } from '../lib/fetch.mjs';
import { capturedSection } from '../lib/md.mjs';
import { extractArticle } from '../lib/extract.mjs';

test('demoteHeadings: shallowest becomes ####, fenced code untouched', () => {
  const md = '# Top\n\ntext\n\n## Sub\n\n```\n# not a heading\n```\n';
  assert.equal(demoteHeadings(md), '#### Top\n\ntext\n\n##### Sub\n\n```\n# not a heading\n```\n');
  assert.equal(demoteHeadings('no headings'), 'no headings');
});

test('insertCaptured: before ## Source, and captured section round-trips', () => {
  const body = '## Summary\n\nS.\n\n## Source\n\n`https://example.com/a`\n';
  const out = insertCaptured(body, '#### Part\n\nHello world.');
  assert.match(out, /## Captured text\n\n#### Part\n\nHello world\.\n\n## Source/);
  assert.equal(capturedSection(out).trim(), '#### Part\n\nHello world.');
  assert.equal(insertCaptured(out, 'New.').match(/## Captured text/g).length, 1);
});

test('w3cDate handles ISO, yt-dlp and junk', () => {
  assert.equal(w3cDate('2026-05-04T10:00:00Z'), '2026-05-04');
  assert.equal(w3cDate('20260504'), '2026-05-04');
  assert.equal(w3cDate('not a date'), undefined);
});

test('publishedFromHtml reads JSON-LD @graph', () => {
  const doc = new JSDOM('<script type="application/ld+json">{"@graph":[{"@type":"Article","datePublished":"2026-03-02T08:00:00Z"}]}</script>').window.document;
  assert.equal(publishedFromHtml(doc), '2026-03-02');
});

test('bookmark inputs: title, description, feed, generator; no body text', () => {
  const html = '<html><head><title>Example Docs</title><meta name="description" content="Docs for Example."><meta name="generator" content="Docusaurus v3"><link rel="alternate" type="application/rss+xml" href="/blog/rss.xml"></head><body><nav><a href="/a">Guides</a><a href="/b">API</a></nav><p>Body text never stored.</p></body></html>';
  const p = bookmarkPageInputs(html, 'https://docs.example.com/');
  assert.deepEqual(p, { title: 'Example Docs', description: 'Docs for Example.', feeds: ['https://docs.example.com/blog/rss.xml'], navLabels: ['Guides', 'API'], generator: 'Docusaurus' });
  assert.ok(!JSON.stringify(p).includes('never stored'));
});

test('feedTitles: RSS and Atom', () => {
  assert.deepEqual(feedTitles('<rss><channel><title>Feed</title><item><title>One</title></item><item><title>Two</title></item></channel></rss>'), ['One', 'Two']);
  assert.deepEqual(feedTitles('<feed xmlns="http://www.w3.org/2005/Atom"><title>F</title><entry><title>A</title></entry></feed>'), ['A']);
});

test('pickVtt prefers en over en-orig over translations', () => {
  assert.equal(pickVtt(['x.en-orig.vtt', 'x.en.vtt', 'x.info.json']), 'x.en.vtt');
  assert.equal(pickVtt(['x.en-de.vtt', 'x.en-orig.vtt']), 'x.en-orig.vtt');
  assert.equal(pickVtt(['x.info.json']), undefined);
});

test('fixture articles extract to enough words with demoted headings', () => {
  const art = extractArticle(fs.readFileSync('test/fixtures/article1.html', 'utf8'), 'https://example.com/a');
  const md = tidyMarkdown(demoteHeadings(art.markdown));
  assert.ok(wordCount(md) > 0);
  assert.doesNotMatch(md, /^#{1,3}\s/m);
});

test('planItem: sources bookmark, Slack skipped, failed retried only on request', () => {
  const it = (data, content = '## Summary\n') => ({ data, content, file: 'items/x-00000000.md' });
  const root = 'does-not-exist';
  assert.equal(planItem(it({ type: 'blog', id: 'web:example.com' }), root), 'bookmark');
  assert.equal(planItem(it({ type: 'slack-thread', id: 'slack:x' }), root), null);
  assert.equal(planItem(it({ type: 'article', id: 'web:example.com/a', capture: 'summary-only' }), root), 'web');
  assert.equal(planItem(it({ type: 'article', id: 'web:example.com/a', capture: 'extraction-failed' }), root), null);
  assert.equal(planItem(it({ type: 'article', id: 'web:example.com/a', capture: 'extraction-failed' }), root, { retryFailed: true }), 'web');
  assert.equal(planItem(it({ type: 'talk', id: 'yt:AbCdEf12345', capture: 'summary-only' }), root), 'youtube');
  assert.equal(planItem(it({ type: 'episode', id: 'web:example.com/ep/1', capture: 'summary-only' }), root), 'audio');
  assert.equal(planItem(it({ type: 'talk', id: 'yt:AbCdEf12345', capture: 'verbatim' }, '## Captured text\n\nx\n'), root), null);
});

test('tidyMarkdown strips heading anchor links and data images', () => {
  assert.equal(tidyMarkdown('#### Title[​](#title "Direct link to Title")\n\n\n\nText ![x](data:image/png;base64,AAA)'), '#### Title\n\nText');
});

test('paywallMarker: Medium, Substack, read-more cut-off, ellipsis; clean text passes', () => {
  assert.equal(paywallMarker('Member-only story Some title', 'Text.'), 'Medium member-only');
  assert.equal(paywallMarker('Keep reading with a 7-day free trial', 'Text.'), 'Substack paywall');
  assert.equal(paywallMarker('', 'Intro paragraph.\n\nContinue reading'), 'read-more cut-off');
  assert.equal(paywallMarker('', 'Short preview that stops…'), 'text ends in ellipsis');
  assert.equal(paywallMarker('', 'A complete article.'), undefined);
});

test('signInWall: LinkedIn authwall', () => {
  assert.ok(signInWall('https://www.linkedin.com/authwall?trk=x', ''));
  assert.ok(!signInWall('https://www.linkedin.com/pulse/example-post', 'Article text'));
});

test('planItem: LinkedIn articles fetched as web; recheck only full-text', () => {
  const it = (data, content = '## Summary\n') => ({ data, content, file: 'items/x-00000000.md' });
  assert.equal(planItem(it({ type: 'linkedin-article', id: 'web:linkedin.com/pulse/x', capture: 'summary-only' }), 'none'), 'web');
  assert.equal(planItem(it({ type: 'linkedin-post', id: 'li:7000000000000000001', capture: 'verbatim' }), 'none'), null);
  assert.equal(planItem(it({ type: 'article', id: 'web:example.com/a', capture: 'full-text' }, '## Captured text\n\nx\n'), 'none', { recheck: true }), 'recheck');
  assert.equal(planItem(it({ type: 'article', id: 'web:example.com/a', capture: 'partial' }, '## Captured text\n\nx\n'), 'none', { recheck: true }), null);
});
