import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { handle, getItem, TOOLS } from '../lib/mcp.mjs';
import { loadCatalog } from '../lib/search.mjs';

function copySamples() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-mcp-'));
  fs.cpSync('samples', dir, { recursive: true });
  return dir;
}

const call = (root, name, args, deps) => handle(root, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, deps);
const body = (res) => JSON.parse(res.result.content[0].text);

test('mcp: initialize, tools/list, notifications and unknown methods', async () => {
  const root = copySamples();
  const init = await handle(root, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { version: '9.9.9' });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(init.result.serverInfo.version, '9.9.9');
  assert.equal((await handle(root, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).result.protocolVersion, '2025-06-18');
  assert.equal(await handle(root, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await handle(root, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['kb_research', 'kb_get']);
  assert.equal((await handle(root, { jsonrpc: '2.0', id: 3, method: 'nope' })).error.code, -32601);
  assert.equal((await call(root, 'nope', {})).error.code, -32602);
});

test('mcp kb_get: frontmatter, Summary, Key takeaways and one segment; errors are tool errors', async () => {
  const root = copySamples();
  const r = getItem(root, 'yt:EPISODE0001', 'the-drift-gate');
  assert.match(r.file, /^items\/yt-keeping-docs-honest-at-scale-/);
  assert.equal(r.frontmatter.title, 'Keeping Docs Honest at Scale');
  assert.equal(r.summary, 'A fictional item used to test the knowledge base tooling.');
  assert.match(r['key-takeaways'], /^- Sample takeaway one\./);
  assert.match(r.segment, /^### The drift gate\n/);
  assert.doesNotMatch(r.segment, /Introduction/);
  assert.equal(getItem(root, 'yt:EPISODE0001').segment, undefined);
  const bad = await call(root, 'kb_get', { id: 'yt:EPISODE0001', segment: 'no-such' });
  assert.equal(bad.result.isError, true);
  assert.equal((await call(root, 'kb_get', { id: 'web:missing.example' })).result.isError, true);
});

test('mcp kb_research: same results as kb research, with facet filters and a segment-timestamped link', async () => {
  const root = copySamples();
  const cat = loadCatalog(root);
  const ep = cat.find((c) => c.id === 'yt:EPISODE0001');
  const others = cat.filter((c) => c.id !== ep.id).slice(0, 3).map((c) => c.id);
  const asked = [];
  const retriever = {
    async retrieve(mode, question, k) {
      asked.push({ mode, question, k });
      const body = fs.readFileSync(path.join(root, ep.file), 'utf8');
      return { ids: [ep.id, ...others], ms: 1, explain: { terms: ['Content drift'] },
        hits: [{ file: `qmd://kb-items/${path.posix.basename(ep.file)}`, body, bestChunkPos: body.indexOf('### The drift gate') + 30, bestChunk: 'drift gate text' }] };
    },
  };
  const r = body(await call(root, 'kb_research', { question: 'How do I gate releases on drift?', 'knowledge-types': ['case-study'], k: 2 }, { retriever }));
  assert.deepEqual(asked, [{ mode: 'fast', question: 'How do I gate releases on drift?', k: 40 }]);
  assert.deepEqual(r.terms, ['Content drift']);
  assert.deepEqual(r.filters, { 'knowledge-types': ['case-study'] });
  assert.equal(r.results.length, 2);
  assert.equal(r.results[0].id, 'yt:EPISODE0001');
  assert.equal(r.results[0].link, 'https://www.youtube.com/watch?v=EPISODE0001&t=760');
  assert.match(r.results[0].file, /#the-drift-gate$/);
  assert.equal(r.results[0].filter, true);
  assert.equal((await call(root, 'kb_research', { question: ' ' }, { retriever })).result.isError, true);
  assert.ok(TOOLS[0].inputSchema.properties['knowledge-types']);
});

test('kb mcp over stdio: JSON-RPC lines in, only JSON-RPC lines out', async () => {
  const root = copySamples();
  const child = spawn(process.execPath, [path.resolve('bin/kb.mjs'), 'mcp', '--root', root], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'kb_get', arguments: { id: 'yt:EPISODE0001' } } });
  child.stdin.end();
  const code = await new Promise((res) => child.on('close', res));
  assert.equal(code, 0);
  assert.deepEqual(lines.map((l) => l.id), [1, 2, 3]);
  assert.equal(lines[0].result.serverInfo.name, 'knowledge-engine-ai');
  assert.equal(lines[1].result.tools.length, 2);
  assert.equal(JSON.parse(lines[2].result.content[0].text).frontmatter.id, 'yt:EPISODE0001');
});
