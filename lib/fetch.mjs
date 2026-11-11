import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JSDOM, VirtualConsole } from 'jsdom';
import { loadItems } from './entities.mjs';
import { extractArticle } from './extract.mjs';
import { vttToTranscript } from './vtt.mjs';
import { capturedHash } from './captured.mjs';
import { writeMd, capturedSection } from './md.mjs';

export const SOURCE_TYPES = ['blog', 'newsletter', 'podcast', 'channel', 'docs-site', 'portfolio', 'website', 'repo', 'book', 'course'];
const WEB_TYPES = ['article', 'docs-page', 'slide-deck'];
const AV_TYPES = ['video', 'talk', 'episode'];
export const MIN_WORDS = 150;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const quiet = new VirtualConsole();

// ---------- pure helpers (unit tested) ----------

export const wordCount = (md) => (md.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;

/** Shift Markdown headings so the shallowest becomes ####, keeping `##`/`###` free for the item and segments. */
export function demoteHeadings(md) {
  let fence = false; const levels = [];
  const lines = md.split('\n');
  for (const l of lines) { if (/^(```|~~~)/.test(l)) fence = !fence; else if (!fence) { const m = l.match(/^(#{1,6})\s/); if (m) levels.push(m[1].length); } }
  if (!levels.length) return md;
  const shift = 4 - Math.min(...levels);
  fence = false;
  return lines.map((l) => {
    if (/^(```|~~~)/.test(l)) { fence = !fence; return l; }
    if (fence) return l;
    return l.replace(/^(#{1,6})(?=\s)/, (h) => '#'.repeat(Math.min(6, Math.max(4, h.length + shift))));
  }).join('\n');
}

/** Tidy Turndown output: drop inline data: images, collapse blank runs. Wording untouched. */
export const tidyMarkdown = (md) => md.replace(/!\[[^\]]*\]\(data:[^)]*\)/g, '').replace(/\[[\u200b\s#¶§]*\]\(#[^)]*\)/g, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

/** Insert or replace "## Captured text" right before "## Source" (or at the end). */
export function insertCaptured(content, text) {
  const block = `## Captured text\n\n${text.trim()}\n\n`;
  const existing = content.match(/^## Captured text[^\n]*\n[\s\S]*?(?=^## (?!#)|(?![\s\S]))/m);
  if (existing) return content.replace(existing[0], block);
  const src = content.search(/^## Source\s*$/m);
  return src >= 0 ? content.slice(0, src) + block + content.slice(src) : `${content.trimEnd()}\n\n${block}`;
}

/** W3CDTF date (YYYY, YYYY-MM or YYYY-MM-DD) from ISO strings, yt-dlp YYYYMMDD, or Date-parsable text. */
export function w3cDate(s) {
  if (!s) return undefined;
  s = String(s).trim();
  let m = s.match(/^(\d{4})(\d{2})(\d{2})$/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4}-\d{2}-\d{2})/); if (m) return m[1];
  const d = new Date(s);
  return Number.isNaN(d.getTime()) || d.getFullYear() < 1990 ? undefined : d.toISOString().slice(0, 10);
}

/** Published date from article:published_time, JSON-LD datePublished, or <time datetime>. */
export function publishedFromHtml(doc) {
  const meta = doc.querySelector('meta[property="article:published_time"],meta[name="article:published_time"],meta[itemprop="datePublished"]')?.getAttribute('content');
  if (meta) return w3cDate(meta);
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const stack = [JSON.parse(s.textContent)];
      while (stack.length) {
        const o = stack.pop();
        if (Array.isArray(o)) stack.push(...o);
        else if (o && typeof o === 'object') { if (o.datePublished) return w3cDate(o.datePublished); if (o['@graph']) stack.push(o['@graph']); }
      }
    } catch { /* bad JSON-LD */ }
  }
  return w3cDate(doc.querySelector('time[datetime]')?.getAttribute('datetime'));
}

const GENERATORS = [
  ['Mintlify', /mintlify/i], ['Docusaurus', /docusaurus/i], ['ReadMe', /cdn\.readme\.io|readme-deploy|readmeio/i],
  ['Fern', /buildwithfern/i], ['GitBook', /gitbook\.(io|com)|gitbook-/i], ['Starlight', /starlight/i],
  ['Material for MkDocs', /mkdocs-material|material for mkdocs/i], ['MkDocs', /mkdocs/i], ['Sphinx', /sphinx|_static\/doctools\.js/i],
  ['Nextra', /nextra/i], ['VitePress', /vitepress|__VP_HASH_MAP__/i], ['Redocly', /redocly/i], ['Hugo', /gohugo\.io|content="Hugo/i],
  ['Jekyll', /jekyll/i], ['Astro', /astro-island|\/_astro\//i], ['Next.js', /\/_next\/static\//i], ['Gatsby', /___gatsby/i],
  ['WordPress', /\/wp-content\//i], ['Ghost', /content="Ghost|ghost\.(io|org)\//i], ['Substack', /substackcdn\.com/i], ['Medium', /cdn-client\.medium\.com|miro\.medium\.com/i],
  ['Zendesk', /zdassets\.com|zendesk\.com\/(hc|embeddable)/i], ['Confluence', /confluence/i], ['Hashnode', /hashnode/i], ['Squarespace', /squarespace/i], ['Wix', /wixstatic\.com/i],
];

/** Site generator from meta generator first, then page signatures. */
export function detectGenerator(html, doc) {
  const meta = doc.querySelector('meta[name="generator"]')?.getAttribute('content');
  for (const [name, re] of GENERATORS) if (meta && (re.test(meta) || meta.toLowerCase().startsWith(name.toLowerCase()))) return name;
  if (meta) return meta.trim();
  for (const [name, re] of GENERATORS) if (re.test(html)) return name;
  return undefined;
}

const clean = (s) => s?.replace(/\s+/g, ' ').trim() || undefined;

/** Bookmark tagging inputs from a source's front page (no body text). */
export function bookmarkPageInputs(html, url) {
  const doc = new JSDOM(html, { url, virtualConsole: quiet }).window.document;
  const meta = (sel) => clean(doc.querySelector(sel)?.getAttribute('content'));
  const feeds = [...doc.querySelectorAll('link[rel="alternate"][type*="rss"],link[rel="alternate"][type*="atom"]')]
    .map((l) => { try { return new URL(l.getAttribute('href'), url).href; } catch { return null; } }).filter(Boolean);
  const navLabels = [];
  for (const a of doc.querySelectorAll('header nav a, nav a, header a, aside nav a')) {
    const t = clean(a.textContent);
    if (t && t.length <= 40 && !navLabels.includes(t)) navLabels.push(t);
    if (navLabels.length >= 30) break;
  }
  return {
    title: clean(doc.querySelector('meta[property="og:title"]')?.getAttribute('content')) ?? clean(doc.title),
    description: meta('meta[name="description"]') ?? meta('meta[property="og:description"]'),
    feeds: [...new Set(feeds)],
    navLabels,
    generator: detectGenerator(html, doc),
  };
}

/** Up to n item titles from an RSS or Atom feed. */
export function feedTitles(xml, n = 20) {
  const doc = new JSDOM(xml, { contentType: 'text/xml', virtualConsole: quiet }).window.document;
  return [...doc.querySelectorAll('item > title, entry > title')].map((t) => clean(t.textContent)).filter(Boolean).slice(0, n);
}

/** Pick the preferred VTT from yt-dlp output: plain `en`, then `en-orig`, then any en-*. */
export function pickVtt(files) {
  const vtt = files.filter((f) => f.endsWith('.vtt'));
  const lang = (f) => f.split('.').slice(-2, -1)[0];
  return vtt.find((f) => lang(f) === 'en') ?? vtt.find((f) => lang(f) === 'en-orig') ?? vtt.find((f) => /^en/.test(lang(f)));
}

/** Paywall or preview marker from the page text and the extracted Markdown, or undefined. */
export function paywallMarker(pageText, md) {
  if (/Member-only story/i.test(pageText)) return 'Medium member-only';
  if (/This post is for paid subscribers|Keep reading with a \d+-day free trial|subscribe to keep reading|This post is for paying subscribers/i.test(pageText)) return 'Substack paywall';
  const tail = md.slice(-300);
  if (/(continue reading|read more|read the full (story|article)|subscribe to (read|continue))[\s\W]*$/i.test(tail)) return 'read-more cut-off';
  if (/(…|\.\.\.)\s*$/.test(tail) && wordCount(md) < 400) return 'text ends in ellipsis';
  return undefined;
}

/** LinkedIn (or similar) sign-in wall instead of content. */
export const signInWall = (finalUrl, pageText) => /\/(authwall|login|signup|uas\/login)\b/.test(finalUrl) || /Sign in to view|Join now to see|Agree & Join LinkedIn/i.test(pageText);

// ---------- relevance check (script, no model) ----------

const STOP = new Set('about above after again against also among another because been before being below between both could does doing down during each from further have having here into itself just more most much must only other over same should some such than that their them then there these they this those through under until very were what when where which while with would your yours using used make makes made like will into onto upon its it’s it\'s how why who our ours ever every'.split(' '));
const root6 = (w) => w.slice(0, 6);
const terms = (s) => (s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter((w) => !STOP.has(w)).map(root6);
const sectionOf = (content, heading) => content.match(new RegExp(`^## ${heading}[^\\n]*\\n([\\s\\S]*?)(?=^## (?!#)|(?![\\s\\S]))`, 'm'))?.[1] ?? '';
const paragraphs = (md) => md.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => wordCount(p) >= 12);

/** Relevance signals for one captured text (§Phase 5): title and Summary coverage, link density. */
export function relevanceSignals({ title = '', summary = '', text }) {
  const have = new Set(terms(text));
  const cover = (s) => { const t = [...new Set(terms(s))]; return t.length ? t.filter((w) => have.has(w)).length / t.length : null; };
  const visible = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  const linkText = [...text.matchAll(/(?<!!)\[([^\]]*)\]\([^)]*\)/g)].reduce((n, m) => n + m[1].length, 0);
  return { title: cover(title), summary: cover(summary), links: visible.length ? linkText / visible.length : 0 };
}

export const RELEVANCE = { title: 0.34, summary: 0.25, links: 0.4, repeated: 0.4 };

/** Flag full-text and partial items whose captured text is probably not the article (sidebar, bio, banner, blurb). */
export function relevanceFlags(items) {
  const rows = items.filter((it) => ['full-text', 'partial'].includes(it.data.capture)).map((it) => {
    let host = ''; try { host = new URL(it.data.resource).host.replace(/^www\./, ''); } catch { /* none */ }
    return { it, host, text: capturedSection(it.content) ?? '' };
  });
  // Paragraphs that also appear on other pages from the same site are boilerplate.
  const seen = new Map();
  for (const r of rows) for (const p of new Set(paragraphs(r.text))) { const k = `${r.host}\n${p}`; seen.set(k, (seen.get(k) ?? 0) + 1); }
  const flags = [];
  for (const r of rows) {
    const s = relevanceSignals({ title: String(r.it.data.title ?? ''), summary: sectionOf(r.it.content, 'Summary'), text: r.text });
    const paras = paragraphs(r.text); const total = paras.reduce((n, p) => n + wordCount(p), 0);
    s.repeated = total ? paras.filter((p) => seen.get(`${r.host}\n${p}`) > 1).reduce((n, p) => n + wordCount(p), 0) / total : 0;
    const why = [];
    if (s.title != null && terms(String(r.it.data.title ?? '')).length >= 2 && s.title < RELEVANCE.title) why.push(`title words ${Math.round(s.title * 100)}%`);
    if (s.summary != null && s.summary < RELEVANCE.summary) why.push(`Summary overlap ${Math.round(s.summary * 100)}%`);
    if (s.links > RELEVANCE.links) why.push(`link density ${Math.round(s.links * 100)}%`);
    if (s.repeated > RELEVANCE.repeated) why.push(`${Math.round(s.repeated * 100)}% repeats on other ${r.host} pages`);
    if (why.length) flags.push({ it: r.it, why, signals: s });
  }
  return flags;
}

// ---------- I/O ----------

const lastHit = new Map();
async function polite(url, gapMs) {
  const host = new URL(url).host;
  const wait = (lastHit.get(host) ?? 0) + gapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
}

async function get(url, { gapMs = 2000, accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } = {}) {
  await polite(url, gapMs);
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000), headers: { 'user-agent': UA, accept, 'accept-language': 'en-US,en;q=0.9' } });
  const type = res.headers.get('content-type') ?? '';
  const body = /pdf|octet-stream|image|audio|video/.test(type) ? '' : await res.text();
  return { ok: res.ok, status: res.status, type, url: res.url, body };
}

