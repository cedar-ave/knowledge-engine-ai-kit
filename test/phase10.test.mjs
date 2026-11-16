import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLinks, findItem, findParent, parentType, countMessages, sharedLinks, slackResource, ingestBrowser, lineFor, cleanTitle } from '../lib/add.mjs';
import { facetFilter, rankWithFilter, hitSegment, originalLink, parseResearchArgs, expandEvents } from '../lib/research.mjs';
import { loadItems } from '../lib/entities.mjs';
import { readMd } from '../lib/md.mjs';
import { capturedHash } from '../lib/captured.mjs';

function copySamples() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-p10-'));
  fs.cpSync('samples', dir, { recursive: true });
  return dir;
}

test('parseLinks: per-URL flags, quoted note and bare words as note', () => {
  const l = parseLinks(['https://example.com/a', 'great', 'API', 'reference', '--bookmark', 'https://example.com/b', '--note', 'try-it console', '--type', 'blog', '--best', '--shared-in', 'slack:example-workspace:C0000000000:1700000000.000001']);
  assert.deepEqual(l, [
    { url: 'https://example.com/a', note: 'great API reference', bookmark: true },
    { url: 'https://example.com/b', note: 'try-it console', type: 'blog', best: true, sharedIn: 'slack:example-workspace:C0000000000:1700000000.000001' },
  ]);
  assert.throws(() => parseLinks(['note first']));
});

test('findItem: by id or URL; missing returns only the id', () => {
  const root = copySamples();
  const r = findItem(root, 'https://docs.acme-docs.example/');
  assert.equal(r.id, 'web:docs.acme-docs.example');
  assert.match(r.file, /^items\/web-acme-docs-developer-portal-/);
  assert.deepEqual(findItem(root, 'https://www.youtube.com/watch?v=AbCdEf12345&si=x'), { id: 'yt:AbCdEf12345' });
});

test('findParent: longest saved source prefix, or the given channel URL; parentType hint', () => {
  const items = loadItems(copySamples());
  assert.equal(findParent(items, 'https://docs.acme-docs.example/guides/start')?.data.id, 'web:docs.acme-docs.example');
  assert.equal(findParent(items, 'https://example.com/elsewhere'), undefined);
  assert.equal(findParent(items, 'https://www.youtube.com/watch?v=AbCdEf12345', ['https://www.youtube.com/@nobody']), undefined);
  assert.equal(parentType('talk', 'https://www.youtube.com/watch?v=AbCdEf12345'), 'channel');
  assert.equal(parentType('docs-page', 'https://example.com/docs/x'), 'docs-site');
  assert.equal(parentType('article', 'https://example.com/blog/x'), 'blog');
  assert.equal(parentType('article', 'https://example.com/x'), 'website');
});

test('browser text: message count, shared links, Slack resource', () => {
  const text = '[2026-05-04 09:12] Jane Doe: See https://example.com/guide.\nmore lines\n\n[+2w] ↳ Sam Roe: thanks https://example-workspace.slack.com/archives/C0000000000/p1 and https://www.linkedin.com/in/someone';
  assert.equal(countMessages(text), 2);
  assert.deepEqual(sharedLinks(text), ['https://example.com/guide']);
  assert.equal(slackResource('slack:example-workspace:C0000000000:1700000000.000001'), 'https://example-workspace.slack.com/archives/C0000000000/p1700000000000001');
});

