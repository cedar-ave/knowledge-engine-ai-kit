// Phase 10 kb-add write path: one link → new item file, capture (scripts), one headless tag call (new-item mode).
// Slack and LinkedIn text comes from a browser download in migration/inbox/ (kb ingest-browser).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { itemId, canonicalUrl, fileName } from './ids.mjs';
import { classify, pickType, isSourceType } from './classify.mjs';
import { loadItems, loadConfig, asList } from './entities.mjs';
import { readMd, writeMd, capturedSection } from './md.mjs';
import { get, render, bookmarkPageInputs, planItem, fetchOne, closeBrowser, insertCaptured, wordCount, MIN_WORDS, ytDlpBin } from './fetch.mjs';
import { capturedHash } from './captured.mjs';
import { freeDate } from './notion.mjs';
import { tagOne } from './tag.mjs';
import { regen } from './generated.mjs';

const KB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kb.mjs');
const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');
const isId = (s) => /^(yt|li|slack|web):/.test(s);
const AV = ['video', 'talk', 'episode'];
// Paths kb-add may change; the commit takes only these, never other work in progress.
const COMMIT_PATHS = ['items', 'concepts', 'tools', 'people', 'organizations', 'events', 'series', 'assets', 'items.metadata.yaml',
  'migration/bookmark-inputs', 'migration/review-queue.md', 'migration/add-log.jsonl', 'migration/tag-log.jsonl', 'migration/fetch-log.jsonl', 'migration/inbox', 'migration/synonym-suggestions.md',
  // Generated reports that kb regen rewrites from items (CI fails if they are stale).
  'migration/content-digest.md', 'migration/entity-duplicates.md', 'migration/fetch-report.md'];

function today(root) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: loadConfig(root).timezone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function slackTeams(root) {
  return Object.fromEntries((loadConfig(root)['slack-workspaces'] ?? []).map((w) => [w['team-id'], w.subdomain]));
}

/** kb find: the item with this id (or the id of this URL), or undefined. */
export function findItem(root, idOrUrl) {
  const id = isId(idOrUrl) ? idOrUrl : itemId(idOrUrl, { slackTeams: slackTeams(root) });
  const it = loadItems(root).find((x) => x.data.id === id);
  return it ? { id, file: rel(root, it.file), type: it.data.type, title: it.data.title, capture: it.data.capture } : { id };
}

export function pieceBody(resource) {
  return `## Summary\n\n## Key takeaways\n\n## Tools mentioned\n\nNone mentioned\n\n## Articles & resources\n\nNone mentioned\n\n## Source\n\n\`${resource}\`\n`;
}
export const bookmarkBody = (resource) => `## Summary\n\n## Source\n\n\`${resource}\`\n`;

/** Cheap metadata for naming and typing: yt-dlp JSON for YouTube, else page title and description. */
async function linkMeta(url, id) {
  if (id.startsWith('yt:')) {
    const r = spawnSync(ytDlpBin(), ['--dump-json', '--skip-download', '--no-warnings', url], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) return { error: `yt-dlp exit ${r.status}: ${(r.stderr ?? '').trim().split('\n').pop()}` };
    const j = JSON.parse(r.stdout.trim().split('\n').pop());
    return { title: j.title, text: j.description?.slice(0, 500), publisher: j.channel ?? j.uploader, parentUrls: [j.channel_url, j.uploader_url].filter(Boolean) };
  }
  let res;
  try { res = await get(url); } catch { /* try a browser */ }
  if (!res?.ok || !/html/.test(res.type)) { try { const r2 = await render(url); if (r2.ok) res = r2; } catch { /* none */ } }
  if (!res?.ok || !/html/.test(res.type)) return { error: res ? `HTTP ${res.status}` : 'fetch failed' };
  const p = bookmarkPageInputs(res.body, res.url);
  return { title: cleanTitle(p.title, res.url), text: p.description };
}

const squash = (s) => String(s).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');

/** A page title without the site name tacked on ("Post | Site", "GitHub - owner/repo: blurb" → "owner/repo"). */
export function cleanTitle(title, url) {
  if (!title) return title;
  const t = title.trim();
  const gh = t.match(/^GitHub - ([\w.-]+\/[\w.-]+)(?::\s.*)?$/);
  if (gh) return gh[1];
  const host = new URL(url).hostname.replace(/^www\./, '');
  const names = [squash(host), squash(host.split('.').slice(-2, -1)[0] ?? '')].filter((n) => n.length >= 3);
  const m = t.match(/^(.{3,}?)\s+[|–—-]\s+([^|–—]{1,60})$/);
  return m && names.some((n) => squash(m[2]).includes(n) || n.includes(squash(m[2]))) ? m[1].trim() : t;
}

