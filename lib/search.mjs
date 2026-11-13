// Phase 7: qmd index over items, concepts and entities; catalog.jsonl for facet filtering;
// the two retrieval modes compared in Phase 9 (qmd's LLM query vs. thesaurus-expanded lex + vec).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadItems, loadConfig, asList } from './entities.mjs';
import { loadTerms, refValue, CLOSED } from './vocab.mjs';

export const COLLECTIONS = [
  { name: 'kb-items', dir: 'items', pattern: '**/*.md',
    context: 'Docs knowledge items: frontmatter facets, summary, takeaways, verbatim captured text split into ### segments' },
  { name: 'kb-concepts', dir: 'concepts', pattern: '**/*.md', ignore: ['CHANGELOG.md'],
    context: 'Controlled vocabulary terms (SKOS): label, alt-labels, scope note, broader and related terms for topics, docs artifacts, frameworks and closed facets' },
  { name: 'kb-entities', dir: '.', pattern: '{tools,people,organizations,events,series}/**/*.md',
    context: 'Entities referenced by items: tools, people, organizations, events and series, with alt-labels and profile links' },
];

const HIDDEN_FACETS = ['captured-text-sha256', 'notion-url', 'legacy-tags', 'type-candidates', 'segments'];
const fold = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');

/** catalog.jsonl: one line per item, every frontmatter facet plus segment slugs and titles, no body text. */
export function buildCatalog(root, out = path.join(root, 'catalog.jsonl')) {
  const lines = loadItems(root).sort((a, b) => a.file.localeCompare(b.file)).map((it) => {
    const facets = Object.fromEntries(Object.entries(it.data).filter(([k]) => !HIDDEN_FACETS.includes(k)));
    const segments = asList(it.data.segments).map((s) => ({ slug: s.slug, title: s.title, ...(s.start ? { start: s.start } : {}) }));
    return JSON.stringify({ file: rel(root, it.file), ...facets, ...(segments.length ? { segments } : {}) });
  });
  fs.writeFileSync(out, lines.join('\n') + '\n');
  return lines.length;
}

export function loadCatalog(root) {
  const f = path.join(root, 'catalog.jsonl');
  if (!fs.existsSync(f)) buildCatalog(root);
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** The qmd index files: the same named-index layout the qmd CLI uses (`qmd --index <name>`). */
export function indexPaths(name = 'index') {
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  const config = process.env.QMD_CONFIG_DIR || (process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, 'qmd') : path.join(os.homedir(), '.config', 'qmd'));
  return { dbPath: path.join(cache, 'qmd', `${name}.sqlite`), configPath: path.join(config, `${name}.yml`) };
}

export function qmdIndexName(root, override) {
  return override ?? loadConfig(root)['qmd-index'] ?? 'index';
}

/**
 * Open a qmd store. kb.config.yaml `qmd-env` sets qmd/llama.cpp environment variables first
 * (e.g. QMD_LLAMA_GPU, GGML_VK_VISIBLE_DEVICES, QMD_FORCE_CPU); variables already set win.
 * `env` adds per-call variables (kb eval uses one context per model so query mode fits in VRAM).
 */
export async function openStore(root, { index, env = {} } = {}) {
  for (const [k, v] of Object.entries({ ...(loadConfig(root)['qmd-env'] ?? {}), ...env })) process.env[k] ??= String(v);
  const { createStore } = await import('@tobilu/qmd');
  const p = indexPaths(qmdIndexName(root, index));
  fs.mkdirSync(path.dirname(p.dbPath), { recursive: true });
  fs.mkdirSync(path.dirname(p.configPath), { recursive: true });
  if (!fs.existsSync(p.configPath)) fs.writeFileSync(p.configPath, 'collections: {}\n');
  return createStore(p);
}

