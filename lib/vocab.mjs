import fs from 'node:fs';
import path from 'node:path';
import { readMd, walk } from './md.mjs';
import { loadItems } from './entities.mjs';

export const CLOSED = ['genres', 'knowledge-types', 'lifecycle-stages', 'doc-types', 'org-contexts'];
export const OPEN = ['topics', 'docs-artifacts', 'frameworks'];
export const SCHEMES = [...OPEN, ...CLOSED];
export const STATUSES = ['candidate', 'approved', 'deprecated'];
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const fold = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Item field -> schemes whose terms it may reference. Segment fields map the same way. */
export const FIELD_SCHEMES = {
  concepts: ['topics', 'frameworks'],
  genre: ['genres'],
  'knowledge-types': ['knowledge-types'],
  'lifecycle-stages': ['lifecycle-stages'],
  'org-contexts': ['org-contexts'],
  'doc-types': ['doc-types'],
  'example-of': ['docs-artifacts', 'frameworks', 'doc-types'],
};
const SEGMENT_FIELDS = { concepts: 'concepts', genre: 'genre', 'knowledge-type': 'knowledge-types' };

export function loadTerms(root) {
  const terms = [];
  for (const scheme of SCHEMES) {
    for (const file of walk(path.join(root, 'concepts', scheme))) {
      terms.push({ scheme, file, ...readMd(file).data });
    }
  }
  return terms;
}

/** The value an item uses to reference this term. */
export const refValue = (t) => (CLOSED.includes(t.scheme) ? t.notation : t.label);

/** Narrower labels derived from broader (narrower is never stored). Keyed by scheme, then label. */
export function deriveNarrower(terms) {
  const out = {};
  for (const t of terms) {
    for (const b of asList(t.broader)) ((out[t.scheme] ??= {})[b] ??= []).push(t.label);
  }
  for (const s of Object.values(out)) for (const k of Object.keys(s)) s[k].sort();
  return out;
}

export function genVocab(root) {
  const all = loadTerms(root);
  const terms = all.filter((t) => t.status === 'approved' || t.status === 'candidate');
  const by = (schemes) => [...new Set(terms.filter((t) => schemes.includes(t.scheme)).map(refValue).filter(Boolean))].sort();
  const fields = Object.fromEntries(Object.entries(FIELD_SCHEMES).map(([k, s]) => [k, by(s)]));
  const properties = {};
  for (const [k, vals] of Object.entries(fields)) {
    if (vals.length) properties[k] = { type: 'array', items: { enum: vals } };
  }
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'kb:vocab-enum:generated',
    title: 'Allowed values for controlled fields (generated; do not edit)',
    type: 'object',
    properties,
  };
  fs.mkdirSync(path.join(root, 'schema'), { recursive: true });
  fs.writeFileSync(path.join(root, 'schema', 'vocab.enum.json'), JSON.stringify(schema, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'schema', 'vocab.narrower.json'), JSON.stringify(deriveNarrower(all.filter((t) => t.status !== 'deprecated')), null, 2) + '\n');
  const lines = terms.map((t) => [t.scheme, refValue(t), asList(t['alt-labels']).join('; '), t['scope-note'] ?? ''].join(' | '));
  fs.writeFileSync(path.join(root, 'vocab.compact.md'), lines.join('\n') + (lines.length ? '\n' : ''));
  const count = (s) => terms.filter((t) => t.status === s).length;
  return { terms: terms.length, approved: count('approved'), candidate: count('candidate'), fields };
}

export function checkVocab(root) {
  const errs = [];
  const terms = loadTerms(root);
  const seen = new Map(); // folded name -> scheme
  const labelsByScheme = {};
  for (const t of terms) (labelsByScheme[t.scheme] ??= new Set()).add(t.label);
  for (const t of terms) {
    const f = path.relative(root, t.file);
    if (t.type !== 'term') errs.push(`${f}: type must be "term"`);
    if (t['in-scheme'] !== t.scheme) errs.push(`${f}: in-scheme "${t['in-scheme']}" does not match folder "${t.scheme}"`);
    if (!STATUSES.includes(t.status)) errs.push(`${f}: bad status "${t.status}"`);
    if (!t.label) errs.push(`${f}: missing label`);
    if (CLOSED.includes(t.scheme) && !t.notation) errs.push(`${f}: closed scheme term needs notation`);
    if (t.status === 'deprecated' && !t.see) errs.push(`${f}: deprecated term needs see`);
    if ('narrower' in t) errs.push(`${f}: narrower must not be stored (kb gen-vocab derives it from broader)`);
    if (path.basename(t.file, '.md') !== t.id) errs.push(`${f}: file name must equal id "${t.id}"`);
    for (const name of new Set([t.label, ...asList(t['alt-labels']), ...asList(t['hidden-labels'])])) {
      const k = fold(name);
      if (seen.has(k) && seen.get(k) !== t.scheme) errs.push(`${f}: "${name}" also used in scheme ${seen.get(k)}`);
      else if (!seen.has(k)) seen.set(k, t.scheme);
    }
    for (const rel of ['broader', 'related-terms']) {
      for (const l of asList(t[rel])) if (!labelsByScheme[t.scheme].has(l)) errs.push(`${f}: ${rel} "${l}" is not a label in ${t.scheme}`);
    }
    if (asList(t.broader).length > 1 && t.scheme !== 'topics') errs.push(`${f}: polyhierarchy only allowed in topics`);
  }
  return errs;
}

/** Item usage of every term: [{ term, items: [relative item paths] }]. A value counts once per item. */
export function termUsage(root) {
  const terms = loadTerms(root);
  const index = new Map(); // `${scheme}\0${ref}` -> usage entry
  const usage = terms.map((t) => ({ term: t, items: new Set() }));
  usage.forEach((u) => index.set(`${u.term.scheme}\0${refValue(u.term)}`, u));
  const hit = (field, value, file) => {
    for (const s of FIELD_SCHEMES[field] ?? []) index.get(`${s}\0${value}`)?.items.add(file);
  };
  for (const it of loadItems(root)) {
    const rel = path.relative(root, it.file).split(path.sep).join('/');
    for (const field of Object.keys(FIELD_SCHEMES)) for (const v of asList(it.data[field])) hit(field, v, rel);
    for (const seg of asList(it.data.segments)) {
      for (const [sf, field] of Object.entries(SEGMENT_FIELDS)) for (const v of asList(seg?.[sf])) hit(field, v, rel);
    }
  }
  return usage.map((u) => ({ term: u.term, items: [...u.items].sort() }));
}

/** Warnings (never errors): items that use candidate terms. */
export function vocabWarnings(root) {
  return termUsage(root)
    .filter((u) => u.term.status === 'candidate' && u.items.length)
    .map((u) => `${u.term.scheme} candidate "${refValue(u.term)}" used by ${u.items.length} item(s): ${u.items.join(', ')}`);
}
