// `kb import-notion`: convert a Notion "Markdown & CSV" export of the Docs knowledge databases (Phase 3).
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { itemId, canonicalUrl, fileName, kebab } from './ids.mjs';
import { writeMd, walk } from './md.mjs';
import { capturedHash } from './captured.mjs';
import { classify, pickType, isSourceType } from './classify.mjs';
import { loadConfig } from './entities.mjs';

// ---------- CSV and Notion values ----------

export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const [h = [], ...rest] = rows;
  return rest.filter((r) => r.some((x) => x)).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])));
}

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
export const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

/** Parse a Notion relation cell: "Name (https://…<32hex>…), Other" → [{ name, pid }]. */
export function parseRelations(cell) {
  const out = []; if (!cell?.trim()) return out;
  cell = cell.replace(/%20/g, ' ');
  const re = /\s*(.+?)(?: \(([^()]*?(?<![0-9a-f])([0-9a-f]{32})(?![0-9a-f])[^()]*)\))?(?:, |$)/gy;
  let m;
  while (re.lastIndex < cell.length && (m = re.exec(cell))) {
    if (!m[0]) break;
    out.push({ name: m[1].trim(), pid: m[3] ?? null });
  }
  return out;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad = (n) => String(n).padStart(2, '0');

/** "November 3, 2026" / "Nov 3, 2026 4:21 PM" / "2026-09-22" → "2026-11-03" (W3CDTF), else null. */
export function notionDate(s) {
  if (!s) return null;
  const iso = String(s).match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const m = String(s).match(/\b([A-Za-z]{3,9})\.? (\d{1,2}), (\d{4})\b/);
  if (m) {
    const mi = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3)));
    if (mi >= 0) return `${m[3]}-${pad(mi + 1)}-${pad(m[2])}`;
  }
  const y = String(s).match(/^\s*([A-Za-z]{3,9}) (\d{4})\s*$/);
  if (y) { const mi = MONTHS.findIndex((x) => x.startsWith(y[1].toLowerCase().slice(0, 3))); if (mi >= 0) return `${y[2]}-${pad(mi + 1)}`; }
  return null;
}

const dayIn = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

