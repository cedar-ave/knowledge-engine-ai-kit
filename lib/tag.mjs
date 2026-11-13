// Phase 6 tagging: one headless model call per item returns a JSON patch (prompts/tag-item.md);
// this script checks it, applies it, writes provenance and queues anything doubtful for review.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import YAML from 'yaml';
import { readMd, writeMd, capturedSection, githubSlug } from './md.mjs';
import { capturedHash, insertHeadings } from './captured.mjs';
import { loadEntities, loadConfig, findEntity, ENTITY_DIRS, asList } from './entities.mjs';
import { loadTerms, refValue, CLOSED, genVocab } from './vocab.mjs';
import { classify, isSourceType } from './classify.mjs';
import { taggedItems } from './migration.mjs';
import { kebab } from './ids.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fold = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');
const words = (s) => (s.match(/\S+/g) ?? []).length;
const today = () => new Date().toISOString().slice(0, 10);
/** Line text without Markdown markup (links, emphasis, code ticks, list markers), for tolerant anchor matching. */
const plain = (s) => String(s).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/^\s*([-+]|\d+\.)\s+/, '').replace(/\s+/g, ' ').trim();

export const REVIEW_CONFIDENCE = 0.7;
const ARTICLE_WORDS = 6000;
const MAX_WORDS = 40000;
const SEGMENT_WORDS = 2500;

// Frontmatter key order for written items (§0.6); unknown keys keep their place after these.
const KEY_ORDER = ['id', 'type', 'title', 'title-devised', 'description', 'resource', 'authors', 'hosts', 'guests', 'organizations', 'publisher', 'event',
  'slack-workspace', 'slack-channel', 'published', 'captured-on', 'length-min', 'concepts', 'genre', 'knowledge-types', 'example-of', 'lifecycle-stages',
  'org-contexts', 'doc-types', 'tools', 'first-hand', 'best', 'note', 'sample-questions', 'segments', 'series', 'related-pages', 'shared-in',
  'captured-text-sha256', 'capture', 'part-of', 'last-reviewed', 'notion-url'];
const HIDDEN = ['legacy-tags', 'type-candidates', 'captured-text-sha256', 'notion-url'];
const LIST_FIELDS = ['concepts', 'genre', 'knowledge-types', 'example-of', 'lifecycle-stages', 'org-contexts', 'doc-types', 'tools'];
const PEOPLE_FIELDS = { authors: ['people', 'organizations'], hosts: ['people'], guests: ['people'], organizations: ['organizations'] };
const SCHEMES_FOR = {
  concepts: ['topics', 'frameworks'], genre: ['genres'], 'knowledge-types': ['knowledge-types'], 'example-of': ['docs-artifacts', 'frameworks', 'doc-types'],
  'lifecycle-stages': ['lifecycle-stages'], 'org-contexts': ['org-contexts'], 'doc-types': ['doc-types'],
};

let validators;
function getValidators() {
  if (validators) return validators;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const load = (n) => JSON.parse(fs.readFileSync(path.join(KIT, 'schema', `${n}.schema.json`), 'utf8'));
  validators = { tag: ajv.compile(load('tag-output')), item: ajv.compile(load('kb-item')) };
  return validators;
}
const ajvErrors = (v) => (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}${e.params?.allowedValues ? ` (${e.params.allowedValues.join(', ')})` : ''}`);

/** Body section text under "## name" (to the next "## " heading), or null. */
export function section(content, name) {
  const m = content.match(new RegExp(`^## ${name}[^\\n]*\\n([\\s\\S]*?)(?=^## (?!#)|(?![\\s\\S]))`, 'm'));
  return m ? m[1].trim() : null;
}

function replaceSection(content, name, body) {
  const re = new RegExp(`(^## ${name}[^\\n]*\\n)([\\s\\S]*?)(?=^## (?!#)|(?![\\s\\S]))`, 'm');
  return re.test(content) ? content.replace(re, (_, h) => `${h}\n${body.trim()}\n\n`) : content;
}

