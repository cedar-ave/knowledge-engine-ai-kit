import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planTag, applyTag, tagOne } from '../lib/tag.mjs';
import { readMd } from '../lib/md.mjs';
import { checkSegments, checkCapturedText } from '../lib/checks.mjs';
import { checkRefs } from '../lib/entities.mjs';
import { taggedItems } from '../lib/migration.mjs';
import { genVocab } from '../lib/vocab.mjs';

const ITEM = 'items/yt-keeping-docs-honest-at-scale-96f61ed0.md';

function copySamples() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-tag-'));
  fs.cpSync('samples', dir, { recursive: true });
  genVocab(dir); // vocab.compact.md is generated and git-ignored, so absent in a fresh checkout
  return dir;
}

const output = (over = {}) => ({
  type: 'episode', title: null, 'title-devised': false,
  description: 'A guest explains how their team gates releases on doc accuracy.',
  concepts: ['docs drift'], genre: ['interview'], 'knowledge-types': ['case-study'], 'example-of': [],
  'lifecycle-stages': ['validation-accuracy'], 'org-contexts': [], 'doc-types': [],
  organizations: ['acme-docs'], tools: ['driftcheck'], authors: [], hosts: [], guests: [],
  'first-hand': true, published: null,
  'sample-questions': ['How do I gate releases on docs drift?', 'What does a drift gate check?', 'Who runs DriftCheck on pull requests?'],
  segments: [
    { heading: 'Introduction', title: 'Introduction', 'knowledge-type': 'reference' },
    { 'insert-before': '[00:13:10]', title: 'Reaction', start: '00:13:10', 'knowledge-type': 'opinion-not-a-type' },
  ],
  summary: null, 'key-takeaways': null, 'tools-mentioned': null,
  'new-entities': [], 'candidate-terms': [],
  confidence: { type: 0.9, concepts: 0.9, 'knowledge-types': 0.8, segments: 0.6 }, notes: '',
  ...over,
});

test('planTag rejects unknown notations, type outside candidates and unknown slugs', () => {
  const root = copySamples();
  const r = planTag(root, path.join(root, ITEM), output({ type: 'article', tools: ['nope'] }));
  assert.ok(r.errors.some((e) => e.includes('type "article"')));
  assert.ok(r.errors.some((e) => e.includes('opinion-not-a-type')));
  assert.ok(r.errors.some((e) => e.includes('"nope"')));
});

