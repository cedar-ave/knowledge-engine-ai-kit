// Phase 10 Claude desktop: a small stdio MCP server (newline-delimited JSON-RPC 2.0) exposing kb_research and kb_get.
// Adding items stays in Claude Code (shell, git, browser); this server is read-only.
import path from 'node:path';
import readline from 'node:readline';
import { research, FACETS } from './research.mjs';
import { openRetriever } from './search.mjs';
import { loadItems } from './entities.mjs';
import { githubSlug, capturedSection } from './md.mjs';

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const list = { type: 'array', items: { type: 'string' } };

export const TOOLS = [
  {
    name: 'kb_research',
    description: 'Search the knowledge base for a question. Returns ranked results (fast mode, catalog weight 1.5) with original links (YouTube links timestamped), #segment anchors, knowledge types, first-hand, best, note and the matched chunk. Group the answer as Best practices · Case studies (first-hand) · Examples · Tools · Latest, and use only links from the results.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: "The question, in the owner's words." },
        k: { type: 'integer', minimum: 1, maximum: 50, description: 'Number of results (default 12).' },
        ...Object.fromEntries(FACETS.map((f) => [f, { ...list, description: `Filter: ${f} values or slugs (any of).` }])),
        'first-hand': { type: 'boolean', description: 'Only first-hand accounts.' },
        best: { type: 'boolean', description: 'Only items marked best.' },
        sort: { type: 'string', enum: ['published', 'best'] },
        strict: { type: 'boolean', description: 'Drop results that do not pass the filters.' },
      },
      required: ['question'],
    },
  },
  {
    name: 'kb_get',
    description: 'Read one item by ID (for example web:example.com/post or yt:VIDEOID): frontmatter, Summary and Key takeaways, plus one captured-text segment when segment (its slug, the part after # in a result file) is given. Never returns the whole transcript.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, segment: { type: 'string', description: 'Segment slug.' } },
      required: ['id'],
    },
  },
];

/** "## <name>" section body, up to the next "## " heading. */
function section(content, name) {
  const re = new RegExp(`^## ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*\\n([\\s\\S]*?)(?=^## (?!#)|(?![\\s\\S]))`, 'm');
  return content.match(re)?.[1].trim() ?? null;
}

/** One "### " segment of the captured text, by GitHub slug. */
function segmentText(content, slug) {
  const cap = capturedSection(content);
  if (!cap) return null;
  const parts = cap.split(/^(?=### )/m);
  const hit = parts.find((p) => p.startsWith('### ') && githubSlug(p.slice(4).split('\n')[0]) === slug);
  return hit ? hit.trim() : null;
}

export function getItem(root, id, segment) {
  const it = loadItems(root).find((x) => x.data.id === id);
  if (!it) throw new Error(`no item with id ${id}`);
  const out = { id, file: path.relative(root, it.file).split(path.sep).join('/'), frontmatter: it.data,
    summary: section(it.content, 'Summary'), 'key-takeaways': section(it.content, 'Key takeaways') };
  if (segment) {
    out.segment = segmentText(it.content, segment);
    if (out.segment == null) throw new Error(`no segment ${segment} in ${id}`);
  }
  return out;
}

async function callTool(root, name, a = {}, deps) {
  if (name === 'kb_research') {
    if (!a.question?.trim()) throw new Error('question is required');
    // One retriever for the whole session, so qmd models load once.
    deps.retriever ??= await openRetriever(root);
    const facets = Object.fromEntries(FACETS.filter((f) => a[f]?.length).map((f) => [f, [].concat(a[f])]));
    return research(root, a.question, { k: a.k ?? 12, facets, firstHand: !!a['first-hand'], best: !!a.best, sort: a.sort, strict: !!a.strict, retriever: deps.retriever });
  }
  if (name === 'kb_get') return getItem(root, a.id, a.segment);
  throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
}

/** One JSON-RPC message → response object, or null for notifications. */
export async function handle(root, msg, deps = {}) {
  const { id, method, params = {} } = msg;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  if (id === undefined) return null;
  try {
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'knowledge-engine-ai', version: deps.version ?? '0.0.0' },
        });
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'tools/call':
        try {
          const res = await callTool(root, params.name, params.arguments, deps);
          return reply({ content: [{ type: 'text', text: JSON.stringify(res, null, 1) }] });
        } catch (e) {
          if (e.code) throw e;
          return reply({ content: [{ type: 'text', text: e.message }], isError: true });
        }
      default: return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
    }
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: e.code ?? -32603, message: e.message } };
  }
}

/** kb mcp: serve on stdin/stdout. Anything else written to stdout (qmd warnings, console.log) goes to stderr. */
export async function serve(root, deps = {}) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => process.stderr.write(chunk, ...rest);
  console.log = console.error;
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`); continue; }
    const res = await handle(root, msg, deps);
    if (res) write(`${JSON.stringify(res)}\n`);
  }
  await deps.retriever?.close?.();
}
