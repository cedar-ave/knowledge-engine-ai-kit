// kb check-links (kb-maintain, on demand): every item `resource`, dead or moved links → evals/dead-links.md. No archive service.
import { loadItems } from './entities.mjs';
import { get } from './fetch.mjs';

const rel = (root, f) => f.slice(root.length + 1).split('\\').join('/');
const sameDoc = (a, b) => a.replace(/^https?:\/\/(www\.)?/, '').replace(/[/#?]+$/, '') === b.replace(/^https?:\/\/(www\.)?/, '').replace(/[/#?]+$/, '');

/** Check each resource once (polite per-host gap); returns { dead, moved, checked }. */
export async function checkLinks(root, { gapMs = 1000, log = () => {} } = {}) {
  const items = loadItems(root).filter((it) => /^https?:/.test(it.data.resource ?? '') && !/\.slack\.com\/|linkedin\.com\//.test(it.data.resource));
  const dead = []; const moved = [];
  for (const [i, it] of items.entries()) {
    const url = it.data.resource;
    let res;
    try { res = await get(url, { gapMs }); } catch (e) { res = { ok: false, status: e.cause?.code ?? e.name }; }
    // 401/403/429: the site refuses robots, not proof the page is gone.
    if (!res.ok && ![401, 403, 429].includes(res.status)) dead.push({ it, status: res.status });
    else if (res.ok && res.url && !sameDoc(res.url, url)) moved.push({ it, to: res.url });
    log(`[${i + 1}/${items.length}] ${res.status ?? 'ok'} ${url}`);
  }
  return { dead, moved, checked: items.length };
}

export function renderLinks(root, { dead, moved, checked }) {
  return [`# Dead and moved links`, '', `Checked ${checked} item resources on ${new Date().toISOString().slice(0, 10)} (Slack and LinkedIn skipped: they need a sign-in).`, '',
    `## Dead (${dead.length})`, '', ...(dead.length ? dead.map((d) => `- \`${rel(root, d.it.file)}\` ${d.it.data.resource} (${d.status})`) : ['None.']), '',
    `## Moved (${moved.length})`, '', 'The page now redirects. Update `resource` only if the new page is the same content (the `id` never changes).', '',
    ...(moved.length ? moved.map((m) => `- \`${rel(root, m.it.file)}\` ${m.it.data.resource} → ${m.to}`) : ['None.']), ''].join('\n');
}