test('planTag + applyTag: alt-labels resolve, headings insert without changing the hash, candidates and entities are created', () => {
  const root = copySamples();
  const out = output({
    segments: [
      { heading: 'Introduction', title: 'Introduction', 'knowledge-type': 'reference' },
      { 'insert-before': '[00:13:10]', title: 'Reaction', start: '00:13:10', 'knowledge-type': 'case-study', tools: ['drift-check-pro'] },
    ],
    'new-entities': [
      { kind: 'tool', slug: 'drift-check', title: 'DriftCheck', description: 'Reused by find-entity.', resource: null, 'alt-labels': [] },
      { kind: 'tool', slug: 'drift-check-pro', title: 'DriftCheck Pro', description: 'A fictional tool.', resource: null, 'alt-labels': [] },
    ],
    'candidate-terms': [{ scheme: 'topics', label: 'Release gating', description: 'Blocking a release on docs checks.', broader: ['Content accuracy'] }],
    tools: ['drift-check'],
  });
  const { plan, errors } = planTag(root, path.join(root, ITEM), out);
  assert.equal(errors, undefined, errors?.join('\n'));
  assert.deepEqual(plan.data.concepts, ['Content drift', 'Release gating']);
  assert.deepEqual(plan.data.tools, ['driftcheck']);
  assert.ok(plan.review.some((r) => r.includes('segments 0.6')) && plan.review.some((r) => r.includes('Release gating')));
  applyTag(root, plan, 'claude-sonnet-test');
  assert.equal(checkSegments(root).length, 0);
  assert.equal(checkCapturedText(root).length, 0);
  assert.deepEqual(checkRefs(root), []);
  assert.ok(fs.existsSync(path.join(root, 'tools', 'drift-check-pro.md')));
  assert.equal(readMd(path.join(root, 'concepts', 'topics', 'release-gating.md')).data.status, 'candidate');
  assert.ok(taggedItems(root).has(ITEM));
  assert.match(readMd(path.join(root, ITEM)).content, /### Reaction\n\n\[00:13:10\]/);
});

test('tagOne retries once with the errors, then queues for review without writing', async () => {
  const root = copySamples();
  const before = fs.readFileSync(path.join(root, ITEM), 'utf8');
  let calls = 0;
  const call = async (prompt) => { calls++; if (calls === 2) assert.match(prompt, /failed validation/); return { json: output({ type: 'article' }), raw: '{}', model: 'm', cost: 0 }; };
  const r = await tagOne(root, path.join(root, ITEM), { call });
  assert.equal(calls, 2);
  assert.equal(r.status, 'failed');
  assert.equal(fs.readFileSync(path.join(root, ITEM), 'utf8'), before);
  assert.match(fs.readFileSync(path.join(root, 'migration', 'review-queue.md'), 'utf8'), /not tagged/);
});

test('planTag repairs segment headings: numbering and timestamps ignored, else the next unclaimed heading', () => {
  const root = copySamples();
  const out = output({ segments: [
    { heading: 'Unknown opening', title: 'Introduction', 'knowledge-type': 'reference' },
    { heading: '2. The drift gate ([12:40](https://example.com/watch?t=760))', title: 'The drift gate', 'knowledge-type': 'case-study' },
  ] });
  const { plan, errors } = planTag(root, path.join(root, ITEM), out);
  assert.equal(errors, undefined, errors?.join('\n'));
  assert.deepEqual(plan.data.segments.map((s) => s.slug), ['introduction', 'the-drift-gate']);
  assert.ok(plan.review.some((r) => r.includes('"Unknown opening" mapped to next heading "Introduction"')));
});

test('planTag matches insert-before on the first words without markup, and drops a segment with no anchor', () => {
  const root = copySamples();
  const out = output({ segments: [
    { heading: 'Introduction', title: 'Introduction', 'knowledge-type': 'reference' },
    { 'insert-before': '**Host** — that is a useful pattern!', title: 'Reaction', 'knowledge-type': 'case-study' },
    { 'insert-before': 'This line is not in the text at all', title: 'Missing', 'knowledge-type': 'how-to' },
  ] });
  const { plan, errors } = planTag(root, path.join(root, ITEM), out);
  assert.equal(errors, undefined, errors?.join('\n'));
  assert.deepEqual(plan.data.segments.map((s) => s.title), ['Introduction', 'Reaction']);
  assert.match(plan.content, /### Reaction\n\n\[00:13:10\] Host/);
  assert.ok(plan.review.some((r) => r.includes('"Missing" dropped')));
});

test('planTag drops duplicate list values instead of failing', () => {
  const root = copySamples();
  const out = output({ 'knowledge-types': ['example', 'case-study'], 'example-of': ['Interactive API console', 'try-it console'], tools: ['driftcheck', 'driftcheck'], segments: [] });
  const { plan, errors } = planTag(root, path.join(root, ITEM), out);
  assert.equal(errors, undefined, errors?.join('\n'));
  assert.deepEqual(plan.data['example-of'], ['Interactive API console']);
  assert.deepEqual(plan.data.tools, ['driftcheck']);
});

test('planTag files a tool slug used as an organization (and the reverse) under the requested kind', () => {
  const root = copySamples();
  const out = output({ organizations: ['driftcheck'], tools: ['acme-docs'], segments: [] });
  const { plan, errors } = planTag(root, path.join(root, ITEM), out);
  assert.equal(errors, undefined, errors?.join('\n'));
  const made = plan.newEntities.map((e) => path.relative(root, e.file).split(path.sep).join('/'));
  assert.deepEqual(made.sort(), ['organizations/driftcheck.md', 'tools/acme-docs.md']);
  assert.equal(plan.newEntities.find((e) => e.file.endsWith('driftcheck.md')).data.type, 'organization');
  applyTag(root, plan, 'claude-sonnet-test');
  assert.deepEqual(checkRefs(root), []);
});

test('knowledge-types at 0.6 is not queued for review; other fields still use 0.7', () => {
  const root = copySamples();
  const { plan } = planTag(root, path.join(root, ITEM), output({ confidence: { type: 0.9, concepts: 0.65, 'knowledge-types': 0.6, segments: 0.9 }, segments: [] }));
  assert.deepEqual(plan.review, ['low confidence: concepts 0.65']);
});

test('the retry prompt carries the errors and previous output, and only the context the errors need', async () => {
  const root = copySamples();
  const prompts = [];
  const call = async (prompt) => { prompts.push(prompt); return { json: output({ type: 'article', segments: [] }), raw: '{"type":"article"}', model: 'm', cost: 0 }; };
  await tagOne(root, path.join(root, ITEM), { call });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /type "article" is not one of the candidates/);
  assert.match(prompts[1], /\{"type":"article"\}/);
  assert.doesNotMatch(prompts[1], /## Vocabulary/);
  assert.doesNotMatch(prompts[1], /## Captured text/);
  assert.ok(prompts[1].length < prompts[0].length);
});

test('insert-before may anchor on a #### subheading of the captured text', () => {
  const root = copySamples();
  const file = path.join(root, ITEM);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('[00:13:10] Host:', '#### Host reaction\n[00:13:10] Host:').replace(/^captured-text-sha256:.*\n/m, ''));
  const out = output({ segments: [
    { heading: 'Introduction', title: 'Introduction', 'knowledge-type': 'reference' },
    { 'insert-before': '#### Host reaction', title: 'Reaction', 'knowledge-type': 'case-study' },
  ] });
  const { plan, errors } = planTag(root, file, out);
  assert.equal(errors, undefined, errors?.join('\n'));
  assert.match(plan.content, /### Reaction\n\n#### Host reaction/);
});