function firstWords(text, n) {
  let count = 0; const out = [];
  for (const line of text.split('\n')) {
    count += words(line);
    out.push(line);
    if (count >= n) { out.push(`[… truncated after ${n} words]`); break; }
  }
  return out.join('\n');
}

/** Allowed `type` values: link-pattern candidates, limited to sources for bookmarks and pieces otherwise. */
export function typeCandidates(d) {
  let c = asList(d['type-candidates']);
  if (!c.length && d.resource) { try { c = classify(d.resource).candidates; } catch { c = []; } }
  const bookmark = d.capture === 'bookmark';
  c = c.filter((t) => t !== 'tool' && isSourceType(t) === bookmark);
  if (d.type && !c.includes(d.type)) c.unshift(d.type);
  return c;
}

/** Entities whose name, alt-label or slug appears in the text (the script-side kb find-entity pass). */
function knownEntities(entities, haystack, current) {
  const hay = ` ${fold(haystack).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  return entities.filter((e) => current.has(e.slug) || [e.title, ...asList(e['alt-labels']), e.slug.replaceAll('-', ' ')]
    .filter((n) => n && String(n).length >= 3)
    .some((n) => hay.includes(` ${fold(n).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `)));
}

/** The item part of the prompt (everything the model needs about this one item). */
export function buildItemInput(root, file, { entities, mode = 'backfill' } = {}) {
  const { data: d, content } = readMd(file);
  const fm = Object.fromEntries(Object.entries(d).filter(([k]) => !HIDDEN.includes(k)));
  const summary = section(content, 'Summary') ?? '';
  const takeaways = section(content, 'Key takeaways') ?? '';
  let captured = capturedSection(content);
  let source = '';
  if (d.capture === 'bookmark') {
    const f = path.join(root, 'migration', 'bookmark-inputs', `${path.basename(file, '.md')}.json`);
    const j = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    const useful = Object.keys(j).filter((k) => !['generated-by', 'id', 'type', 'resource', 'fetched'].includes(k));
    source = useful.length ? `## Bookmark inputs\n\n${JSON.stringify(j, null, 1)}` : '## Bookmark inputs\n\n(none; use the Summary)';
  } else if (captured != null) {
    captured = firstWords(captured.trim(), ['full-text', 'partial'].includes(d.capture) ? ARTICLE_WORDS : MAX_WORDS);
    const heads = [...captured.matchAll(/^###\s+(.+)$/gm)].map((m) => `- ${m[1].trim()}`);
    source = `## Existing headings\n\n${heads.join('\n') || '(none)'}\n\n## Captured text (${words(capturedSection(content))} words in full)\n\n${captured}`;
  } else source = '## Captured text\n\n(none captured)';
  const current = new Set([...Object.keys(PEOPLE_FIELDS), 'tools'].flatMap((k) => asList(d[k])));
  const known = knownEntities(entities, `${JSON.stringify(fm)}\n${summary}\n${takeaways}\n${captured ?? ''}\n${source}`, current)
    .map((e) => `${e.type ?? e.dir} | ${e.slug} | ${e.title}${asList(e['alt-labels']).length ? ` | ${asList(e['alt-labels']).join('; ')}` : ''}`);
  return [
    `# Item\n\nmode: ${mode}`,
    `## Type candidates\n\n${typeCandidates(d).join(', ')}`,
    `## Known entities (kind | slug | title | alt-labels)\n\n${known.join('\n') || '(none matched)'}`,
    `## Frontmatter\n\n${JSON.stringify(fm, null, 1)}`,
    `## Summary\n\n${summary || '(none)'}`,
    `## Key takeaways\n\n${takeaways || '(none)'}`,
    source,
  ].join('\n\n');
}

export function buildPrompt(root, file, ctx) {
  const prompt = fs.readFileSync(path.join(KIT, 'prompts', 'tag-item.md'), 'utf8');
  const lens = loadConfig(root)['takeaway-lens'] ?? '';
  const vocab = fs.readFileSync(path.join(root, 'vocab.compact.md'), 'utf8');
  return `${prompt}\n## Takeaway lens\n\n${lens.trim()}\n\n## Vocabulary (scheme | label or notation | alt-labels | scope note)\n\n${vocab}\n${buildItemInput(root, file, ctx)}\n`;
}

/** The claude binary. Windows npm installs a .cmd shim, which cannot take empty arguments through a shell; use the real .exe behind it. */
let claudeBin;
function resolveClaude() {
  if (claudeBin) return claudeBin;
  claudeBin = process.env.KB_CLAUDE ?? 'claude';
  if (!process.env.KB_CLAUDE && process.platform === 'win32') {
    const shim = spawnSync('where', ['claude.cmd'], { encoding: 'utf8' }).stdout?.split('\n')[0]?.trim();
    const exe = shim && path.join(path.dirname(shim), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (exe && fs.existsSync(exe)) claudeBin = exe;
  }
  return claudeBin;
}

/** One headless Sonnet call. Returns { json, raw, model, cost, ms }. */
export function callModel(prompt, { model = 'sonnet', timeoutMs = 600000 } = {}) {
  return new Promise((resolve) => {
    const args = ['-p', '--model', model, '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--setting-sources', ''];
    const child = spawn(resolveClaude(), args, { cwd: os.tmpdir(), windowsHide: true });
    child.on('error', (e) => resolve({ error: `cannot start claude: ${e.message}` }));
    child.stdin.on('error', () => {});
    let out = ''; let err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    child.on('close', (code) => {
      clearTimeout(timer);
      let env;
      try { env = JSON.parse(out); } catch { return resolve({ error: `claude exited ${code}: ${(err || out).slice(0, 500)}` }); }
      const raw = String(env.result ?? '');
      const usedModel = Object.keys(env.modelUsage ?? {})[0] ?? `claude-${model}`;
      const base = { raw, model: usedModel, cost: env.total_cost_usd ?? 0, ms: env.duration_ms ?? 0 };
      if (env.is_error) return resolve({ ...base, error: `model error: ${raw.slice(0, 300)}` });
      const s = raw.indexOf('{'); const e = raw.lastIndexOf('}');
      try { resolve({ ...base, json: JSON.parse(raw.slice(s, e + 1)) }); } catch (x) { resolve({ ...base, error: `output is not JSON: ${x.message}` }); }
    });
    child.stdin.end(prompt);
  });
}

/** Resolver for controlled values: folded label, notation, alt- or hidden-label → term (deprecated terms follow `see`). */
function termIndex(terms) {
  const by = {};
  for (const t of terms) {
    const m = (by[t.scheme] ??= new Map());
    for (const n of [refValue(t), t.label, ...asList(t['alt-labels']), ...asList(t['hidden-labels'])].filter(Boolean)) if (!m.has(fold(n)) || n === refValue(t)) m.set(fold(n), t);
  }
  return (schemes, value) => {
    for (const s of schemes) {
      let t = by[s]?.get(fold(value));
      if (t?.status === 'deprecated') t = t.see ? by[s]?.get(fold(t.see)) : null;
      if (t) return refValue(t);
    }
    return null;
  };
}

function orderKeys(data) {
  const out = {};
  for (const k of KEY_ORDER) if (k in data) out[k] = data[k];
  for (const [k, v] of Object.entries(data)) if (!(k in out)) out[k] = v;
  return out;
}

/**
 * Check a model output against everything a script can check, and build the write plan.
 * Returns { errors } or { plan }. Writes nothing.
 */
export function planTag(root, file, out, { entities = loadEntities(root), terms = loadTerms(root) } = {}) {
  const v = getValidators();
  if (!v.tag(out)) return { errors: ajvErrors(v.tag).map((e) => `output${e}`) };
  const errors = [];
  const { data: d, content: body0 } = readMd(file);
  const bookmark = d.capture === 'bookmark';
  const cands = typeCandidates(d);
  if (!cands.includes(out.type)) errors.push(`type "${out.type}" is not one of the candidates: ${cands.join(', ')}`);

  // Candidate terms: reuse an existing term when one already matches, else plan a new candidate file.
  let resolve = termIndex(terms);
  const newTerms = [];
  for (const c of asList(out['candidate-terms'])) {
    if (resolve(['topics', 'frameworks', 'docs-artifacts', ...CLOSED], c.label)) continue;
    const id = kebab(c.label, 60);
    if (terms.some((t) => t.scheme === c.scheme && t.id === id)) { errors.push(`candidate term "${c.label}" collides with concepts/${c.scheme}/${id}.md`); continue; }
    const labels = new Set(terms.filter((t) => t.scheme === c.scheme).map((t) => t.label));
    const broader = asList(c.broader).filter((b) => labels.has(b)).slice(0, c.scheme === 'topics' ? 3 : 1);
    newTerms.push({
      file: path.join(root, 'concepts', c.scheme, `${id}.md`),
      data: { type: 'term', id, 'in-scheme': c.scheme, status: 'candidate', title: c.label, description: c.description, label: c.label,
        ...(c['scope-note'] ? { 'scope-note': c['scope-note'] } : {}), ...(broader.length ? { broader } : {}) },
      scheme: c.scheme, label: c.label,
    });
  }
  resolve = termIndex([...terms, ...newTerms.map((t) => ({ ...t.data, scheme: t.scheme }))]);

  const fields = {};
  for (const f of LIST_FIELDS.filter((x) => x !== 'tools')) {
    fields[f] = [];
    for (const val of asList(out[f])) {
      const r = resolve(SCHEMES_FOR[f], val);
      if (r) { if (!fields[f].includes(r)) fields[f].push(r); } else errors.push(`${f}: "${val}" is not in the vocabulary (${SCHEMES_FOR[f].join('/')}); use an existing term or add a candidate-terms entry`);
    }
  }
  // The script, not the model, attaches new candidate terms to the item so their usage can be counted.
  for (const t of newTerms) {
    if (t.scheme === 'docs-artifacts') { if (fields['knowledge-types'].includes('example') && fields['example-of'].length < 5 && !fields['example-of'].includes(t.label)) fields['example-of'].push(t.label); }
    else if (fields.concepts.length < 6 && !fields.concepts.includes(t.label)) fields.concepts.push(t.label);
  }

  // Entities: model-proposed ones go through find-entity first; a match is reused.
  const all = [...entities];
  const alias = {};
  const newEntities = [];
  for (const e of asList(out['new-entities'])) {
    const dir = ENTITY_DIRS[e.kind];
    const hit = [e.title, e.slug, ...asList(e['alt-labels'])].flatMap((n) => findEntity(root, n)).find((h) => h.dir === dir)
      ?? all.find((x) => x.dir === dir && x.slug === e.slug);
    if (hit) { alias[e.slug] = hit.slug; continue; }
    // The same slug may exist in another folder (a tool and the company behind it); refs are checked per folder.
    const ent = { type: e.kind, title: e.title, description: e.description, ...(e.resource ? { resource: e.resource } : {}), ...(asList(e['alt-labels']).length ? { 'alt-labels': e['alt-labels'] } : {}) };
    newEntities.push({ file: path.join(root, dir, `${e.slug}.md`), data: ent });
    all.push({ dir, slug: e.slug, ...ent });
  }
  const refs = (field, vals, dirs) => [...new Set(asList(vals).map((s) => alias[s] ?? s))].filter((s) => {
    if (all.some((x) => dirs.includes(x.dir) && x.slug === s)) return true;
    errors.push(`${field}: "${s}" is not a known ${dirs.join('/')} slug; use one from Known entities or add it to new-entities`);
    return false;
  });

  const data = Object.fromEntries(Object.entries(d).filter(([k]) => !['legacy-tags', 'type-candidates'].includes(k)));
  const written = ['type', 'sample-questions'];
  data.type = out.type;
  if (out.title && (d['title-devised'] || !d.title)) { data.title = out.title; data['title-devised'] = true; written.push('title'); }
  // description only when missing or longer than one sentence (§ Phase 6 prompt rules).
  if (!d.description || /[.!?]["')\]]?\s+["'(]?[A-Z]/.test(d.description)) { data.description = out.description; written.push('description'); }
  for (const f of LIST_FIELDS) {
    const vals = f === 'tools' ? refs('tools', out.tools, ['tools']) : fields[f];
    if (vals.length) { data[f] = vals; written.push(f); } else delete data[f];
  }
  for (const [f, dirs] of Object.entries(PEOPLE_FIELDS)) {
    const vals = refs(f, out[f], dirs);
    if (vals.length) { data[f] = vals; written.push(f); }
  }
  if (typeof out['first-hand'] === 'boolean') { data['first-hand'] = out['first-hand']; written.push('first-hand'); }
  if (!d.published && out.published) { data.published = out.published; written.push('published'); }
  data['sample-questions'] = out['sample-questions'];

  // Segments: insert ### headings into the captured text (wording untouched; the hash must still match).
  let content = body0;
  const segs = asList(out.segments);
  const full = capturedSection(body0);
  if (segs.length) {
    if (bookmark || full == null) errors.push('segments given but the item has no captured text');
    else {
      const lines = full.split('\n');
      const inserts = []; const fm = []; let last = -1;
      for (const s of segs) {
        let idx; let heading;
        if (s.heading) {
          // Exact heading, or the same heading without its markup (models often drop a trailing timestamp link).
          const want = plain(s.heading) || s.heading.trim();
          idx = lines.findIndex((l, i) => i > last && /^###\s/.test(l) && (l.replace(/^###\s+/, '').trim() === s.heading.trim() || plain(l.replace(/^###\s+/, '')).startsWith(want)));
          if (idx < 0) { errors.push(`segment heading not found (in order): "${s.heading}"`); continue; }
          heading = lines[idx].replace(/^###\s+/, '').trim();
        } else {
          const want = s['insert-before'];
          idx = lines.findIndex((l, i) => i > last && !/^#/.test(l) && (l.trimStart().startsWith(want) || plain(l).startsWith(plain(want))));
          heading = s.title;
          if (idx < 0) { errors.push(`segment insert-before not found at the start of a line after the previous segment: "${s['insert-before']}"`); continue; }
          inserts.push({ line: idx, title: s.title });
        }
        last = idx;
        const kt = resolve(['knowledge-types'], s['knowledge-type']);
        if (!kt) errors.push(`segment "${s.title}": knowledge-type "${s['knowledge-type']}" is not a notation`);
        const sc = asList(s.concepts).map((c) => resolve(SCHEMES_FOR.concepts, c) ?? (errors.push(`segment "${s.title}": concept "${c}" is not in the vocabulary`), null)).filter(Boolean);
        const sg = s.genre ? resolve(['genres'], s.genre) : null;
        if (s.genre && !sg) errors.push(`segment "${s.title}": genre "${s.genre}" is not a notation`);
        const entry = { slug: githubSlug(heading), title: s.title, ...(s.start ? { start: s.start } : {}), 'knowledge-type': kt, ...(sg ? { genre: sg } : {}) };
        if (sc.length) entry.concepts = [...new Set(sc)];
        const so = refs('segment organizations', s.organizations, ['organizations']); if (so.length) entry.organizations = so;
        const st = refs('segment tools', s.tools, ['tools']); if (st.length) entry.tools = st;
        if (typeof s['first-hand'] === 'boolean') entry['first-hand'] = s['first-hand'];
        fm.push(entry);
      }
      const text = insertHeadings(full, inserts);
      const slugs = [...text.matchAll(/^###\s+(.+)$/gm)].map((m) => githubSlug(m[1]));
      const dup = slugs.find((s, i) => slugs.indexOf(s) !== i && fm.some((e) => e.slug === s));
      if (dup) errors.push(`segment slug "${dup}" is not unique among ### headings; choose a different title`);
      if (d['captured-text-sha256'] && capturedHash(text) !== d['captured-text-sha256']) errors.push('inserting headings changed the captured text hash');
      content = body0.replace(full, () => text);
      data.segments = fm;
      written.push('segments');
      for (const e of fm) if (e['knowledge-type'] && !data['knowledge-types'].includes(e['knowledge-type'])) data['knowledge-types'].push(e['knowledge-type']);
    }
  } else {
    delete data.segments;
    if (!bookmark && full != null && words(full) > SEGMENT_WORDS) errors.push(`captured text has ${words(full)} words (over ${SEGMENT_WORDS}): segments are required`);
  }

  // New items (kb-add) also get the body sections; backfill keeps the existing ones.
  if (out.summary) content = replaceSection(content, 'Summary', out.summary);
  if (out['key-takeaways']) content = replaceSection(content, 'Key takeaways', out['key-takeaways'].map((t) => `- ${t}`).join('\n'));
  if (out['tools-mentioned']) content = replaceSection(content, 'Tools mentioned', out['tools-mentioned'].length ? out['tools-mentioned'].map((t) => `- ${t}`).join('\n') : 'None mentioned');

  const final = orderKeys(data);
  if (!v.item(final)) errors.push(...ajvErrors(v.item).map((e) => `item${e}`));
  if (errors.length) return { errors };

  const confidence = Object.fromEntries(Object.entries(out.confidence).map(([k, c]) => [`/${k}`, c]));
  const review = [];
  const low = Object.entries(out.confidence).filter(([, c]) => c < REVIEW_CONFIDENCE).map(([k, c]) => `${k} ${c}`);
  if (low.length) review.push(`low confidence: ${low.join(', ')}`);
  if (newTerms.length) review.push(`candidate terms: ${newTerms.map((t) => `${t.label} (${t.scheme})`).join(', ')}`);
  return { plan: { file, data: final, content, newTerms, newEntities, fields: [...new Set(written)].map((k) => `/${k}`), confidence, review, notes: out.notes ?? '' } };
}

/** Write a checked plan: entity and term files, the item, and its provenance record. */
export function applyTag(root, plan, model) {
  for (const e of plan.newEntities) { fs.mkdirSync(path.dirname(e.file), { recursive: true }); writeMd(e.file, e.data, ''); }
  if (plan.newTerms.length) {
    for (const t of plan.newTerms) { fs.mkdirSync(path.dirname(t.file), { recursive: true }); writeMd(t.file, t.data, ''); }
    const log = path.join(root, 'concepts', 'CHANGELOG.md');
    const lines = plan.newTerms.map((t) => `- ${today()}: added candidate ${t.scheme} term "${t.label}". Reason: proposed while tagging ${rel(root, plan.file)} (Phase 6).\n`);
    fs.appendFileSync(log, lines.join(''));
    genVocab(root);
  }
  writeMd(plan.file, plan.data, plan.content);
  writeProvenance(root, rel(root, plan.file), { 'generated-by': model, fields: plan.fields, confidence: plan.confidence });
}

export function writeProvenance(root, key, entry) {
  const f = path.join(root, 'items.metadata.yaml');
  const m = (fs.existsSync(f) ? YAML.parse(fs.readFileSync(f, 'utf8')) : null) ?? {};
  const list = asList(m[key]?.['meta-provenance']).filter((e) => e['generated-by'] !== entry['generated-by']);
  m[key] = { ...(m[key] ?? {}), 'meta-provenance': [...list, entry] };
  const sorted = Object.fromEntries(Object.keys(m).sort().map((k) => [k, m[k]]));
  fs.writeFileSync(f, YAML.stringify(sorted, { lineWidth: 0 }));
}

function appendReview(root, file, reasons) {
  const f = path.join(root, 'migration', 'review-queue.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, '# Tagging review queue\n\nHand-edited. Resolve each item, then delete its line. Phase 6 is done when this list is empty.\n\n');
  fs.appendFileSync(f, `- [ ] \`${rel(root, file)}\` — ${reasons.join('; ')}\n`);
}

/** Tag one item: call, check, retry once with the errors, apply. Never throws for model problems. */
export async function tagOne(root, file, { model = 'sonnet', call = callModel } = {}) {
  const ctx = { entities: loadEntities(root) };
  const prompt = buildPrompt(root, file, ctx);
  let res = await call(prompt, { model });
  let attempts = 1; let cost = res.cost ?? 0;
  let check = res.json ? planTag(root, file, res.json) : { errors: [res.error] };
  if (check.errors) {
    const retry = `${prompt}\n## Your previous output failed validation\n\nFix every error and return the full JSON object again.\n\n${check.errors.map((e) => `- ${e}`).join('\n')}\n\nPrevious output:\n\n${res.raw ?? ''}\n`;
    res = await call(retry, { model }); attempts++; cost += res.cost ?? 0;
    check = res.json ? planTag(root, file, res.json) : { errors: [res.error] };
  }
  const entry = { ts: new Date().toISOString(), file: rel(root, file), model: res.model, attempts, cost: Number(cost.toFixed(4)) };
  if (check.errors) {
    appendReview(root, file, [`not tagged, validation failed: ${check.errors.slice(0, 5).join(' | ')}`]);
    return { ...entry, status: 'failed', errors: check.errors };
  }
  applyTag(root, check.plan, res.model ?? 'claude-sonnet');
  if (check.plan.review.length) appendReview(root, file, check.plan.review);
  return { ...entry, status: check.plan.review.length ? 'review' : 'ok', review: check.plan.review, notes: check.plan.notes,
    newEntities: check.plan.newEntities.map((e) => rel(root, e.file)), newTerms: check.plan.newTerms.map((t) => t.label) };
}

/** Resumable loop: tags up to `batch` untagged items (or `files`), `parallel` calls at a time. Logs to migration/tag-log.jsonl. */
export async function runTag(root, { batch = 15, redo = false, files, parallel = 1, model = 'sonnet', onItem } = {}) {
  const tagged = taggedItems(root);
  const all = files?.length ? files.map((f) => path.resolve(root, f))
    : fs.readdirSync(path.join(root, 'items')).filter((n) => n.endsWith('.md')).sort().map((n) => path.join(root, 'items', n));
  const todo = all.filter((f) => redo || !tagged.has(rel(root, f))).slice(0, batch);
  const logFile = path.join(root, 'migration', 'tag-log.jsonl');
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const f = todo[next++];
      let r;
      try { r = await tagOne(root, f, { model }); } catch (e) { r = { ts: new Date().toISOString(), file: rel(root, f), status: 'failed', errors: [e.stack ?? String(e)] }; appendReview(root, f, [`not tagged, script error: ${e.message}`]); }
      fs.appendFileSync(logFile, JSON.stringify(r) + '\n');
      results.push(r);
      onItem?.(r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, todo.length) }, worker));
  const done = taggedItems(root);
  const remaining = fs.readdirSync(path.join(root, 'items')).filter((n) => n.endsWith('.md') && !done.has(`items/${n}`)).length;
  return { planned: todo.length, remaining, results };
}
