import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, pickType } from '../lib/classify.mjs';
import { parseCsv, parseRelations, notionDate, freeDate, mapBody, splitNotionPage } from '../lib/notion.mjs';

test('classify returns link-pattern candidates', () => {
  assert.deepEqual(classify('https://youtu.be/abcdefghijk').candidates, ['video', 'talk', 'episode']);
  assert.deepEqual(classify('https://www.youtube.com/@sample/videos').candidates, ['channel']);
  assert.deepEqual(classify('https://sample.substack.com/').candidates, ['newsletter']);
  assert.deepEqual(classify('https://sample.substack.com/p/post').candidates, ['article']);
  assert.deepEqual(classify('https://github.com/acme/repo').candidates, ['repo', 'tool']);
  assert.deepEqual(classify('https://example-workspace.slack.com/archives/C0/p1').candidates, ['slack-thread']);
  assert.equal(classify('https://acme-docs.example/blog').rule, 'site-root');
  assert.equal(pickType('https://docs.acme-docs.example/', classify('https://docs.acme-docs.example/')).type, 'docs-site');
  assert.equal(pickType('https://youtu.be/abcdefghijk', classify('https://youtu.be/abcdefghijk'), { event: 'Sample Docs Conf' }).type, 'talk');
});

test('parseRelations handles links, plain names and parentheses', () => {
  const hex = 'a'.repeat(32);
  const r = parseRelations(`Acme (Ontology) (https://app.notion.com/p/Acme-${hex}?pvs=21), Plain, Ben (Docs%20knowledge/Ben%20${'b'.repeat(32)}.csv)`);
  assert.deepEqual(r, [{ name: 'Acme (Ontology)', pid: hex }, { name: 'Plain', pid: null }, { name: 'Ben', pid: 'b'.repeat(32) }]);
});

test('dates', () => {
  assert.equal(notionDate('November 3, 2026'), '2026-11-03');
  assert.equal(notionDate('May 12, 2025 4:21 PM'), '2025-05-12');
  assert.equal(notionDate('2026-09-22'), '2026-09-22');
  assert.equal(freeDate('slack:example-workspace:C0:1790883092.003079', 'UTC'), '2026-10-01');
  assert.equal(parseCsv('a,b\n"x, y","z ""q"""\n')[0].b, 'z "q"');
});

test('mapBody moves verbatim sections under Captured text', () => {
  const page = splitNotionPage('# T\n\nLink: https://x.example\nSource: Web\n\n> 💡 A summary. More.\n> \n\n## Key takeaways for X\n\n- one\n\n## Thread summary\n\nS\n\n## Full thread\n\n### Ada · 2026-01-01 10:00\n\nHello\n\n## Source\n\n- Captured 2026-10-30\n');
  assert.equal(page.props.Link, 'https://x.example');
  const m = mapBody(page.body, { canonical: 'https://x.example/' });
  assert.match(m.body, /^## Summary\n\nA summary\. More\./);
  assert.match(m.body, /## Key takeaways\n/);
  assert.match(m.body, /## Captured text\n\n### Ada · 2026-01-01 10:00\n\nHello\n\n## Source\n\n`https:\/\/x.example\/`\n\n- Captured 2026-10-30/);
  assert.equal(m.captured, '### Ada · 2026-01-01 10:00\n\nHello');
});