let browser;
/** Render a page with headless Chromium (Playwright) for blocked or script-rendered pages. */
async function render(url, { gapMs = 2000 } = {}) {
  await polite(url, gapMs);
  if (!browser) { const { chromium } = await import('playwright'); browser = await chromium.launch(); }
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US' });
  try {
    const page = await ctx.newPage();
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    const type = res?.headers()['content-type'] ?? 'text/html';
    return { ok: res ? res.ok() : false, status: res?.status() ?? 0, type, url: page.url(), body: await page.content() };
  } finally { await ctx.close(); }
}
export async function closeBrowser() { if (browser) { await browser.close(); browser = undefined; } }

function ytDlpBin() { return process.env.KB_YTDLP || 'yt-dlp'; }
function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.error) throw new Error(`${bin}: ${r.error.code === 'ENOENT' ? 'not found (install it or set its path in an env var)' : r.error.message}`);
  return r;
}

/** Captions for one YouTube video. Tries uploaded subtitles first, then auto-captions. */
export function youtubeCaptions(url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-yt-'));
  try {
    let info; let vtt; let captions;
    for (const mode of ['--write-subs', '--write-auto-subs']) {
      const r = run(ytDlpBin(), ['--skip-download', mode, '--sub-langs', 'en.*,-live_chat', '--sub-format', 'vtt', '--dump-json', '--no-simulate', '--no-warnings', '-o', path.join(dir, '%(id)s.%(ext)s'), url]);
      if (r.status !== 0 && !info) throw new Error(`yt-dlp exit ${r.status}: ${r.stderr.trim().split('\n').pop()}`);
      info ??= JSON.parse(r.stdout.trim().split('\n').pop());
      const f = pickVtt(fs.readdirSync(dir));
      if (f) { vtt = fs.readFileSync(path.join(dir, f), 'utf8'); captions = mode === '--write-subs' ? 'uploaded' : 'auto'; break; }
    }
    return { info, vtt, captions };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Find a YouTube upload of an episode by title (top 3 hits, must share most title words). */
function youtubeSearch(title) {
  const r = run(ytDlpBin(), ['--flat-playlist', '--dump-json', '--no-warnings', `ytsearch3:${title}`]);
  if (r.status !== 0) return undefined;
  const words = (s) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const want = words(title);
  for (const line of r.stdout.trim().split('\n').filter(Boolean)) {
    const e = JSON.parse(line); const got = words(e.title ?? '');
    const overlap = [...want].filter((w) => got.has(w)).length / Math.max(1, want.size);
    if (overlap >= 0.7) return `https://www.youtube.com/watch?v=${e.id}`;
  }
  return undefined;
}

/** Download audio with yt-dlp, transcribe with whisper.cpp (KB_WHISPER = whisper-cli path, KB_WHISPER_MODEL = ggml model). */
function whisperTranscript(url) {
  const bin = process.env.KB_WHISPER || 'whisper-cli'; const model = process.env.KB_WHISPER_MODEL;
  if (!model) throw new Error('set KB_WHISPER_MODEL to a whisper.cpp ggml model file');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-audio-'));
  try {
    const dl = run(ytDlpBin(), ['-x', '--audio-format', 'wav', '--postprocessor-args', 'ffmpeg:-ar 16000 -ac 1', '--no-warnings', '-o', path.join(dir, 'audio.%(ext)s'), url]);
    if (dl.status !== 0) throw new Error(`audio download failed: ${dl.stderr.trim().split('\n').pop()}`);
    const w = run(bin, ['-m', model, '-f', path.join(dir, 'audio.wav'), '-ovtt', '-of', path.join(dir, 'audio'), '-l', 'en']);
    if (w.status !== 0) throw new Error(`whisper.cpp exit ${w.status}`);
    return fs.readFileSync(path.join(dir, 'audio.vtt'), 'utf8');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------- per-item handlers ----------

function stem(file) { return path.basename(file, '.md'); }

function setCaptured(it, text, patch) {
  const content = insertCaptured(it.content, text);
  const data = { ...it.data, ...patch };
  data['captured-text-sha256'] = capturedHash(capturedSection(content));
  writeMd(it.file, data, content);
}

/** Extract one fetched page: Markdown, word count, published date, paywall marker, or why it is unusable. */
function analyse(res) {
  if (!res.ok) return { words: 0, reason: `HTTP ${res.status}` };
  if (!/html/.test(res.type)) return { words: 0, reason: `not HTML (${res.type.split(';')[0] || 'unknown'})`, nonHtml: true };
  const doc = new JSDOM(res.body, { url: res.url, virtualConsole: quiet }).window.document;
  const pageText = doc.body?.textContent ?? '';
  const published = publishedFromHtml(doc);
  if (signInWall(res.url, pageText) && wordCount(pageText) < 600) return { words: 0, published, reason: 'sign-in wall', signIn: true };
  let art = null;
  try { art = extractArticle(res.body, res.url); } catch (e) { return { words: 0, published, reason: `readability error: ${e.message}` }; }
  const md = art ? tidyMarkdown(demoteHeadings(art.markdown)) : '';
  const words = wordCount(md);
  return { md, words, published, marker: md ? paywallMarker(pageText, md) : undefined, reason: art ? `only ${words} words extracted` : 'Readability found no article' };
}

const usable = (p) => p.words >= MIN_WORDS || (p.marker && p.words >= 30);

/** Plain fetch first; on refusal, too little text or a sign-in wall, one retry with Playwright. */
async function capturePage(url, opts) {
  let page; let via = 'fetch';
  try { page = analyse(await get(url, opts)); } catch (e) { page = { words: 0, reason: `fetch error: ${e.cause?.code ?? e.message}` }; }
  if (!usable(page) && !page.nonHtml) {
    try {
      const p2 = analyse(await render(url, opts));
      if (usable(p2)) { page = { ...p2, published: p2.published ?? page.published }; via = 'playwright'; }
      else page = { ...page, reason: `${page.reason}; playwright: ${p2.reason}`, signIn: page.signIn || p2.signIn };
    } catch (e) { page = { ...page, reason: `${page.reason}; playwright error: ${e.message.split('\n')[0]}` }; }
  }
  return { ...page, via, ok: usable(page) };
}

async function fetchWeb(it, opts) {
  const page = await capturePage(it.data.resource, opts);
  const patch = {};
  if (!it.data.published && page.published) patch.published = page.published;
  if (!page.ok) {
    // LinkedIn articles behind a sign-in wall keep their Notion summary for browser capture later.
    if (it.data.type === 'linkedin-article') { writeMd(it.file, { ...it.data, ...patch, capture: 'summary-only' }, it.content); return { status: 'summary-only', reason: page.reason }; }
    return fail(it, page.reason, patch);
  }
  const capture = page.marker ? 'partial' : 'full-text';
  setCaptured(it, page.md, { ...patch, capture });
  return { status: capture, words: page.words, via: page.via, ...(page.marker ? { marker: page.marker } : {}), ...(patch.published ? { published: patch.published } : {}) };
}

/** Re-check a full-text item for a paywall preview; relabel it partial (with fresh preview text) if found. */
async function recheckPaywall(it, opts) {
  const page = await capturePage(it.data.resource, opts);
  if (!page.ok) return { status: 'full-text', reason: `recheck skipped: ${page.reason}` };
  if (!page.marker) return { status: 'full-text', recheck: 'no paywall' };
  setCaptured(it, page.md, { capture: 'partial' });
  return { status: 'partial', words: page.words, via: page.via, marker: page.marker };
}

function fail(it, reason, patch = {}) {
  writeMd(it.file, { ...it.data, ...patch, capture: 'extraction-failed' }, it.content);
  return { status: 'extraction-failed', reason };
}

function avPatch(it, info) {
  const patch = {};
  if (!it.data.published && info?.upload_date) patch.published = w3cDate(info.upload_date);
  if (!it.data['length-min'] && info?.duration) patch['length-min'] = Math.max(1, Math.round(info.duration / 60));
  return patch;
}

function fetchYoutube(it) {
  let r;
  try { r = youtubeCaptions(it.data.resource); } catch (e) { return { status: 'error', reason: e.message }; }
  const patch = avPatch(it, r.info);
  if (!r.vtt) { writeMd(it.file, { ...it.data, ...patch }, it.content); return { status: 'no-captions', reason: 'no English captions; capture unchanged' }; }
  setCaptured(it, vttToTranscript(r.vtt), { ...patch, capture: 'verbatim' });
  return { status: 'verbatim', captions: r.captions, method: 'youtube' };
}

async function fetchAudioEpisode(it, opts) {
  // 1. A transcript page the show publishes: the episode page itself, if it reads like a transcript.
  try {
    const res = await get(it.data.resource, opts);
    if (res.ok && /html/.test(res.type)) {
      const art = extractArticle(res.body, res.url);
      const md = art ? tidyMarkdown(demoteHeadings(art.markdown)) : '';
      if (wordCount(md) >= 1500 && (/^\s*\**[\p{Lu}][\p{L} .'-]{1,40}\**:\s/mu.test(md) || /\[?\d{1,2}:\d{2}(:\d{2})?\]?/.test(md))) {
        setCaptured(it, md, { capture: 'verbatim' });
        return { status: 'verbatim', method: 'transcript-page' };
      }
    }
  } catch { /* fall through */ }
  // 2. A YouTube upload of the same episode.
  try {
    const yt = youtubeSearch(it.data.title);
    if (yt) {
      const r = youtubeCaptions(yt);
      if (r.vtt) {
        setCaptured(it, vttToTranscript(r.vtt), { ...avPatch(it, r.info), capture: 'verbatim' });
        return { status: 'verbatim', method: 'youtube-search', youtube: yt, captions: r.captions };
      }
    }
  } catch { /* fall through */ }
  // 3. Local transcription.
  try {
    setCaptured(it, vttToTranscript(whisperTranscript(it.data.resource)), { capture: 'verbatim' });
    return { status: 'verbatim', method: 'whisper.cpp' };
  } catch (e) { return { status: 'error', method: 'none', reason: e.message }; }
}

async function fetchBookmark(it, root, opts) {
  const url = it.data.resource; const out = path.join(root, 'migration', 'bookmark-inputs', `${stem(it.file)}.json`);
  const inputs = { 'generated-by': 'kb fetch-bookmark', id: it.data.id, type: it.data.type, resource: url, fetched: new Date().toISOString() };
  const errors = [];
  let host; try { host = new URL(url).host.replace(/^www\./, ''); } catch { host = ''; }
  const isVideoChannel = ['youtube.com', 'vimeo.com', 'm.youtube.com'].includes(host);
  if (['channel', 'podcast'].includes(it.data.type) || isVideoChannel) {
    try {
      const r = run(ytDlpBin(), ['--flat-playlist', '--dump-single-json', '--playlist-end', '20', '--no-warnings', url]);
      if (r.status === 0) {
        const j = JSON.parse(r.stdout);
        Object.assign(inputs, { title: j.title ?? j.channel, description: clean(j.description), recentTitles: (j.entries ?? []).map((e) => e.title).filter(Boolean).slice(0, 20) });
      } else errors.push(`yt-dlp exit ${r.status}`);
    } catch (e) { errors.push(e.message); }
  }
  if (!inputs.title) {
    try {
      let res = await get(url, opts);
      if (!res.ok) {
        errors.push(`HTTP ${res.status}`);
        try { const r = await render(url, opts); if (r.ok) { res = r; errors.length = 0; } else errors.push(`playwright: HTTP ${r.status}`); } catch (e) { errors.push(`playwright error: ${e.message.split('\n')[0]}`); }
      }
      if (res.ok && /html/.test(res.type)) {
        const p = bookmarkPageInputs(res.body, res.url);
        Object.assign(inputs, { title: p.title, description: p.description, generator: p.generator });
        if (it.data.type === 'docs-site') inputs.navLabels = p.navLabels;
        if (p.feeds.length) {
          inputs.feed = p.feeds[0];
          try { const f = await get(p.feeds[0], { ...opts, accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml' }); if (f.ok) inputs.recentTitles = feedTitles(f.body); } catch (e) { errors.push(`feed: ${e.message}`); }
        }
      } else if (res.ok) errors.push(`not HTML (${res.type.split(';')[0]})`);
    } catch (e) { errors.push(`fetch error: ${e.cause?.code ?? e.message}`); }
  }
  if (it.data.type === 'docs-site') {
    try {
      const u = new URL('/llms.txt', url).href;
      const r = await get(u, { ...opts, accept: 'text/plain,text/markdown,*/*' });
      if (r.ok && !/html/.test(r.type) && r.body.trim()) inputs.llmsTxt = r.body.split(/\r?\n/).slice(0, 200).join('\n');
    } catch { /* optional */ }
  }
  if (errors.length) inputs.errors = errors;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(inputs, null, 2) + '\n');
  if (it.data.capture !== 'bookmark') writeMd(it.file, { ...it.data, capture: 'bookmark' }, it.content);
  return { status: inputs.title ? 'bookmark' : 'bookmark-empty', ...(errors.length ? { reason: errors.join('; ') } : {}) };
}

// ---------- planning and run ----------

/** What `kb fetch` would do with an item, or null to skip. */
export function planItem(it, root, { retryFailed = false, recheck = false } = {}) {
  const d = it.data; const hasText = capturedSection(it.content) != null;
  if (SOURCE_TYPES.includes(d.type)) {
    const f = path.join(root, 'migration', 'bookmark-inputs', `${stem(it.file)}.json`);
    if (!fs.existsSync(f)) return 'bookmark';
    // --retry-failed also retries bookmarks whose inputs came back empty.
    return retryFailed && !JSON.parse(fs.readFileSync(f, 'utf8')).title ? 'bookmark' : null;
  }
  if (['slack-thread', 'linkedin-post'].includes(d.type)) return null;
  if (recheck) return d.capture === 'full-text' && hasText ? 'recheck' : null;
  if (d.type === 'linkedin-article') return hasText ? null : 'web'; // public pulse pages; a sign-in wall leaves summary-only
  if (d.capture === 'bookmark' || d.capture === 'verbatim' || hasText) return null;
  if (d.capture === 'extraction-failed' && !retryFailed) return null;
  if (AV_TYPES.includes(d.type)) return String(d.id).startsWith('yt:') ? 'youtube' : d.type === 'episode' ? 'audio' : 'web';
  if (WEB_TYPES.includes(d.type) || String(d.id).startsWith('web:')) return 'web';
  return null;
}

export async function runFetch(root, { only, limit = Infinity, retryFailed = false, recheck = false, gapMs = 2000, log = console.log } = {}) {
  const logFile = path.join(root, 'migration', 'fetch-log.jsonl');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const work = loadItems(root).map((it) => ({ it, kind: planItem(it, root, { retryFailed, recheck }) }))
    .filter((w) => w.kind && (!only || only.includes(w.kind))).slice(0, limit);
  const counts = {};
  for (const [i, { it, kind }] of work.entries()) {
    const opts = { gapMs };
    let r;
    try {
      r = kind === 'bookmark' ? await fetchBookmark(it, root, opts)
        : kind === 'web' ? await fetchWeb(it, opts)
        : kind === 'recheck' ? await recheckPaywall(it, opts)
        : kind === 'youtube' ? fetchYoutube(it)
        : await fetchAudioEpisode(it, opts);
    } catch (e) { r = { status: 'error', reason: e.message }; }
    const entry = { at: new Date().toISOString(), id: it.data.id, file: path.relative(root, it.file).replaceAll('\\', '/'), kind, ...r };
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    log(`[${i + 1}/${work.length}] ${kind} ${r.status}${r.reason ? ` (${r.reason})` : ''} ${it.data.id}`);
  }
  await closeBrowser();
  return { planned: work.length, counts };
}

/** Markdown report: capture counts, extraction-failed items for Marla, auto-caption and bookmark problems. */
export function fetchReport(root) {
  const items = loadItems(root);
  const logFile = path.join(root, 'migration', 'fetch-log.jsonl');
  const last = new Map();
  if (fs.existsSync(logFile)) for (const l of fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)) { const e = JSON.parse(l); last.set(e.id, e); }
  const by = {}; const missing = [];
  for (const it of items) { const c = it.data.capture; if (!c) missing.push(it); else by[c] = (by[c] ?? 0) + 1; }
  const rel = (it) => path.relative(root, it.file).replaceAll('\\', '/');
  const failed = items.filter((it) => it.data.capture === 'extraction-failed');
  const partial = items.filter((it) => it.data.capture === 'partial');
  const walled = items.filter((it) => it.data.type === 'linkedin-article' && it.data.capture === 'summary-only');
  const flags = relevanceFlags(items);
  const auto = [...last.values()].filter((e) => e.captions === 'auto');
  const errs = [...last.values()].filter((e) => ['error', 'no-captions', 'bookmark-empty'].includes(e.status) || (e.kind === 'bookmark' && e.reason));
  const lines = [`# Fetch report`, '', 'Log: `migration/fetch-log.jsonl`.', '', '## Items by capture', '', '| capture | count |', '|---|---|',
    ...Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`), `| (not set) | ${missing.length} |`, '',
    `## Extraction failed (${failed.length})`, '', 'Text could not be captured. The summary from Notion is kept. Options: paste the text, give another URL, or leave as is.', '',
    ...(failed.length ? ['| item | URL | reason |', '|---|---|---|', ...failed.map((it) => `| \`${rel(it)}\` | ${it.data.resource} | ${last.get(it.data.id)?.reason ?? ''} |`)] : ['None.']), '',
    `## Partial (${partial.length})`, '', 'Only a preview was available (paywall). The preview is kept and searchable; capture the full text in the browser with `kb-add` (refresh).', '',
    ...(partial.length ? partial.map((it) => `- \`${rel(it)}\` ${it.data.resource} (${last.get(it.data.id)?.marker ?? ''})`) : ['None.']), '',
    `## Relevance check (${flags.length})`, '', 'Captured text that is probably not the article (sidebar, author bio, banner, product blurb, app UI). Check each: re-capture, or set `capture: extraction-failed`.', '',
    ...(flags.length ? flags.map((f) => `- \`${rel(f.it)}\` ${f.it.data.resource}: ${f.why.join('; ')}`) : ['None.']), '',
    `## LinkedIn articles behind a sign-in wall (${walled.length})`, '', ...(walled.length ? walled.map((it) => `- \`${rel(it)}\` ${it.data.resource}`) : ['None.']), '',
    `## Auto-captions only (${auto.length})`, '', ...(auto.length ? auto.map((e) => `- \`${e.file}\``) : ['None.']), '',
    `## Other problems (${errs.length})`, '', ...(errs.length ? errs.map((e) => `- \`${e.file}\` (${e.kind}, ${e.status}): ${e.reason ?? ''}`) : ['None.']), '',
    ...(missing.length ? [`## Missing capture (${missing.length})`, '', ...missing.map((it) => `- \`${rel(it)}\``), ''] : []),
  ];
  return { text: lines.join('\n'), missing: missing.length, failed: failed.length };
}
