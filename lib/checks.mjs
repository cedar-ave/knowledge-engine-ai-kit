import path from 'node:path';
import { loadItems, asList } from './entities.mjs';
import { idHash } from './ids.mjs';
import { capturedSection, githubSlug } from './md.mjs';
import { capturedHash } from './captured.mjs';

export function checkIds(root) {
  const errs = []; const seen = new Map();
  for (const it of loadItems(root)) {
    const id = it.data.id; const name = path.basename(it.file); const f = path.relative(root, it.file);
    if (!id) { errs.push(`${f}: missing id`); continue; }
    if (seen.has(id)) errs.push(`${f}: duplicate id ${id} (also ${seen.get(id)})`); else seen.set(id, f);
    if (!name.endsWith(`-${idHash(id)}.md`)) errs.push(`${f}: file name hash does not match id ${id} (expected suffix -${idHash(id)}.md)`);
    if (!/^[a-z0-9]+-([a-z0-9-]+-)?[0-9a-f]{8}\.md$/.test(name)) errs.push(`${f}: file name must be <prefix>-<kebab-title>-<hash8>.md`);
  }
  return errs;
}

export function checkSegments(root) {
  const errs = [];
  for (const it of loadItems(root)) {
    const segs = asList(it.data.segments); if (!segs.length) continue;
    const f = path.relative(root, it.file);
    const text = capturedSection(it.content) ?? '';
    const slugs = new Set([...text.matchAll(/^###\s+(.+)$/gm)].map((m) => githubSlug(m[1])));
    for (const s of segs) if (!slugs.has(s.slug)) errs.push(`${f}: segment slug "${s.slug}" matches no ### heading`);
  }
  return errs;
}

export function checkCapturedText(root) {
  const errs = [];
  for (const it of loadItems(root)) {
    const h = it.data['captured-text-sha256']; const f = path.relative(root, it.file);
    const text = capturedSection(it.content);
    if (h && text == null) errs.push(`${f}: captured-text-sha256 set but no ## Captured text section`);
    else if (h && capturedHash(text) !== h) errs.push(`${f}: captured text changed (hash mismatch)`);
    else if (!h && text != null) errs.push(`${f}: has captured text but no captured-text-sha256`);
  }
  return errs;
}
