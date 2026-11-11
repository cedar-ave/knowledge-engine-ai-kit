import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitFindings, isTagFieldError } from '../lib/migration.mjs';
import { relevanceSignals, relevanceFlags } from '../lib/fetch.mjs';
import { regen } from '../lib/generated.mjs';

const ITEM = './node_modules/knowledge-engine-ai-kit/schema/kb-item.schema.json';

test('migration mode: tag-field errors on untagged items are warnings; others still fail', () => {
  const results = [
    { file: 'items/a-00000000.md', errors: [
      { schema: ITEM, keyword: 'required', subject: 'concepts', message: 'x' },
      { schema: ITEM, keyword: 'maxItems', instancePath: '/tools', message: 'x' },
      { schema: ITEM, keyword: 'required', subject: 'slack-channel', message: 'x' },
    ] },
    { file: 'items/b-00000000.md', errors: [{ schema: ITEM, keyword: 'required', subject: 'concepts', message: 'x' }] },
    { file: 'events/e.md', errors: [{ schema: 'kb-entity.schema.json', keyword: 'required', subject: 'start-date', message: 'x' }] },
  ];
  const { errors, warnings } = splitFindings(results, new Set(['items/b-00000000.md']));
  assert.equal(warnings.length, 2);
  assert.deepEqual(errors.map((e) => e.file), ['items/a-00000000.md', 'items/b-00000000.md', 'events/e.md']);
  assert.ok(!isTagFieldError({ schema: ITEM, keyword: 'pattern', instancePath: '/concepts/0' }));
});

test('relevance: article text scores high; sidebar text scores low', () => {
  const good = relevanceSignals({ title: 'Gating builds on docs drift', summary: 'How a team gates builds when docs drift from the API spec.', text: 'Gating builds on docs drift: a team gates builds on every pull request. When the API spec and the docs drift apart, the build fails.' });
  assert.ok(good.title > 0.9 && good.summary > 0.5 && good.links === 0);
  const bad = relevanceSignals({ title: 'Gating builds on docs drift', summary: 'How a team gates builds when docs drift.', text: '[Home](/) [About the author](/about) [Newsletter archive](/n) [Subscribe](/s) for weekly stories.' });
  assert.ok(bad.title < 0.34 && bad.links > 0.4);
});

test('relevance flags: boilerplate repeated across pages of one site', () => {
  const boiler = 'This newsletter is written by a fictional author who builds tools and writes about them every single week for readers.';
  const mk = (n) => ({ data: { capture: 'full-text', title: `Post ${n} about drift`, resource: `https://example.com/p/${n}` }, content: `## Summary\n\nPost about drift.\n\n## Captured text\n\n${boiler}\n\n## Source\n` });
  const flags = relevanceFlags([mk(1), mk(2)]);
  assert.equal(flags.length, 2);
  assert.match(flags[0].why.join(), /repeats on other example\.com pages/);
});

test('regen --check reports a committed generated file that is out of date', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-regen-'));
  fs.mkdirSync(path.join(root, 'migration'), { recursive: true });
  fs.writeFileSync(path.join(root, 'migration', 'content-digest.md'), 'stale\n');
  assert.deepEqual(regen(root, { check: true }), ['migration/content-digest.md']);
  regen(root);
  assert.deepEqual(regen(root, { check: true }), []);
});
