import fs from 'node:fs';
import path from 'node:path';
import { readMd, walk } from './md.mjs';

export const CLOSED = ['genres', 'knowledge-types', 'lifecycle-stages', 'doc-types', 'org-contexts'];
export const OPEN = ['topics', 'docs-artifacts', 'frameworks'];
export const SCHEMES = [...OPEN, ...CLOSED];
export const STATUSES = ['candidate', 'approved', 'deprecated'];
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const fold = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

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

export function genVocab(root) {
  const terms = loadTerms(root).filter((t) => t.status === 'approved');
  const by = (schemes) => [...new Set(terms.filter((t) => schemes.includes(t.scheme)).map(refValue).filter(Boolean))].sort();
  const fields = {
    concepts: by(['topics', 'frameworks']),
    genre: by(['genres']),
    'knowledge-types': by(['knowledge-types']),
    'lifecycle-stages': by(['lifecycle-stages']),
    'org-contexts': by(['org-contexts']),
    'doc-types': by(['doc-types']),
    'example-of': by(['docs-artifacts', 'frameworks', 'doc-types']),
  };
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
  const lines = terms.map((t) => [t.scheme, refValue(t), asList(t['alt-labels']).join('; '), t['scope-note'] ?? ''].join(' | '));
  fs.writeFileSync(path.join(root, 'vocab.compact.md'), lines.join('\n') + (lines.length ? '\n' : ''));
  return { terms: terms.length, fields };
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
    if (path.basename(t.file, '.md') !== t.id) errs.push(`${f}: file name must equal id "${t.id}"`);
    for (const name of new Set([t.label, ...asList(t['alt-labels']), ...asList(t['hidden-labels'])])) {
      const k = fold(name);
      if (seen.has(k) && seen.get(k) !== t.scheme) errs.push(`${f}: "${name}" also used in scheme ${seen.get(k)}`);
      else if (!seen.has(k)) seen.set(k, t.scheme);
    }
    for (const rel of ['broader', 'narrower', 'related-terms']) {
      for (const l of asList(t[rel])) if (!labelsByScheme[t.scheme].has(l)) errs.push(`${f}: ${rel} "${l}" is not a label in ${t.scheme}`);
    }
    if (asList(t.broader).length > 1 && t.scheme !== 'topics') errs.push(`${f}: polyhierarchy only allowed in topics`);
  }
  return errs;
}
