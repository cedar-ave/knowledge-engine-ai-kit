import fs from 'node:fs';
import path from 'node:path';
import { readMd, writeMd } from './md.mjs';
import { loadTerms } from './vocab.mjs';
import { loadItems, asList } from './entities.mjs';

const swap = (v, a, b) => (Array.isArray(v) ? [...new Set(v.map((x) => (x === a ? b : x)))] : v === a ? b : v);

export function renameTerm(root, oldLabel, newLabel) {
  const term = loadTerms(root).find((t) => t.label === oldLabel);
  if (!term) throw new Error(`No term with label "${oldLabel}"`);
  let changed = 0;
  for (const t of loadTerms(root)) {
    const { data, content } = readMd(t.file); let dirty = false;
    if (t.file === term.file) {
      data.label = newLabel;
      if (data.title === oldLabel) data.title = newLabel;
      data['hidden-labels'] = [...new Set([...asList(data['hidden-labels']), oldLabel])]; dirty = true;
    }
    for (const f of ['broader', 'related-terms']) if (asList(data[f]).includes(oldLabel)) { data[f] = swap(data[f], oldLabel, newLabel); dirty = true; }
    if (dirty) { writeMd(t.file, data, content); changed++; }
  }
  for (const it of loadItems(root)) {
    let dirty = false;
    for (const f of ['concepts', 'example-of']) if (asList(it.data[f]).includes(oldLabel)) { it.data[f] = swap(it.data[f], oldLabel, newLabel); dirty = true; }
    for (const s of asList(it.data.segments)) if (asList(s.concepts).includes(oldLabel)) { s.concepts = swap(s.concepts, oldLabel, newLabel); dirty = true; }
    if (dirty) { writeMd(it.file, it.data, it.content); changed++; }
  }
  const log = path.join(root, 'concepts', 'CHANGELOG.md');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(log, `- ${new Date().toISOString().slice(0, 10)}: renamed "${oldLabel}" to "${newLabel}" (rename-term)\n`);
  return changed;
}