/** Web free date (§0.7) from HTML: article:published_time, JSON-LD datePublished, or <time datetime>. */
export function publishedFromHtml(html, tz = 'UTC') {
  const m = html.match(/property=["']article:published_time["'][^>]*content=["']([^"']+)/i)
    ?? html.match(/content=["']([^"']+)["'][^>]*property=["']article:published_time/i)
    ?? html.match(/"datePublished"\s*:\s*"([^"]+)"/)
    ?? html.match(/<time[^>]*datetime=["']([^"']+)/i);
  if (!m) return null;
  if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(m[1])) return m[1];
  const t = Date.parse(m[1]);
  return Number.isNaN(t) ? null : dayIn(t, tz);
}

async function fetchPublished(url, tz) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    return res.ok ? publishedFromHtml(await res.text(), tz) : null;
  } catch { return null; }
}

/** Free dates (§0.7) that need no network: Slack parent ts, LinkedIn activity id. */
export function freeDate(id, tz = 'UTC') {
  if (id.startsWith('slack:')) return dayIn(Number(id.split(':').pop()) * 1000, tz);
  if (id.startsWith('li:')) return dayIn(Number(BigInt(id.slice(3)) >> 22n), tz);
  return null;
}

// ---------- body ----------

const CAPTURE_START = /^(Transcript|Full thread|Original thread|Original post|Intro\b|Q&A\b|\d+\.\s)/;
const CAPTURE_WRAPPER = /^(Transcript|Full thread|Original thread)\s*$/;
const CAPTURE_END = /^(Source|What it covers)\b/;

/** Split markdown into a preamble and "## " sections (ignores headings inside code fences). */
function sections(md) {
  const out = [{ heading: null, lines: [] }]; let fence = false;
  for (const line of md.split('\n')) {
    if (/^```/.test(line)) fence = !fence;
    if (!fence && /^## (?!#)/.test(line)) out.push({ heading: line.slice(3).trim(), lines: [] });
    else out.at(-1).lines.push(line);
  }
  return out;
}

const trimBlank = (lines) => { const a = [...lines]; while (a.length && !a[0].trim()) a.shift(); while (a.length && !a.at(-1).trim()) a.pop(); return a; };

/** Strip the H1 and the Notion property lines at the top. Returns { props, body }. */
export function splitNotionPage(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let i = 0; const props = {};
  if (/^# /.test(lines[0] ?? '')) i = 1;
  while (i < lines.length && !lines[i].trim()) i++;
  while (i < lines.length && /^[A-Z][\w ()&/-]*: /.test(lines[i])) {
    const k = lines[i].slice(0, lines[i].indexOf(': ')); props[k] = lines[i].slice(k.length + 2).trim(); i++;
  }
  return { props, title: (lines[0] ?? '').replace(/^# /, '').trim(), body: lines.slice(i).join('\n') };
}

const plain = (s) => s.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/^\s*>\s?💡?\s*/gm, '').replace(/\s+/g, ' ').trim();
export const firstSentence = (s) => { const p = plain(s); const m = p.match(/^.+?[.!?](?=\s+["“(A-Z0-9]|$)/); return (m ? m[0] : p).trim(); };

/**
 * Map a Notion page body to the §0.6 template. Returns { body, captured, summary, details }.
 * Keeps existing sections and wording; only renames "Key takeaways for …", turns the 💡 callout into
 * "## Summary", and moves verbatim sections under "## Captured text" (their "##" headings become "###").
 */
export function mapBody(body, { canonical, extraSource = [] }) {
  const secs = sections(body);
  const pre = secs.shift();
  let preLines = trimBlank(pre.lines);
  const callout = []; const rest = [];
  for (const l of preLines) { if ((callout.length === 0 && /^> 💡/u.test(l)) || (callout.length && rest.length === 0 && /^>/.test(l))) callout.push(l); else rest.push(l); }
  const calloutText = callout.map((l) => l.replace(/^>\s?(💡\s*)?/u, '')).join('\n').trim();

  const out = []; const captured = []; let source = null; let inCapture = false; let summary = '', details = '';
  const hasSummary = secs.some((s) => /^Summary\b/.test(s.heading));
  if (calloutText && !hasSummary) { out.push('## Summary', '', calloutText, ''); summary = calloutText; }
  else if (calloutText) out.push(...callout, '');
  if (trimBlank(rest).length) out.push(...trimBlank(rest), '');

  for (const s of secs) {
    const h = s.heading;
    if (inCapture && CAPTURE_END.test(h)) inCapture = false;
    else if (!inCapture && CAPTURE_START.test(h)) inCapture = true;
    if (/^Source\b/.test(h)) { source = trimBlank(s.lines); continue; }
    if (inCapture) {
      if (!CAPTURE_WRAPPER.test(h)) captured.push(`### ${h}`, '');
      captured.push(...trimBlank(s.lines), '');
      continue;
    }
    const heading = /^Key takeaways\b/.test(h) ? 'Key takeaways' : h;
    if (heading === 'Summary' && !summary) summary = trimBlank(s.lines).join('\n');
    if (heading === 'Details') details = s.lines.join('\n');
    out.push(`## ${heading}`, '', ...trimBlank(s.lines), '');
  }
  // drop a dangling horizontal rule left before a moved section
  while (out.length && (!out.at(-1).trim() || out.at(-1).trim() === '---')) out.pop();
  out.push('');
  const capText = trimBlank(captured).join('\n');
  if (capText) out.push('## Captured text', '', capText, '');
  out.push('## Source', '', `\`${canonical}\``);
  const srcExtra = [...(source ?? []).filter((l) => l.trim()), ...extraSource];
  if (srcExtra.length) out.push('', ...srcExtra);
  out.push('');
  return { body: out.join('\n').replace(/\n{3,}/g, '\n\n'), captured: capText || null, summary, details };
}

/** Copy Notion-relative images next to the KB and rewrite links. */
function moveImages(body, pageDir, root, stem, problems) {
  return body.replace(/(!\[[^\]]*\]\()([^)\s]+)(\))/g, (all, a, href, b) => {
    if (/^[a-z]+:/i.test(href)) return all;
    let src = path.join(pageDir, decodeURIComponent(href));
    // Windows unzip drops trailing spaces and dots from folder names that Notion truncated
    if (!fs.existsSync(src)) src = path.join(pageDir, ...decodeURIComponent(href).split('/').map((p) => p.replace(/[ .]+$/, '')));
    if (!fs.existsSync(src)) { problems.push(`missing image ${href}`); return all; }
    const dest = path.join(root, 'assets', stem, path.basename(src));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return `${a}../assets/${stem}/${encodeURIComponent(path.basename(src))}${b}`;
  });
}

// ---------- entities ----------

const SAME_AS_HOSTS = /(^|\.)(github\.com|linkedin\.com|youtube\.com|twitter\.com|x\.com|bsky\.app|mastodon\.social|leanpub\.com|payhip\.com)$/;
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const nameKey = (s) => kebab(s, 80);

class EntityStore {
  constructor() { this.files = new Map(); }
  key(dir, name) { return `${dir}/${nameKey(name)}`; }
  get(dir, name) { return this.files.get(this.key(dir, name)); }
  find(name, dirs) { for (const d of dirs) { const e = this.get(d, name); if (e) return e; } return null; }
  upsert(dir, name, data) {
    const k = this.key(dir, name);
    const cur = this.files.get(k);
    if (!cur) { const e = { dir, slug: nameKey(name), data: { title: name, ...data }, body: '' }; this.files.set(k, e); return e; }
    const alt = new Set(cur.data['alt-labels'] ?? []);
    if (name !== cur.data.title) alt.add(name);
    for (const [key, v] of Object.entries(data)) {
      if (key === 'same-as') cur.data['same-as'] = [...new Set([...(cur.data['same-as'] ?? []), ...v])];
      else if (cur.data[key] == null || cur.data[key] === '') cur.data[key] = v;
    }
    if (alt.size) cur.data['alt-labels'] = [...alt];
    cur.merged = true;
    return cur;
  }
}

function websiteFields(url) {
  if (!url) return {};
  return SAME_AS_HOSTS.test(hostOf(url)) ? { 'same-as': [url] } : { resource: url };
}

// ---------- main ----------

function findCsv(dir) {
  const csvs = fs.readdirSync(dir).filter((f) => f.endsWith('.csv'));
  return path.join(dir, csvs.find((f) => f.endsWith('_all.csv')) ?? csvs[0]);
}

function locate(exportDir) {
  const dbs = {};
  for (const d of fs.readdirSync(exportDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const key = ['knowledge', 'categories', 'tags', 'tools', 'authors', 'series'].find((k) => d.name.toLowerCase().includes(k));
    if (!key) continue;
    const dir = path.join(exportDir, d.name);
    const pagesDir = fs.readdirSync(dir, { withFileTypes: true }).find((e) => e.isDirectory());
    dbs[key] = { rows: parseCsv(fs.readFileSync(findCsv(dir), 'utf8')), pagesDir: pagesDir ? path.join(dir, pagesDir.name) : dir };
  }
  for (const k of ['knowledge', 'tags', 'categories', 'tools', 'authors', 'series']) if (!dbs[k]) throw new Error(`export for "${k}" not found in ${exportDir}`);
  return dbs;
}

const pidOf = (file) => (path.basename(file, '.md').match(/([0-9a-f]{32})$/) ?? [])[1] ?? null;

export async function importNotion(root, { exportDir, overrides = {}, force = false }) {
  const cfg = loadConfig(root);
  const tz = cfg.timezone ?? 'UTC';
  const ws = cfg['slack-workspaces']?.[0]?.subdomain;
  const authorOrgs = new Set((overrides['author-organizations'] ?? []).map(nameKey));
  const notToolPages = new Set(overrides['not-tool-pages'] ?? []);
  const typeOverrides = overrides.types ?? {};
  const itemsDir = path.join(root, 'items');
  if (!force && walk(itemsDir).length) throw new Error('items/ is not empty; pass --force to overwrite');

  const dbs = locate(exportDir);
  const ents = new EntityStore();
  const R = { byType: {}, guessed: [], toolPages: [], idFixes: [], idMismatch: [], duplicates: [], broken: [], noCaptured: [], noPublished: [], images: [], problems: [], gaps: [], bookmarks: [], fetchedDates: [], placeholder: 0 };

  // Entities from tools, authors, series.
  for (const r of dbs.tools.rows) {
    const e = ents.upsert('tools', r.Name, { type: 'tool', description: r.Description || undefined, ...websiteFields(r.Website) });
    if (r.Website && e.data.resource && e.data.resource !== r.Website) e.data['same-as'] = [...new Set([...(e.data['same-as'] ?? []), r.Website])];
  }
  for (const r of dbs.authors.rows) {
    const dir = authorOrgs.has(nameKey(r.Name)) ? 'organizations' : 'people';
    ents.upsert(dir, r.Name, { type: dir === 'people' ? 'person' : 'organization', ...websiteFields(r.Website) });
  }
  for (const r of dbs.series.rows) ents.upsert('series', r.Name, { type: 'series', description: r.Description || undefined });

  // Tool websites → tool entity, to detect old 🧰 tool pages.
  const toolById = new Map();
  for (const e of ents.files.values()) {
    if (e.dir !== 'tools') continue;
    for (const u of [e.data.resource, ...(e.data['same-as'] ?? [])].filter(Boolean)) { try { toolById.set(itemId(u), e); } catch { /* bad url */ } }
  }

  // Pages: Notion page id → { file, props, body }.
  const pages = new Map(); const pageByItemId = new Map();
  for (const f of fs.readdirSync(dbs.knowledge.pagesDir).filter((x) => x.endsWith('.md'))) {
    const file = path.join(dbs.knowledge.pagesDir, f);
    const p = { file, pid: pidOf(file), ...splitNotionPage(fs.readFileSync(file, 'utf8')) };
    pages.set(p.pid, p);
    if (p.props['Item ID']) pageByItemId.set(p.props['Item ID'], p);
  }

  const fixId = (raw, link) => {
    let id = (raw ?? '').trim();
    if (!id) { id = itemId(link); R.idFixes.push(`rebuilt from Link: ${id}`); return id; }
    const fixed = id.replace(/^web:https?:\/\//, 'web:').replace(/^web:www\./, 'web:');
    let out = fixed;
    const old = fixed.match(/^slack:([A-Z0-9]+):(\d+\.\d+)$/);
    if (old && ws) out = `slack:${ws}:${old[1]}:${old[2]}`;
    if (out !== id) R.idFixes.push(`${id} → ${out}`);
    return out;
  };

  // Pass 1: build item records.
  const recs = []; const pidToId = new Map(); const seen = new Map();
  for (const row of dbs.knowledge.rows) {
    const page = pageByItemId.get(row['Item ID']) ?? [...pages.values()].find((p) => p.title === row.Page);
    if (!page) { R.problems.push(`no page file for row "${row.Page}"`); continue; }
    page.used = true;
    const link = row.Link.trim();
    const id = fixId(row['Item ID'], link);
    let rebuilt = null; try { rebuilt = itemId(link, {}); } catch { /* bad link */ }
    if (rebuilt && rebuilt !== id && !(id.startsWith('slack:') && rebuilt.startsWith('slack:'))) R.idMismatch.push(`${id} (Link gives ${rebuilt})`);
    if (seen.has(id)) { R.duplicates.push(`${id}: "${row.Page}" and "${seen.get(id)}"`); continue; }
    seen.set(id, row.Page);
    pidToId.set(page.pid, id);
    recs.push({ row, page, id, link });
  }
  for (const p of pages.values()) if (!p.used) R.problems.push(`page without CSV row: ${path.basename(p.file)}`);

  const items = [];
  for (const { row, page, id, link } of recs) {
    const resource = id.startsWith('slack:') ? `https://${id.split(':')[1]}.slack.com/archives/${id.split(':')[2]}/p${id.split(':')[3].replace('.', '')}` : canonicalUrl(link);
    const details = page.body.match(/^## Details\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? '';
    const detail = (k) => details.match(new RegExp(`\\*\\*${k}:\\*\\*\\s*([^·\\n]+)`))?.[1]?.trim();
    const cleanEvent = (s) => s?.replace(/\s*\([^)]*\)/g, '').replace(/\.\s.*$/, '').replace(/[.\s]+$/, '').trim();
    const eventNames = [cleanEvent(row.Event) || cleanEvent(detail('Event'))].filter(Boolean);

    // Tool page?
    const tool = id.startsWith('web:') && !notToolPages.has(id) ? toolById.get(id) : null;

    // Type: the link pattern fixes source vs piece (and so the capture mode); the final pick among
    // several candidates is left to Phase 6, recorded in the temporary key `type-candidates`.
    const cls = typeOverrides[id] ? { candidates: [typeOverrides[id]] } : classify(link);
    const cands = cls.candidates.filter((t) => t !== 'tool');
    const linkClass = cands.every(isSourceType) ? 'source' : cands.some(isSourceType) ? 'mixed' : 'piece';
    if (linkClass === 'mixed') R.problems.push(`${id}: link pattern mixes source and piece types [${cands.join('|')}]; treated as piece`);
    const { type } = pickType(link, { candidates: cands }, { title: row.Page, text: details, event: eventNames[0], speaker: row.Speaker });

    const stem = path.basename(fileName(id, row.Page), '.md');
    const extraSource = row.Video ? [`- Video: ${row.Video}`] : [];
    const problems = [];
    const mapped = mapBody(moveImages(page.body, path.dirname(page.file), root, tool ? `tool-${tool.slug}` : stem, problems), { canonical: resource, extraSource });
    for (const p of problems) R.images.push(`${row.Page}: ${p}`);

    // People and organizations
    const authors = [];
    for (const a of parseRelations(row.Author)) {
      const e = ents.find(a.name, ['people', 'organizations']) ?? ents.upsert(authorOrgs.has(nameKey(a.name)) ? 'organizations' : 'people', a.name, { type: authorOrgs.has(nameKey(a.name)) ? 'organization' : 'person' });
      authors.push(e.slug);
    }
    let hosts = [], guests = [];
    if (row.Speaker) {
      const hm = row.Speaker.match(/\(hosts?: ([^)]+)\)/i);
      const names = row.Speaker.replace(/\(hosts?: [^)]+\)/i, '').split(/,| and /).map((s) => s.trim()).filter(Boolean);
      const slugFor = (n) => (ents.find(n, ['people', 'organizations']) ?? ents.upsert('people', n, { type: 'person' })).slug;
      if (hm) { hosts = hm[1].split(/,| and /).map((s) => slugFor(s.trim())); guests = names.map(slugFor); }
      else for (const n of names) { const s = slugFor(n); if (!authors.includes(s)) authors.push(s); }
    }
    const toolSlugs = parseRelations(row.Tools).map((t) => (ents.get('tools', t.name) ?? ents.upsert('tools', t.name, { type: 'tool' })).slug);
    const series = parseRelations(row.Series).map((s) => (ents.get('series', s.name) ?? ents.upsert('series', s.name, { type: 'series' })).slug);
    const events = eventNames.map((n) => {
      const sd = notionDate(n) ?? n.match(/\b(20\d{2})\b/)?.[1];
      return ents.upsert('events', n, { type: 'event', ...(sd ? { 'start-date': sd } : {}) }).slug;
    });

    const legacy = [...new Set([...parseRelations(row.Tags), ...parseRelations(row.Category)].map((t) => t.name))];
    const rel = (cell, field) => parseRelations(cell).map((x) => {
      const target = x.pid && pidToId.get(x.pid);
      if (!target) R.broken.push(`${id}: ${field} → "${x.name}"`);
      return target;
    }).filter(Boolean);

    let published = freeDate(id, tz) ?? notionDate(detail('Published'));
    // LinkedIn articles (pulse) carry no activity id: use the web rule, which needs a fetch.
    if (!published && hostOf(link) === 'linkedin.com') {
      published = await fetchPublished(link, tz);
      if (published) R.fetchedDates.push(`${id} → ${published}`); else R.problems.push(`${id}: LinkedIn date fetch failed`);
    }
    const lenStr = row['Length (min)'] || detail('Length');
    let lengthMin = null;
    if (/^\d+(\.\d+)?$/.test(lenStr ?? '')) lengthMin = Number(lenStr);
    else if (/^\d+(:\d{2}){1,2}$/.test(lenStr ?? '')) { const p = lenStr.split(':').map(Number); const s = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; lengthMin = Math.round(s / 60); }

    const capturedOn = notionDate(row.Captured) ?? notionDate(mapped.body.match(/Captured (\d{4}-\d{2}-\d{2})/)?.[1]) ?? notionDate(row['Last edited time']);
    if (!row.Captured) R.noCaptured.push(`${row.Page} → ${capturedOn ?? 'none'}`);

    const descSrc = mapped.summary || page.body.match(/^## What it covers\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] || '';
    const description = firstSentence(descSrc) || row.Page;
    const source = linkClass === 'source';
    const fullText = cands.every((t) => ['article', 'docs-page'].includes(t));
    let capture = source ? 'bookmark' : mapped.captured ? (fullText ? 'full-text' : 'verbatim') : 'summary-only';
    if (source && mapped.captured) R.problems.push(`${id}: link gives a source type but the page has captured text; kept, capture set to verbatim`), capture = 'verbatim';
    if (source && !tool) R.bookmarks.push(`${id} — ${row.Page} [${cands.join('|')}]`);

    const d = {
      id, type, ...(cands.length > 1 ? { 'type-candidates': cands } : {}), title: row.Page.trim(),
      ...(['slack-thread', 'linkedin-post'].includes(type) ? { 'title-devised': true } : {}),
      description, resource,
      ...(authors.length ? { authors: [...new Set(authors)] } : {}),
      ...(hosts.length ? { hosts } : {}),
      ...(guests.length ? { guests } : {}),
      ...(events.length ? { event: events[0] } : {}),
      ...(id.startsWith('slack:') ? { 'slack-workspace': id.split(':')[1] } : {}),
      ...(row.Channel ? { 'slack-channel': row.Channel.trim() } : {}),
      ...(published ? { published } : {}),
      'captured-on': capturedOn,
      ...(lengthMin != null ? { 'length-min': lengthMin } : {}),
      ...(cands.length === 1 && ['docs-site', 'portfolio', 'repo', 'docs-page'].includes(type) ? { 'knowledge-types': ['example'] } : {}),
      ...(toolSlugs.length ? { tools: [...new Set(toolSlugs)] } : {}),
      ...(row.Best.includes('⭐') ? { best: true } : {}),
      ...(series.length ? { series: [...new Set(series)] } : {}),
      capture,
      ...(legacy.length ? { 'legacy-tags': legacy } : {}),
      'notion-url': `https://app.notion.com/p/${page.pid}`,
    };
    if (events.length > 1) R.problems.push(`${id}: several events (${events.join(', ')}); kept the first`);
    if (!published && !source && !tool) R.noPublished.push(id);
    items.push({ d, body: mapped.body, captured: mapped.captured, links: () => rel(row.Links, 'Links'), mentioned: () => rel(row['Mentioned in'], 'Mentioned in'), tool, row, stem });
  }

  // Pass 2: relations, part-of, tool pages, write.
  const toolPageSlug = new Map(items.filter((i) => i.tool).map((i) => [i.d.id, i.tool.slug]));
  const toolPageIds = new Set(toolPageSlug.keys());
  const sources = items.filter((i) => i.d.capture === 'bookmark' && !i.tool);
  const PARENT = { article: ['blog', 'website', 'newsletter'], 'docs-page': ['docs-site'], episode: ['podcast', 'channel'], video: ['channel'], talk: ['channel'] };
  fs.mkdirSync(itemsDir, { recursive: true });
  for (const it of items) {
    const links = it.links(); const mentioned = it.mentioned();
    const related = links.filter((x) => !toolPageIds.has(x));
    const sharedIn = mentioned.filter((x) => !toolPageIds.has(x));
    // Relations to old tool pages become references to the tool file.
    const viaToolPages = [...links, ...mentioned].filter((x) => toolPageIds.has(x)).map((x) => toolPageSlug.get(x));
    if (viaToolPages.length && !it.tool) it.d.tools = [...new Set([...(it.d.tools ?? []), ...viaToolPages])];
    if (related.length) it.d['related-pages'] = related;
    if (sharedIn.length) it.d['shared-in'] = sharedIn;
    if (it.captured) it.d['captured-text-sha256'] = capturedHash(it.captured);
    const parent = sources.filter((s) => (PARENT[it.d.type] ?? []).includes(s.d.type) && it.d.resource.startsWith(s.d.resource.replace(/\/?$/, '/'))).sort((a, b) => b.d.resource.length - a.d.resource.length)[0];
    if (parent) it.d['part-of'] = parent.d.id;

    if (it.tool) {
      const e = it.tool;
      if (!e.data.description) e.data.description = it.d.description;
      e.data['notion-url'] = it.d['notion-url'];
      e.body = it.body;
      R.toolPages.push(`${it.d.title} → tools/${e.slug}.md`);
      continue;
    }
    // stable key order: put capture and legacy keys last
    const { capture, 'legacy-tags': lt, 'notion-url': nu, ...head } = it.d;
    const data = { ...head, capture, ...(lt ? { 'legacy-tags': lt } : {}), 'notion-url': nu };
    writeMd(path.join(itemsDir, `${it.stem}.md`), data, it.body);
    if ((data.tools ?? []).length > 8) R.gaps.push(`${data.id}: ${data.tools.length} tools (max 8; trim in Phase 6)`);
    if (data.type === 'slack-thread' && !data['slack-channel']) R.gaps.push(`${data.id}: no slack-channel in Notion`);
    R.byType[data.type] = (R.byType[data.type] ?? 0) + 1;
  }

  // Write entities.
  const placeholders = { person: 'Author or speaker of saved items.', organization: 'Organization that published saved items.', tool: 'Description pending.', series: 'Series of saved items.', event: 'Event referenced by saved items.' };
  const entCount = {};
  for (const e of ents.files.values()) {
    if (!e.data.description) { e.data.description = placeholders[e.data.type]; R.placeholder++; }
    if (e.data.type === 'event' && !e.data['start-date']) R.gaps.push(`events/${e.slug}.md: no start-date`);
    const { type, title, description, ...rest } = e.data;
    fs.mkdirSync(path.join(root, e.dir), { recursive: true });
    writeMd(path.join(root, e.dir, `${e.slug}.md`), { type, title, description, ...rest }, e.body);
    entCount[e.dir] = (entCount[e.dir] ?? 0) + 1;
  }

  // Old tags and categories with usage counts.
  const usage = (col) => { const m = new Map(); for (const { row } of recs) for (const t of parseRelations(row[col])) m.set(t.name, (m.get(t.name) ?? 0) + 1); return m; };
  const mig = path.join(root, 'migration'); fs.mkdirSync(mig, { recursive: true });
  for (const [db, col, file] of [['tags', 'Tags', 'old-tags.csv'], ['categories', 'Category', 'old-categories.csv']]) {
    const u = usage(col);
    const names = new Set([...dbs[db].rows.map((r) => r.Name), ...u.keys()]);
    const rows = [...names].map((n) => [n, u.get(n) ?? 0, dbs[db].rows.find((r) => r.Name === n)?.Description ?? '']).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    fs.writeFileSync(path.join(mig, file), toCsv(['name', 'count', 'description'], rows));
    R[`${db}Count`] = rows.length;
  }

  fs.writeFileSync(path.join(mig, 'import-report.md'), renderReport(R, { rows: dbs.knowledge.rows.length, items: Object.values(R.byType).reduce((a, b) => a + b, 0), entCount, tz }));
  return { rows: dbs.knowledge.rows.length, byType: R.byType, toolPages: R.toolPages.length, entCount, report: R };
}

function renderReport(R, { rows, items, entCount, tz }) {
  const list = (title, arr, empty = 'None.') => [`## ${title} (${arr.length})`, '', ...(arr.length ? arr.map((x) => `- ${x}`) : [empty]), ''];
  return [
    '# Notion import report', '',
    `Generated by \`kb import-notion\` on ${dayIn(Date.now(), tz)}.`, '',
    `- Docs knowledge rows: ${rows}`,
    `- Item files written: ${items}`,
    `- Tool pages converted to tool files: ${R.toolPages.length}`,
    `- Rows accounted for: ${items + R.toolPages.length + R.duplicates.length} of ${rows}`,
    `- Entity files: ${Object.entries(entCount).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    `- Entities with placeholder descriptions: ${R.placeholder}`,
    `- Old tags: ${R.tagsCount}, old categories: ${R.categoriesCount} (see old-tags.csv, old-categories.csv)`, '',
    '## Counts by type', '', '| type | count |', '|---|---|',
    ...Object.entries(R.byType).sort((a, b) => b[1] - a[1]).map(([t, n]) => `| ${t} | ${n} |`), '',
    ...list('Items missing id', []),
    ...list('Duplicates', R.duplicates),
    ...list('Broken relations', R.broken),
    ...list('Tool pages converted (were items, now tool files)', R.toolPages),
    ...list('Problems', [...R.problems, ...R.images]),
    '## Expected schema failures', '', 'Every item lacks `concepts` and `sample-questions`; most lack `knowledge-types`; examples lack `example-of`. Filled in Phase 6.', '',
    ...list('Other known validation gaps (need data Notion does not have, or judgment)', R.gaps),
    ...list('ID fixes applied', R.idFixes),
    ...list('Notion Item ID differs from ID rebuilt from Link (Notion ID kept)', R.idMismatch),
    ...list('Bookmarks: link pattern gives a source type (confirm)', R.bookmarks),
    ...list('Published dates fetched (§0.7 web rule, LinkedIn articles)', R.fetchedDates),
    ...list('Rows without Captured date (fallback used)', R.noCaptured),
    ...list('Pieces without published date (needs fetch in a later phase)', R.noPublished),
  ].join('\n');
}

export function loadOverrides(file) {
  return file && fs.existsSync(file) ? YAML.parse(fs.readFileSync(file, 'utf8')) ?? {} : {};
}
