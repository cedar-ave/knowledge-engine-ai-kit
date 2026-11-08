import path from 'node:path';
import fs from 'node:fs';
import YAML from 'yaml';
import { readMd, walk } from './md.mjs';

export const ENTITY_DIRS = { tool: 'tools', person: 'people', organization: 'organizations', event: 'events', series: 'series' };
export const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const norm = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export function loadConfig(root) {
  const f = path.join(root, 'kb.config.yaml');
  return fs.existsSync(f) ? YAML.parse(fs.readFileSync(f, 'utf8')) ?? {} : {};
}

export function loadEntities(root) {
  const out = [];
  for (const dir of Object.values(ENTITY_DIRS)) {
    for (const file of walk(path.join(root, dir))) out.push({ dir, slug: path.basename(file, '.md'), file, ...readMd(file).data });
  }
  return out;
}

export function findEntity(root, name) {
  const n = norm(name);
  return loadEntities(root).filter((e) =>
    [e.title, ...asList(e['alt-labels']), ...asList(e['same-as']), e.slug].filter(Boolean).some((v) => norm(v) === n));
}

export function loadItems(root) {
  return walk(path.join(root, 'items')).map((file) => ({ file, ...readMd(file) }));
}

const URL_RE = /^https?:\/\//;
const ID_RE = /^(yt|li|slack|web):/;

export function checkRefs(root) {
  const errs = [];
  const ents = loadEntities(root);
  const has = (dir, slug) => ents.some((e) => e.dir === dir && e.slug === slug);
  const cfg = loadConfig(root);
  const workspaces = (cfg['slack-workspaces'] ?? []).map((w) => w.subdomain);
  const items = loadItems(root);
  const ids = new Set(items.map((i) => i.data.id));
  const rel = (f) => path.relative(root, f);
  const ref = (it, field, dirs, vals) => {
    for (const v of asList(vals)) if (!dirs.some((d) => has(d, v))) errs.push(`${rel(it.file)}: ${field} "${v}" has no file in ${dirs.join('/')}/`);
  };
  for (const it of items) {
    const d = it.data;
    ref(it, 'authors', ['people', 'organizations'], d.authors);
    ref(it, 'hosts', ['people'], d.hosts);
    ref(it, 'guests', ['people'], d.guests);
    ref(it, 'organizations', ['organizations'], d.organizations);
    ref(it, 'tools', ['tools'], d.tools);
    ref(it, 'event', ['events'], d.event);
    ref(it, 'series', ['series'], d.series);
    for (const s of asList(d.segments)) {
      ref(it, 'segments.organizations', ['organizations'], s.organizations);
      ref(it, 'segments.tools', ['tools'], s.tools);
    }
    if (d['slack-workspace'] && !workspaces.includes(d['slack-workspace'])) errs.push(`${rel(it.file)}: slack-workspace "${d['slack-workspace']}" not in kb.config.yaml`);
    for (const f of ['related-pages', 'shared-in']) {
      for (const v of asList(d[f])) if (!URL_RE.test(v) && ID_RE.test(v) && !ids.has(v)) errs.push(`${rel(it.file)}: ${f} id "${v}" not found`);
    }
    if (d['part-of'] && !ids.has(d['part-of'])) errs.push(`${rel(it.file)}: part-of "${d['part-of']}" not found`);
  }
  for (const e of ents) {
    if (e['part-of'] && !has(e.dir, e['part-of'])) errs.push(`${rel(e.file)}: part-of "${e['part-of']}" not found in ${e.dir}/`);
  }
  return errs;
}