/** kb index: catalog, collections and contexts (idempotent), re-index, embed. */
export async function runIndex(root, { index, embed = true, log = () => {} } = {}) {
  const n = buildCatalog(root);
  log(`catalog: ${n} items → catalog.jsonl`);
  const store = await openStore(root, { index });
  try {
    const have = Object.fromEntries((await store.listCollections()).map((c) => [c.name, c]));
    for (const c of COLLECTIONS) {
      const dir = path.resolve(root, c.dir);
      if (have[c.name] && (path.resolve(have[c.name].pwd) !== dir || have[c.name].glob_pattern !== c.pattern)) await store.removeCollection(c.name);
      if (!have[c.name] || path.resolve(have[c.name].pwd) !== dir || have[c.name].glob_pattern !== c.pattern) {
        await store.addCollection(c.name, { path: dir, pattern: c.pattern, ...(c.ignore ? { ignore: c.ignore } : {}) });
      }
      await store.addContext(c.name, '/', c.context);
    }
    const u = await store.update();
    log(`update: ${u.indexed} indexed, ${u.updated} updated, ${u.unchanged} unchanged, ${u.removed} removed`);
    if (embed) {
      // qmd stops an embed session after 30 min; each call resumes where the last stopped.
      const t = performance.now();
      let chunks = 0;
      for (let left = (await store.getStatus()).needsEmbedding; left > 0;) {
        const e = await store.embed();
        chunks += e.chunksEmbedded ?? 0;
        const now = (await store.getStatus()).needsEmbedding;
        log(`embed: ${e.chunksEmbedded ?? 0} chunks, ${e.errors ?? 0} errors, ${now} documents left`);
        if (now >= left) break;
        left = now;
      }
      log(`embed: ${chunks} chunks in ${((performance.now() - t) / 1000).toFixed(0)} s`);
    }
    const counts = Object.fromEntries((await store.listCollections()).map((c) => [c.name, c.active_count ?? c.doc_count]));
    log(`collections: ${JSON.stringify(counts)}`);
    return counts;
  } finally { await store.close(); }
}

/**
 * Thesaurus expansion (no model): vocabulary terms whose label, alt-label, hidden label or notation
 * appears in the question, with their alt-labels and narrower terms (research expands downward, §0.8a).
 */
export function expandQuestion(root, question, terms = loadTerms(root)) {
  const q = ` ${fold(question).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const live = terms.filter((t) => t.status !== 'deprecated');
  const names = (t) => [t.label, refValue(t), ...asList(t['alt-labels']), ...asList(t['hidden-labels'])].filter(Boolean);
  const norm = (s) => fold(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const matched = live.filter((t) => names(t).some((n) => norm(n).length >= 3 && q.includes(` ${norm(n)} `)));
  const phrases = new Set();
  for (const t of matched) {
    for (const n of [t.label, ...asList(t['alt-labels'])]) phrases.add(n);
    if (CLOSED.includes(t.scheme) && t.notation) phrases.add(t.notation.replaceAll('-', ' '));
    for (const c of live.filter((x) => x.scheme === t.scheme && asList(x.broader).includes(t.label))) phrases.add(c.label);
  }
  return { terms: matched.map((t) => `${t.scheme}:${refValue(t)}`), phrases: [...phrases] };
}

const MODES = {
  // qmd's own pipeline: LLM query expansion, BM25 + vector, LLM rerank.
  query: async (store, root, q, limit) => store.search({ query: q, collections: ['kb-items'], limit }),
  // Cheaper: thesaurus-expanded lex phrases (BM25 ANDs terms, so one query per phrase) plus vector
  // search on the question and on the expanded wording, fused by qmd's RRF, no LLM expansion or rerank.
  fast: async (store, root, q, limit, ctx) => {
    const x = expandQuestion(root, q, ctx.terms);
    const queries = [
      { type: 'vec', query: q },
      ...x.phrases.slice(0, 12).map((p) => ({ type: 'lex', query: `"${p.replaceAll('"', '')}"` })),
      ...(x.phrases.length ? [{ type: 'vec', query: `${q} ${x.phrases.slice(0, 8).join(', ')}` }] : []),
    ];
    return store.search({ queries, collections: ['kb-items'], limit, rerank: false });
  },
};
export const MODE_NAMES = Object.keys(MODES);

/** Item ids for a qmd result list, in rank order, deduplicated. */
export function resultIds(results, byFile) {
  const out = [];
  for (const r of results) {
    const base = path.posix.basename(String(r.displayPath ?? r.file).split('?')[0]);
    const id = byFile.get(base);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** A retriever bound to one store: retrieve(mode, question, k) → { ids, ms }. */
export async function openRetriever(root, { index } = {}) {
  const store = await openStore(root, { index, env: { QMD_EMBED_PARALLELISM: 1 } });
  // qmd unloads models after 5 idle minutes; a slow query can trip that mid-run (DisposedError).
  if (store.internal?.llm) store.internal.llm.inactivityTimeoutMs = 0;
  const byFile = new Map(loadCatalog(root).map((c) => [path.posix.basename(c.file), c.id]));
  const ctx = { terms: loadTerms(root) };
  return {
    async retrieve(mode, question, k = 10) {
      const t = performance.now();
      const results = await MODES[mode](store, root, question, k * 2, ctx);
      return { ids: resultIds(results, byFile).slice(0, k), ms: performance.now() - t };
    },
    close: () => store.close(),
  };
}

