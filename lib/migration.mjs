import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

/** Fields Phase 6 fills. In migration mode their errors on untagged items are warnings. */
export const TAG_FIELDS = ['concepts', 'knowledge-types', 'lifecycle-stages', 'sample-questions', 'example-of'];

const norm = (p) => p.replaceAll('\\', '/').replace(/^\.\//, '');

/** Item paths that have a provenance record (tagged) in the external manifest `items.metadata.yaml`. */
export function taggedItems(root) {
  const f = path.join(root, 'items.metadata.yaml');
  if (!fs.existsSync(f)) return new Set();
  const m = YAML.parse(fs.readFileSync(f, 'utf8')) ?? {};
  return new Set(Object.entries(m).filter(([, v]) => v?.['meta-provenance']).map(([k]) => norm(k)));
}

/** True when a manni error is a Phase 6 tag-field error (missing or out-of-range tag field, more than 8 tools). */
export function isTagFieldError(e) {
  if (!/kb-item\.schema\.json$/.test(e.schema ?? '')) return false;
  if (e.keyword === 'required') return TAG_FIELDS.includes(e.subject ?? e.params?.missingProperty);
  const field = (e.instancePath ?? '').split('/')[1];
  if (field === 'tools') return e.keyword === 'maxItems';
  return TAG_FIELDS.includes(field) && ['minItems', 'maxItems'].includes(e.keyword);
}

/** Split manni JSON results into errors and migration warnings. */
export function splitFindings(results, tagged) {
  const errors = []; const warnings = [];
  for (const r of results) {
    const file = norm(r.file);
    for (const e of r.errors ?? []) {
      const soft = file.startsWith('items/') && !tagged.has(file) && isTagFieldError(e);
      (soft ? warnings : errors).push({ file, line: e.line, message: e.message, schema: e.schema });
    }
  }
  return { errors, warnings };
}