test('ingest-browser: Slack download → verbatim item; count mismatch noted; refresh appends only new messages', async () => {
  const root = copySamples();
  const inbox = path.join(root, 'migration', 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  const url = 'https://example-workspace.slack.com/archives/C0000000000/p1700000000000002?thread_ts=1700000000.000001&cid=C0000000000';
  const msgs = ['[2023-11-14 22:13] Jane Doe: How do you lint docs in CI? https://example.com/vale', '[2023-11-14 22:20] Sam Roe: We run a style linter on every PR.'];
  fs.writeFileSync(path.join(inbox, 't.md'), `---\nurl: "${url}"\nchannel: "#docs"\nexpected: 3\n---\n${msgs.join('\n\n')}\n`);
  const r = await ingestBrowser(root, path.join(inbox, 't.md'), { note: 'useful thread', tag: false });
  assert.equal(r.status, 'added');
  assert.equal(r.messages, 2);
  assert.match(r.notes[0], /message count 2 ≠ 3/);
  assert.deepEqual(r.links, ['https://example.com/vale']);
  assert.ok(fs.existsSync(path.join(inbox, 'processed', 't.md')));
  const it = readMd(path.join(root, r.file));
  assert.equal(it.data.id, 'slack:example-workspace:C0000000000:1700000000.000001');
  assert.equal(it.data.resource, 'https://example-workspace.slack.com/archives/C0000000000/p1700000000000001');
  assert.equal(it.data['slack-channel'], '#docs');
  assert.equal(it.data.published, '2023-11-14');
  assert.equal(it.data.note, 'useful thread');
  assert.equal(it.data['title-devised'], true);
  assert.match(it.content, /## Captured text\n\n\[2023-11-14 22:13\] Jane Doe: How do you lint/);
  // Refresh: one old message, one new.
  fs.writeFileSync(path.join(inbox, 't2.md'), `---\nurl: "${url}"\n---\n${msgs[1]}\n\n[2023-11-15 08:00] Ann Poe: Same here.\n`);
  const r2 = await ingestBrowser(root, path.join(inbox, 't2.md'), { refresh: true, tag: false });
  assert.equal(r2.status, 'refreshed');
  assert.equal(r2.appended, 1);
  const it2 = readMd(path.join(root, r.file));
  const cap = it2.content.match(/## Captured text\n\n([\s\S]*?)\n\n## Source/)[1];
  assert.equal(countMessages(cap), 3);
  assert.equal(it2.data['captured-text-sha256'], capturedHash(cap));
  // Without --refresh an existing item is left alone.
  fs.writeFileSync(path.join(inbox, 't3.md'), `---\nurl: "${url}"\n---\n${msgs[0]}\n`);
  assert.equal((await ingestBrowser(root, path.join(inbox, 't3.md'), { tag: false })).status, 'exists');
});

test('lineFor: reply lines', () => {
  assert.equal(lineFor({ status: 'added', type: 'blog', bookmark: true, title: 'T', file: 'items/x.md', notes: [] }), 'Saved as blog bookmark: T (items/x.md)');
  assert.equal(lineFor({ status: 'added', type: 'article', bookmark: false, title: 'T', file: 'items/x.md', notes: ['blog not saved'] }), 'Saved as article: T (items/x.md)\n  blog not saved');
});

test('research: facet filter, ranking with filter matches first, published sort', () => {
  const catalog = [
    { id: 'a', 'knowledge-types': ['how-to'], published: '2024' },
    { id: 'b', 'knowledge-types': ['case-study'], 'first-hand': true, published: '2025-01' },
    { id: 'c', 'knowledge-types': ['case-study'], 'first-hand': false, published: '2026' },
    { id: 'd', 'knowledge-types': ['Case-Study'], 'first-hand': true, published: '2026-03' },
  ];
  assert.equal(facetFilter({}), null);
  const pred = facetFilter({ facets: { 'knowledge-types': ['case-study'] }, firstHand: true });
  assert.deepEqual(catalog.filter(pred).map((c) => c.id), ['b', 'd']);
  assert.deepEqual(rankWithFilter(['a', 'b', 'c'], catalog, pred), ['b', 'a', 'c', 'd']);
  assert.deepEqual(rankWithFilter(['a', 'b', 'c'], catalog, pred, { strict: true }), ['b', 'd']);
  assert.deepEqual(rankWithFilter(['a', 'b', 'c', 'd'], catalog, null, { sort: 'published' }), ['d', 'c', 'b', 'a']);
});

test('research: segment of a hit and timestamped YouTube link', () => {
  const entry = { id: 'yt:AbCdEf12345', resource: 'https://www.youtube.com/watch?v=AbCdEf12345', segments: [{ slug: 'intro', title: 'Intro', start: '00:00:00' }, { slug: 'the-drift-gate', title: 'The drift gate', start: '00:12:40' }] };
  const body = '## Captured text\n\n### Intro\n\n[00:00:00] hi\n\n### The drift gate\n\n[00:12:40] gate text here';
  const seg = hitSegment({ body, bestChunkPos: body.indexOf('gate text') }, entry);
  assert.deepEqual(seg, { slug: 'the-drift-gate', title: 'The drift gate', start: '00:12:40' });
  assert.equal(originalLink(entry, seg), 'https://www.youtube.com/watch?v=AbCdEf12345&t=760');
  assert.equal(hitSegment({ body: 'no headings', bestChunkPos: 3 }, entry), undefined);
  assert.equal(originalLink({ id: 'web:example.com/a', resource: 'https://example.com/a' }, { start: '00:01:00' }), 'https://example.com/a');
});

test('research: argument parsing and event editions', () => {
  const { question, opts } = parseResearchArgs(['what', 'tools', '--tools', 'vale, other', '--first-hand', '--k', '5', '--sort', 'published', 'lint']);
  assert.equal(question, 'what tools lint');
  assert.deepEqual(opts, { facets: { tools: ['vale', 'other'] }, firstHand: true, k: 5, sort: 'published' });
  assert.throws(() => parseResearchArgs(['q', '--nope', 'x']));
  const root = copySamples();
  fs.writeFileSync(path.join(root, 'events', 'sample-docs-conf.md'), '---\ntype: event\ntitle: Sample Docs Conf\ndescription: Recurring.\nstart-date: 2026\n---\n');
  const ed = readMd(path.join(root, 'events', 'sample-docs-conf-2026.md'));
  fs.writeFileSync(path.join(root, 'events', 'sample-docs-conf-2026.md'), `---\n${Object.entries({ ...ed.data, 'part-of': 'sample-docs-conf' }).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n`);
  assert.deepEqual(expandEvents(root, ['sample-docs-conf']), ['sample-docs-conf', 'sample-docs-conf-2026']);
});

test('cleanTitle: drops a trailing site name and GitHub boilerplate, keeps real titles', () => {
  assert.equal(cleanTitle('Docs that last | Example', 'https://example.com/post'), 'Docs that last');
  assert.equal(cleanTitle('Docs that last — Example.com', 'https://www.example.com/post'), 'Docs that last');
  assert.equal(cleanTitle('GitHub - acme/docs-starter: A starter repo', 'https://github.com/acme/docs-starter'), 'acme/docs-starter');
  assert.equal(cleanTitle('Docs Hierarchy of Priorities: A Proposal', 'https://example.com/x'), 'Docs Hierarchy of Priorities: A Proposal');
  assert.equal(cleanTitle('Writing - A Field Guide', 'https://example.com/x'), 'Writing - A Field Guide');
});

test('planTag: empty concepts with a proposed topic passes; the candidate becomes the concept', async () => {
  const { planTag } = await import('../lib/tag.mjs');
  const root = copySamples();
  const file = path.join(root, 'items', 'web-docs-talk-sample-podcast-27916efc.md');
  const out = { type: 'podcast', title: null, 'title-devised': false, description: 'A sample podcast about docs.', concepts: [], genre: [], 'knowledge-types': ['reference'],
    'example-of': [], 'lifecycle-stages': [], 'org-contexts': [], 'doc-types': [], organizations: [], tools: [], authors: [], hosts: [], guests: [], 'first-hand': null, published: null,
    'sample-questions': ['Which podcasts cover docs?'], segments: [], summary: null, 'key-takeaways': null, 'tools-mentioned': null, 'articles-resources': null, 'new-entities': [],
    'candidate-terms': [{ scheme: 'topics', label: 'Technical communication careers', description: 'Careers in tech comm.', 'scope-note': 'Use for career talk.', broader: [] }],
    confidence: { type: 0.9 }, notes: '' };
  const r = planTag(root, file, out);
  assert.equal(r.errors, undefined, String(r.errors));
  assert.deepEqual(r.plan.data.concepts, ['Technical communication careers']);
});

test('term-usage --new-only: new candidates, and candidates that just reached two items', async () => {
  const { newCandidateLines } = await import('../lib/vocab.mjs');
  const u = (label, items, file, status = 'candidate') => ({ term: { scheme: 'topics', label, status, relFile: file }, items });
  const usage = [
    u('Fresh', ['items/a.md'], 'concepts/topics/fresh.md'),
    u('Pair', ['items/a.md', 'items/b.md'], 'concepts/topics/pair.md'),
    u('Old pair', ['items/c.md', 'items/d.md'], 'concepts/topics/old-pair.md'),
    u('Many', ['items/a.md', 'items/c.md', 'items/d.md'], 'concepts/topics/many.md'),
    u('Approved', ['items/a.md', 'items/b.md'], 'concepts/topics/approved.md', 'approved'),
  ];
  assert.deepEqual(newCandidateLines(usage, { added: new Set(['concepts/topics/fresh.md']), changed: new Set(['items/a.md']) }), [
    'New candidate "Fresh" (topics), used by 1 item.',
    'Candidate "Pair" is now used by 2 items. Approve it?',
  ]);
  assert.deepEqual(newCandidateLines(usage, { added: new Set(), changed: new Set() }), []);
});

test('suggested-alt-labels: only assigned terms, only wording not already a label', async () => {
  const { suggestedAltLabels } = await import('../lib/tag.mjs');
  const terms = [{ scheme: 'topics', label: 'Content drift', 'alt-labels': ['stale docs'] }, { scheme: 'topics', label: 'Docs-as-code' }];
  const resolve = (_s, v) => terms.find((t) => t.label.toLowerCase() === String(v).toLowerCase())?.label;
  const out = { 'suggested-alt-labels': [{ term: 'Content drift', wording: 'doc rot' }, { term: 'content drift', wording: 'Stale docs' }, { term: 'Docs-as-code', wording: 'docs in git' }, { term: 'Content drift', wording: 'Doc rot' }] };
  assert.deepEqual(suggestedAltLabels(out, { concepts: ['Content drift'] }, resolve, terms), [{ term: 'Content drift', scheme: 'topics', wording: 'doc rot' }]);
});

test('tool links: tool file resource first, else a URL from the item text (saved), never one the text lacks', async () => {
  const { renderToolsMentioned, fillSection, urlInText } = await import('../lib/toollinks.mjs');
  const tools = [{ slug: 'vale', title: 'Vale', resource: 'https://example.com/vale' }, { slug: 'acme-lint', title: 'Acme Lint', file: 'tools/acme-lint.md' }, { slug: 'other', title: 'Other' }];
  const text = 'We use Acme Lint (https://example.com/acme-lint/) in CI.';
  const r = renderToolsMentioned([
    { tool: 'vale', url: 'https://example.com/elsewhere', said: 'style rules' },
    { tool: 'acme-lint', url: 'https://example.com/acme-lint', said: 'runs in CI' },
    { tool: 'other', url: 'https://example.com/from-memory', said: 'mentioned' },
    { tool: 'Unknown Tool', url: null, said: 'named once' },
  ], tools, text);
  assert.deepEqual(r.lines, [
    '- **Vale** ([link](https://example.com/vale)): style rules',
    '- **Acme Lint** ([link](https://example.com/acme-lint)): runs in CI',
    '- **Other**: mentioned',
    '- **Unknown Tool**: named once',
  ]);
  assert.deepEqual(r.setResource.map((s) => [s.tool.slug, s.url]), [['acme-lint', 'https://example.com/acme-lint']]);
  assert.equal(urlInText('https://example.com/acme-lint', text), true);
  assert.equal(urlInText('https://example.com/from-memory', text), false);
  const f = fillSection('- **vale**: style\n- **Vale** ([link](https://old.example.com)): x\n- **Vale** ([docs](https://example.com/d)): custom\n- **Other**: y', tools);
  assert.equal(f.changed, 1);
  assert.equal(f.text, '- **vale** ([link](https://example.com/vale)): style\n- **Vale** ([link](https://old.example.com)): x\n- **Vale** ([docs](https://example.com/d)): custom\n- **Other**: y');
});
