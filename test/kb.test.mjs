import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { itemId, fileName, idHash, kebab } from '../lib/ids.mjs';
import { capturedHash, insertHeadings, applyPatch, normalizeCaptured } from '../lib/captured.mjs';
import { vttToTranscript } from '../lib/vtt.mjs';
import { extractArticle } from '../lib/extract.mjs';
import { readMd, writeMd, capturedSection } from '../lib/md.mjs';

const KB = path.resolve('bin/kb.mjs');
const SAMPLES = path.resolve('samples');

const vectors = [
  ['https://youtu.be/xeiU5UTffsw?si=iilVuhe-wzfZ9fol', 'yt:xeiU5UTffsw'],
  ['https://youtu.be/-1n2DEkN6Mk?si=abc', 'yt:-1n2DEkN6Mk'],
  ['https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001?updateEntityUrn=x', 'li:7000000000000000001'],
  ['https://example-workspace.slack.com/archives/C0000000000/p1790888301414749?thread_ts=1790883092.003079&cid=C0000000000', 'slack:example-workspace:C0000000000:1790883092.003079'],
  ['https://www.oreilly.com/library/view/the-context-engineering/0642572260705/', 'web:oreilly.com/library/view/the-context-engineering/0642572260705'],
  ['https://www.youtube.com/@examplechannel0000/videos', 'web:youtube.com/@examplechannel0000/videos'],
];
for (const [input, id] of vectors) test(`id ${id}`, () => assert.equal(itemId(input), id));

test('id: slack parent ts from permalink, tracking params dropped, identifying params sorted', () => {
  assert.equal(itemId('https://example-workspace.slack.com/archives/C0000000000/p1790883092003079'), 'slack:example-workspace:C0000000000:1790883092.003079');
  assert.equal(itemId('https://Example.com/a/b/?utm_source=x&z=2&a=1#frag'), 'web:example.com/a/b?a=1&z=2');
});

test('file names: kebab max 50, hash of id, case-safe', () => {
  assert.match(fileName('yt:xeiU5UTffsw', 'Keeping Docs Honest at Scale'), /^yt-keeping-docs-honest-at-scale-[0-9a-f]{8}\.md$/);
  assert.notEqual(idHash('yt:abcdefghijA'), idHash('yt:abcdefghija'));
  assert.ok(kebab('x'.repeat(80)).length <= 50);
});

const CAPTURED = 'Intro line.\n\n[00:00:00] Host: hello  world\n[00:00:30] Guest: second line\n\n![Slide 1: A](../assets/x/slide-001.webp)\n';

test('heading insertion leaves captured-text-sha256 unchanged', () => {
  const before = capturedHash(CAPTURED);
  const after = insertHeadings(CAPTURED, [{ line: 0, title: 'Intro' }, { line: 4, title: 'Second part' }]);
  assert.ok(after.includes('### Second part'));
  assert.equal(capturedHash(after), before);
  assert.notEqual(capturedHash(CAPTURED.replace('hello', 'bye')), before);
  assert.ok(!normalizeCaptured(after).includes('###'));
});

test('patch application changes frontmatter only and keeps the hash valid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
  const f = path.join(dir, 'x.md');
  const body = `## Summary\ns\n\n## Captured text\n${CAPTURED}\n## Source\n\`https://example.com\`\n`;
  writeMd(f, { id: 'web:example.com', 'captured-text-sha256': capturedHash(CAPTURED), concepts: ['A'] }, body);
  const { data, content } = readMd(f);
  writeMd(f, applyPatch(data, { concepts: ['B'], note: null }), content);
  const out = readMd(f);
  assert.deepEqual(out.data.concepts, ['B']);
  assert.equal(out.content, content);
  assert.equal(capturedHash(capturedSection(out.content)), out.data['captured-text-sha256']);
});

test('VTT converts to a stamped transcript and dedupes rolling captions', () => {
  const vtt = [
    'WEBVTT', '',
    '00:00:00.000 --> 00:00:02.000', 'Hello and welcome', '',
    '00:00:02.000 --> 00:00:04.000', 'Hello and welcome', 'to the show', '',
    '00:00:04.000 --> 00:00:06.000', 'to the show', '',
    '00:00:31.000 --> 00:00:33.000', '<c>Second</c> block', '',
  ].join('\n');
  assert.equal(vttToTranscript(vtt), '[00:00:00] Hello and welcome to the show\n[00:00:31] Second block');
});

for (const n of [1, 2, 3]) {
  test(`article extraction fixture ${n}`, () => {
    const r = extractArticle(fs.readFileSync(`test/fixtures/article${n}.html`, 'utf8'), 'https://sample.example/post');
    assert.ok(r.title.length > 5);
    assert.equal(r.published, `2026-0${n}-0${n}`);
    assert.match(r.markdown, /fictional/);
    assert.ok(!r.markdown.includes('Footer links'));
  });
}

const kb = (root, ...args) => spawnSync(process.execPath, [KB, ...args, '--root', root], { encoding: 'utf8' });
const copySamples = () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kbs-'));
  const dir = path.join(base, 'samples');
  fs.cpSync(SAMPLES, dir, { recursive: true });
  fs.cpSync(path.resolve('schema'), path.join(base, 'schema'), { recursive: true }); // manni.config.yaml points at ../schema
  return dir;
};
const itemFile = (d, prefix) => path.join(d, 'items', fs.readdirSync(path.join(d, 'items')).find((n) => n.startsWith(prefix)));

test('samples pass every check', () => {
  const r = kb(SAMPLES, 'validate');
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('check-captured-text catches edited wording', () => {
  const d = copySamples();
  const p = itemFile(d, 'slack-');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('fail the build', 'fail every build'));
  assert.equal(kb(d, 'check-captured-text').status, 1);
});

test('check-ids catches a renamed file; check-refs catches a missing tool', () => {
  const d = copySamples();
  const p = itemFile(d, 'yt-linting');
  fs.renameSync(p, path.join(d, 'items', 'yt-linting-docs-00000000.md'));
  assert.equal(kb(d, 'check-ids').status, 1);
  fs.rmSync(path.join(d, 'tools', 'lintly.md'));
  assert.equal(kb(d, 'check-refs').status, 1);
});

test('check-vocab catches a label used in two schemes', () => {
  const d = copySamples();
  const p = path.join(d, 'concepts', 'topics', 'docs-as-code.md');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('label: Docs as code', 'label: Docs as code\nalt-labels: [Diataxis]'));
  assert.equal(kb(d, 'check-vocab').status, 1);
});

test('manni rejects a concept outside the generated vocabulary', () => {
  const d = copySamples();
  const p = itemFile(d, 'li-a-note');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('- Content drift', '- Not a real topic'));
  const r = kb(d, 'validate');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Not a real topic|enum|allowed values/i);
});

test('rename-term updates items and logs the change', () => {
  const d = copySamples();
  assert.equal(kb(d, 'rename-term', 'Content drift', 'Docs drift detection').status, 0);
  const r = kb(d, 'validate');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(fs.readFileSync(path.join(d, 'concepts', 'CHANGELOG.md'), 'utf8'), /renamed "Content drift"/);
});

test('find-entity ignores case; kb id works', () => {
  assert.match(kb(SAMPLES, 'find-entity', 'DRIFT CHECK').stdout, /tools\/driftcheck/);
  assert.equal(kb(SAMPLES, 'id', 'https://youtu.be/xeiU5UTffsw?si=a').stdout.trim(), 'yt:xeiU5UTffsw');
});
