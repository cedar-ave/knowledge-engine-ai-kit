// Phase 10 kb-research read path: fast-mode retrieval (catalog weight 1.5), facet filters from the question's
// intent, and compact results (frontmatter, matched segment, links) so the skill never opens full transcripts.
import path from 'node:path';
import { openRetriever, loadCatalog } from './search.mjs';
import { githubSlug, readMd, walk } from './md.mjs';
import { asList } from './entities.mjs';

const fold = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
export const FACETS = ['knowledge-types', 'genre', 'type', 'tools', 'organizations', 'doc-types', 'org-contexts', 'lifecycle-stages', 'example-of', 'event'];

/** Event slugs plus every edition whose `part-of` names one of them. */
export function expandEvents(root, slugs) {
  const want = new Set(slugs.map(fold));
  for (const f of walk(path.join(root, 'events'))) {
    const d = readMd(f).data;
    if (asList(d['part-of']).some((p) => want.has(fold(p)))) want.add(fold(path.basename(f, '.md')));
  }
  return [...want];
}

/** Catalog predicate: every given facet shares a value (any of the listed ones); --first-hand and --best are booleans. */
export function facetFilter({ facets = {}, firstHand = false, best = false } = {}) {
  const active = Object.entries(facets).filter(([, v]) => v.length);
  if (!active.length && !firstHand && !best) return null;
  return (c) => active.every(([k, vals]) => asList(c[k]).some((v) => vals.map(fold).includes(fold(v))))
    && (!firstHand || c['first-hand'] === true) && (!best || c.best === true);
}

const secs = (hms) => hms.split(':').reduce((a, n) => a * 60 + Number(n), 0);

/** The segment a qmd hit landed in: the last ### heading before the best chunk, matched to the item's segments. */
export function hitSegment(hit, entry) {
  if (!hit?.body) return undefined;
  const before = hit.body.slice(0, (hit.bestChunkPos ?? 0) + 1);
  const heads = [...before.matchAll(/^###\s+(.+)$/gm)];
  if (!heads.length) return undefined;
  const slug = githubSlug(heads.at(-1)[1].trim());
  const seg = asList(entry.segments).find((s) => s.slug === slug);
  return seg ? { slug: seg.slug, title: seg.title, ...(seg.start ? { start: seg.start } : {}) } : { slug };
}

/** Original link, with &t=<seconds> for YouTube when the segment has a start time. */
export function originalLink(entry, seg) {
  if (seg?.start && String(entry.id).startsWith('yt:')) return `${entry.resource}&t=${secs(seg.start)}`;
  return entry.resource;
}

/**
 * Rank: retrieved items passing the filters, then the other retrieved items (none when --strict), then filter matches
 * search did not return (they match the facets but not the question, so only as a fallback).
 */
export function rankWithFilter(ids, catalog, pred, { sort, strict = false } = {}) {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  let pass = ids; let rest = [];
  if (pred) {
    pass = ids.filter((id) => byId.has(id) && pred(byId.get(id)));
    rest = strict ? [] : ids.filter((id) => !pass.includes(id));
    rest.push(...catalog.filter((c) => pred(c) && !ids.includes(c.id)).map((c) => c.id));
  }
  if (sort === 'published') {
    const key = (id) => String(byId.get(id)?.published ?? '');
    pass = [...pass].sort((a, b) => key(b).localeCompare(key(a)));
  }
  if (sort === 'best') pass = [...pass].sort((a, b) => Number(byId.get(b)?.best === true) - Number(byId.get(a)?.best === true));
  return [...pass, ...rest];
}

const excerpt = (s, n = 280) => { const t = String(s ?? '').replace(/^---[\s\S]*?---/, '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

/** kb research: one question → { terms, results } for the kb-research skill. */
export async function research(root, question, { k = 12, facets = {}, firstHand = false, best = false, sort, strict = false, index, retriever } = {}) {
  const r = retriever ?? await openRetriever(root, { index });
  try {
    const catalog = loadCatalog(root);
    const byId = new Map(catalog.map((c) => [c.id, c]));
    if (facets.event?.length) facets = { ...facets, event: expandEvents(root, facets.event) };
    const got = await r.retrieve('fast', question, 40);
    const pred = facetFilter({ facets, firstHand, best });
    const ids = rankWithFilter(got.ids, catalog, pred, { sort, strict }).slice(0, k);
    const hitBy = new Map();
    for (const h of got.hits ?? []) {
      const base = path.posix.basename(String(h.displayPath ?? h.file).split('?')[0]);
      const id = catalog.find((c) => path.posix.basename(c.file) === base)?.id;
      if (id && !hitBy.has(id)) hitBy.set(id, h);
    }
    const results = ids.map((id) => {
      const c = byId.get(id); const h = hitBy.get(id); const seg = hitSegment(h, c);
      const out = {
        id, title: c.title, type: c.type, published: c.published ?? null, description: c.description,
        file: c.file + (seg?.slug ? `#${seg.slug}` : ''), link: originalLink(c, seg),
        ...(seg ? { segment: seg } : {}),
        'knowledge-types': asList(c['knowledge-types']), ...(c.genre ? { genre: asList(c.genre) } : {}),
        ...(c['first-hand'] != null ? { 'first-hand': c['first-hand'] } : {}), ...(c.best ? { best: true } : {}),
        ...(c.note ? { note: c.note } : {}), ...(c['example-of'] ? { 'example-of': asList(c['example-of']) } : {}),
        ...(c.tools ? { tools: asList(c.tools) } : {}), ...(c.organizations ? { organizations: asList(c.organizations) } : {}),
        ...(c.event ? { event: c.event } : {}), capture: c.capture,
        filter: pred ? pred(c) : undefined, retrieved: got.ids.includes(id),
        ...(h ? { chunk: excerpt(h.bestChunk) } : {}),
      };
      // Examples: case studies about the same organizations ("how they built it").
      if (asList(c['knowledge-types']).includes('example') && c.organizations) {
        const orgs = new Set(asList(c.organizations).map(fold));
        const built = catalog.filter((x) => x.id !== id && asList(x['knowledge-types']).includes('case-study') && asList(x.organizations).some((o) => orgs.has(fold(o))));
        if (built.length) out['how-built'] = built.slice(0, 3).map((x) => ({ id: x.id, title: x.title, file: x.file }));
      }
      return out;
    });
    return { question, terms: got.explain?.terms ?? [], filters: { ...facets, ...(firstHand ? { 'first-hand': true } : {}), ...(best ? { best: true } : {}), ...(sort ? { sort } : {}) }, ms: Math.round(got.ms), results };
  } finally { if (!retriever) await r.close(); }
}

/** Parse kb research flags: --k n, --<facet> a,b, --first-hand, --best, --sort published|best, --strict. */
export function parseResearchArgs(args) {
  const opts = { facets: {} }; const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--k') opts.k = Number(args[++i]);
    else if (a === '--first-hand') opts.firstHand = true;
    else if (a === '--best') opts.best = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--sort') opts.sort = args[++i];
    else if (a === '--index') opts.index = args[++i];
    else if (a.startsWith('--') && FACETS.includes(a.slice(2))) opts.facets[a.slice(2)] = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else words.push(a);
  }
  return { question: words.join(' '), opts };
}
