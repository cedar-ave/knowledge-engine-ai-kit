import { createHash } from 'node:crypto';

/** Normalise captured text: drop ### headings and slide image lines, collapse whitespace. */
export function normalizeCaptured(text) {
  return text.split(/\r?\n/)
    .filter((l) => !/^###\s/.test(l) && !/^!\[Slide [^\]]*\]\([^)]*\)\s*$/.test(l))
    .join('\n').replace(/\s+/g, ' ').trim();
}

export const capturedHash = (text) => createHash('sha256').update(normalizeCaptured(text)).digest('hex');

/** Insert "### title" headings before given line indexes (0-based). Wording untouched. */
export function insertHeadings(text, inserts) {
  const lines = text.split('\n');
  for (const { line, title } of [...inserts].sort((a, b) => b.line - a.line)) lines.splice(line, 0, `### ${title}`, '');
  return lines.join('\n');
}

/** Apply a JSON patch of frontmatter keys (shallow set; null deletes). Never touches body. */
export function applyPatch(data, patch) {
  const out = { ...data };
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete out[k]; else out[k] = v; }
  return out;
}