const normUrl = (u) => { try { const x = new URL(u); return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}`.toLowerCase(); } catch { return ''; } };

/** The saved source item a piece belongs to (longest resource prefix, or the YouTube channel), else undefined. */
export function findParent(items, url, parentUrls = []) {
  const want = parentUrls.map(normUrl);
  const me = normUrl(url);
  let best;
  for (const it of items) {
    if (!isSourceType(it.data.type)) continue;
    const r = normUrl(it.data.resource);
    if (!r) continue;
    const hit = want.includes(r) || (!want.length && (me === r || me.startsWith(`${r}/`)));
    if (hit && (!best || r.length > normUrl(best.data.resource).length)) best = it;
  }
  return best;
}

/** Source type a piece's parent would have, for the "not saved" hint (§0.6a step 5). */
export function parentType(type, url) {
  if (AV.includes(type)) return /spotify|apple/.test(url) ? 'podcast' : 'channel';
  if (type === 'docs-page') return 'docs-site';
  if (/\.substack\.com/.test(url)) return 'newsletter';
  return /\/blog\b|\/posts?\b/.test(new URL(url).pathname) ? 'blog' : 'website';
}

/**
 * Add one web or YouTube link. opts: note (the owner's words, verbatim), bookmark (piece kept as a bookmark), type (the
 * owner's correction), best (only when the owner says so). Returns { status, ... } with status added | exists | browser | error.
 */
export async function addLink(root, url, opts = {}) {
  const id = itemId(url, { slackTeams: slackTeams(root) });
  const found = findItem(root, id);
  if (found.file) return { status: 'exists', ...found };
  const cls = classify(url);
  if (cls.candidates.some((t) => ['slack-thread', 'linkedin-post'].includes(t))) return { status: 'browser', id, reason: 'Slack and LinkedIn are captured in the browser (kb ingest-browser)' };
  if (opts.type === 'tool') return { status: 'error', id, reason: 'a tool is a tools/ entity file, not an item' };
  const meta = await linkMeta(url, id);
  // The owner's correction wins even outside the link-pattern candidates (a site root can be a book).
  const type = opts.type ?? pickType(url, cls, { title: meta.title, text: meta.text }).type;
  const bookmark = isSourceType(type) || !!opts.bookmark;
  const resource = canonicalUrl(url);
  const title = (meta.title ?? '').trim() || new URL(url).hostname.replace(/^www\./, '');
  const items = loadItems(root);
  const parent = bookmark && isSourceType(type) ? undefined : findParent(items, url, meta.parentUrls);
  const data = {
    id, type, title, resource, ...(meta.publisher ? { publisher: meta.publisher } : {}), 'captured-on': today(root),
    ...(opts.best ? { best: true } : {}), ...(opts.note ? { note: opts.note } : {}), ...(opts.sharedIn ? { 'shared-in': [opts.sharedIn] } : {}),
    capture: bookmark ? 'bookmark' : 'summary-only', ...(parent ? { 'part-of': parent.data.id } : {}),
  };
  const file = path.join(root, 'items', fileName(id, title));
  writeMd(file, data, bookmark ? bookmarkBody(resource) : pieceBody(resource));
  const notes = [];
  if (meta.error) notes.push(`metadata: ${meta.error}`);
  // Capture (scripts only).
  const it = { file, ...readMd(file) };
  const kind = bookmark ? 'bookmark' : planItem(it, root);
  let cap = { status: 'none' };
  if (kind) { try { cap = await fetchOne(root, it, kind); } catch (e) { cap = { status: 'error', reason: e.message }; } }
  if (['extraction-failed', 'error', 'no-captions', 'bookmark-empty'].includes(cap.status)) notes.push(`capture ${cap.status}${cap.reason ? `: ${cap.reason}` : ''}`);
  if (cap.captions === 'auto') notes.push('auto-captions only');
  if (cap.status === 'partial') notes.push(`partial capture (${cap.marker})`);
  const text = capturedSection(readMd(file).content);
  if (!bookmark && text != null && wordCount(text) < MIN_WORDS) notes.push(`short capture (${wordCount(text)} words)`);
  // One headless tag call, new-item mode.
  const tag = await tagOne(root, file, { mode: 'new' });
  if (tag.status === 'failed') {
    // An untagged item would fail validation and block the batch commit: remove it so a later run starts clean.
    fs.rmSync(file, { force: true });
    fs.rmSync(path.join(root, 'migration', 'bookmark-inputs', `${path.basename(file, '.md')}.json`), { force: true });
    dropReviewLine(root, rel(root, file));
    return { status: 'error', id, reason: `tagging failed, not saved (try again): ${(tag.errors ?? []).slice(0, 2).join(' | ')}`, cost: tag.cost ?? 0 };
  }
  if (tag.newTerms?.length) notes.push(`candidate term(s): ${tag.newTerms.join(', ')}`);
  if (tag.synonyms?.length) notes.push(`synonym suggestion(s) logged to migration/synonym-suggestions.md: ${tag.synonyms.map((x) => `"${x.wording}" → ${x.term}`).join(', ')}`);
  if (tag.status === 'review') notes.push('queued for review (migration/review-queue.md)');
  if (!bookmark && !parent) { const pt = parentType(type, url); notes.push(`${pt} not saved — say 'bookmark the ${pt}' to add it`); }
  const d = readMd(file).data;
  return { status: 'added', id, type: d.type, bookmark, title: d.title, file: rel(root, file), capture: d.capture, tag: tag.status, notes, cost: tag.cost ?? 0 };
}

/** Arguments → links: each URL, then its own --bookmark / --best / --type t / --shared-in <id> / --note "…" (or bare words, taken as the note). */
export function parseLinks(args) {
  const links = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^https?:\/\//.test(a)) { links.push({ url: a }); continue; }
    const cur = links.at(-1);
    if (!cur) throw new Error(`"${a}" comes before any URL`);
    if (a === '--bookmark') cur.bookmark = true;
    else if (a === '--best') cur.best = true;
    else if (a === '--type') cur.type = args[++i];
    else if (a === '--note') cur.note = args[++i];
    else if (a === '--shared-in') cur.sharedIn = args[++i];
    else if (!a.startsWith('--')) cur.note = cur.note ? `${cur.note} ${a}` : a;
  }
  return links;
}

function dropReviewLine(root, relFile) {
  const f = path.join(root, 'migration', 'review-queue.md');
  if (fs.existsSync(f)) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\n').filter((l) => !l.includes(`\`${relFile}\``)).join('\n'));
}

