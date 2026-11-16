// "Tools mentioned" links come from tools/<slug>.md `resource`, else from a URL in the item's own text (never from a
// model's memory), which then becomes the tool file's resource. Also: kb tools-missing-links, kb fill-tool-links.
import fs from 'node:fs';
import path from 'node:path';
import { readMd, writeMd, walk } from './md.mjs';
import { loadEntities, asList } from './entities.mjs';

const fold = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');

/** Everything the item itself says: its body (captured text included) and, for bookmarks, the fetched inputs. */
export function itemText(root, file, content) {
  const f = path.join(root, 'migration', 'bookmark-inputs', `${path.basename(file, '.md')}.json`);
  return `${content}\n${fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''}`;
}

/** True when the URL (ignoring a trailing slash) occurs in the text. */
export const urlInText = (url, text) => !!url && /^https?:\/\//.test(url) && text.includes(String(url).replace(/\/+$/, ''));

/** The tool entity for a slug or a name (title, alt-label, slug), or undefined. */
export function findTool(tools, nameOrSlug) {
  const n = fold(nameOrSlug);
  return tools.find((t) => t.slug === nameOrSlug) ?? tools.find((t) => [t.title, t.slug, ...asList(t['alt-labels'])].filter(Boolean).some((v) => fold(v) === n));
}

export const toolLine = (name, url, said) => `- **${name}**${url ? ` ([link](${url}))` : ''}: ${said}`;

/**
 * Render the model's tools-mentioned objects ({ tool, url, said }). Returns the section lines and the tool files whose
 * empty `resource` should be set from the item's text: [{ tool, url }].
 */
export function renderToolsMentioned(list, tools, text) {
  const lines = []; const setResource = [];
  for (const m of list) {
    const t = findTool(tools, m.tool);
    let url = t?.resource;
    if (!url && urlInText(m.url, text)) {
      url = m.url;
      if (t) setResource.push({ tool: t, url });
    }
    lines.push(toolLine(t?.title ?? m.tool, url, String(m.said).trim()));
  }
  return { lines, setResource };
}

/** kb tools-missing-links: tool files with no resource, with how many items list the tool. */
export function toolsMissingLinks(root) {
  const tools = loadEntities(root).filter((e) => e.dir === 'tools' && !e.resource);
  const counts = new Map();
  for (const f of walk(path.join(root, 'items'))) for (const s of asList(readMd(f).data.tools)) counts.set(s, (counts.get(s) ?? 0) + 1);
  return tools.map((t) => ({ slug: t.slug, title: t.title, file: rel(root, t.file), items: counts.get(t.slug) ?? 0 }))
    .sort((a, b) => b.items - a.items || a.slug.localeCompare(b.slug));
}

const LINE = /^- \*\*(.+?)\*\*(?: \(\[link\]\(([^)\s]*)\)\))?:(.*)$/;

/** Fill one Tools mentioned section: an unlinked line whose tool file has a resource gets that link. Other lines stay as they are. */
export function fillSection(section, tools) {
  let changed = 0;
  const out = section.split('\n').map((l) => {
    const m = l.match(LINE);
    const t = m && findTool(tools, m[1]);
    if (!t?.resource || m[2]) return l; // an existing link (often a more specific page) is kept
    changed++;
    return `- **${m[1]}** ([link](${t.resource})):${m[3]}`;
  });
  return { text: out.join('\n'), changed };
}

/** kb fill-tool-links: run fillSection over every item's "## Tools mentioned". Returns { files, lines }. */
export function fillToolLinks(root) {
  const tools = loadEntities(root).filter((e) => e.dir === 'tools');
  let files = 0; let lines = 0;
  for (const f of walk(path.join(root, 'items'))) {
    const { data, content } = readMd(f);
    const m = content.match(/(^## Tools mentioned[^\n]*\n)([\s\S]*?)(?=^## (?!#)|(?![\s\S]))/m);
    if (!m) continue;
    const r = fillSection(m[2], tools);
    if (!r.changed) continue;
    writeMd(f, data, content.replace(m[0], m[1] + r.text));
    files++; lines += r.changed;
  }
  return { files, lines };
}