function logAdd(root, entry) {
  const f = path.join(root, 'migration', 'add-log.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

/** After all links: one validate, one commit (`add: <titles>`), one index. */
export function finishAdd(root, added, { commit = true, index = true, log = console.log } = {}) {
  const out = {};
  regen(root);
  const v = spawnSync(process.execPath, [KB, 'validate'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  out.validate = v.status === 0 ? 'ok' : 'failed';
  if (v.status !== 0) { log((v.stdout + v.stderr).split('\n').filter((l) => /problem|error|  /.test(l)).slice(0, 15).join('\n')); return out; }
  if (commit && fs.existsSync(path.join(root, '.git'))) {
    const paths = COMMIT_PATHS.filter((p) => fs.existsSync(path.join(root, p)));
    spawnSync('git', ['add', '-A', '--', ...paths], { cwd: root });
    const msg = `add: ${added.map((a) => a.title).join('; ')}`.slice(0, 300);
    const c = spawnSync('git', ['commit', '-q', '-m', msg, '--', ...paths], { cwd: root, encoding: 'utf8' });
    out.commit = c.status === 0 ? 'ok' : `failed: ${(c.stderr || c.stdout).trim().split('\n').slice(-3).join(' ')}`;
  }
  if (index) {
    const r = spawnSync(process.execPath, [KB, 'index'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    out.index = r.status === 0 ? 'ok' : `failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`;
  }
  return out;
}

/** kb add-batch: every link in turn (each tag call is its own headless claude -p), then finishAdd. */
export async function addBatch(root, links, { commit = true, index = true, log = console.log } = {}) {
  const results = [];
  try {
    for (const l of links) {
      let r;
      try { r = await addLink(root, l.url, l); } catch (e) { r = { status: 'error', reason: e.message }; }
      r = { url: l.url, ...r };
      logAdd(root, r);
      results.push(r);
      log(lineFor(r));
    }
  } finally { await closeBrowser(); }
  const added = results.filter((r) => r.status === 'added');
  const finish = added.length ? finishAdd(root, added, { commit, index, log }) : {};
  return { results, ...finish };
}

/** The reply line for one result (Phase 10 kb-add step 8). */
export function lineFor(r) {
  if (r.status === 'added') return `Saved as ${r.type}${r.bookmark ? ' bookmark' : ''}: ${r.title} (${r.file})${r.notes.length ? `\n  ${r.notes.join('\n  ')}` : ''}`;
  if (r.status === 'exists') return `Already saved: ${r.title} (${r.file}). Say "refresh" to re-capture.`;
  if (r.status === 'browser') return `Needs the browser: ${r.url} (${r.reason})`;
  return `Not saved: ${r.url} (${r.reason})`;
}

// ---------- Slack and LinkedIn (browser download → item) ----------

// One message per block: a header line "[when] Author: text", then continuation lines. `when` is "YYYY-MM-DD HH:MM"
// (Slack, the LinkedIn post) or LinkedIn's relative comment age ("+2w"); see skills/kb-add/references.
const MSG = /^\[([^\]\n]{1,40})\] ([^:\n]{1,80}):/;
export const countMessages = (text) => text.split('\n').filter((l) => MSG.test(l)).length;

/** Links shared in captured text, minus Slack, LinkedIn profile and mention links. */
export function sharedLinks(text) {
  const urls = [...text.matchAll(/https?:\/\/[^\s<>()\]"'`]+/g)].map((m) => m[0].replace(/[.,;:!?]+$/, ''));
  return [...new Set(urls)].filter((u) => !/\.slack\.com\/|linkedin\.com\/(in|company)\//.test(u));
}

export function slackResource(id) {
  const [, ws, channel, ts] = id.split(':');
  return `https://${ws}.slack.com/archives/${channel}/p${ts.replace('.', '')}`;
}

/**
 * kb ingest-browser <file>: a Markdown download from the browser snippet (frontmatter: url, title?, channel?, expected?)
 * becomes a verbatim item, or, with refresh, appends messages the saved item does not have yet (never deletes).
 */
export async function ingestBrowser(root, inboxFile, { note, refresh = false, tag = true } = {}) {
  const { data: fm, content } = readMd(inboxFile);
  if (!fm.url) throw new Error(`${inboxFile}: frontmatter has no url`);
  const text = content.trim().replace(/\r\n/g, '\n');
  const id = itemId(fm.url, { slackTeams: slackTeams(root) });
  const type = classify(fm.url).candidates[0];
  if (!['slack-thread', 'linkedin-post', 'linkedin-article'].includes(type)) throw new Error(`${fm.url}: not a Slack or LinkedIn link`);
  const count = countMessages(text);
  const notes = [];
  if (fm.expected != null && count !== Number(fm.expected)) notes.push(`message count ${count} ≠ ${fm.expected} shown on the page: expand every reply or comment and download again`);
  const links = sharedLinks(text);
  const found = findItem(root, id);
  const done = (r) => { const dest = path.join(path.dirname(inboxFile), 'processed', path.basename(inboxFile)); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.renameSync(inboxFile, dest); return r; };
  if (found.file) {
    if (!refresh) return { status: 'exists', ...found, notes };
    const file = path.join(root, found.file);
    const it = readMd(file);
    const have = capturedSection(it.content) ?? '';
    const haveHeads = new Set(have.split('\n').filter((l) => MSG.test(l)));
    const blocks = text.split(/\n(?=\[[^\]\n]{1,40}\] [^:\n]{1,80}:)/);
    const fresh = blocks.filter((b) => !haveHeads.has(b.split('\n')[0]));
    if (!fresh.length) return done({ status: 'unchanged', ...found, notes });
    const merged = `${have.trimEnd()}\n\n${fresh.join('\n\n')}`;
    const c2 = insertCaptured(it.content, merged);
    writeMd(file, { ...it.data, 'captured-text-sha256': capturedHash(capturedSection(c2)) }, c2);
    return done({ status: 'refreshed', ...found, appended: fresh.length, links, notes });
  }
  const first = text.split('\n').find((l) => MSG.test(l))?.replace(MSG, '').trim() ?? '';
  const devised = !fm.title || type !== 'linkedin-article';
  const title = fm.title ?? (first.split(/\s+/).slice(0, 7).join(' ') || type);
  const resource = id.startsWith('slack:') ? slackResource(id) : canonicalUrl(fm.url);
  const data = {
    id, type, title, ...(devised ? { 'title-devised': true } : {}), resource,
    ...(id.startsWith('slack:') ? { 'slack-workspace': id.split(':')[1], ...(fm.channel ? { 'slack-channel': fm.channel } : {}) } : {}),
    ...(freeDate(id, loadConfig(root).timezone) ? { published: freeDate(id, loadConfig(root).timezone) } : {}),
    'captured-on': today(root), ...(note ? { note } : {}), capture: 'verbatim',
  };
  const content2 = insertCaptured(pieceBody(resource), text);
  data['captured-text-sha256'] = capturedHash(capturedSection(content2));
  const file = path.join(root, 'items', fileName(id, title));
  writeMd(file, data, content2);
  const t = tag ? await tagOne(root, file, { mode: 'new' }) : { status: 'skipped' };
  if (t.status === 'failed') notes.push(`tagging failed: ${(t.errors ?? []).slice(0, 2).join(' | ')}`);
  if (t.newTerms?.length) notes.push(`candidate term(s): ${t.newTerms.join(', ')}`);
  if (t.synonyms?.length) notes.push(`synonym suggestion(s) logged to migration/synonym-suggestions.md: ${t.synonyms.map((x) => `"${x.wording}" → ${x.term}`).join(', ')}`);
  const d = readMd(file).data;
  const r = { status: 'added', id, type: d.type, bookmark: false, title: d.title, file: rel(root, file), capture: 'verbatim', messages: count, links, tag: t.status, notes };
  logAdd(root, r);
  return done(r);
}
