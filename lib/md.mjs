import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import YAML from 'yaml';

const yamlEngine = { parse: (s) => YAML.parse(s) ?? {}, stringify: (o) => YAML.stringify(o, { lineWidth: 0 }) };

export function readMd(file) {
  const g = matter(fs.readFileSync(file, 'utf8'), { engines: { yaml: yamlEngine } });
  return { data: g.data, content: g.content, file };
}

export function writeMd(file, data, content) {
  fs.writeFileSync(file, matter.stringify(content, data, { engines: { yaml: yamlEngine } }));
}

export function walk(dir, ext = '.md') {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, ext));
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

export function githubSlug(heading) {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

/** Extract the "## Captured text" section body (to next "## " heading). */
export function capturedSection(content) {
  const m = content.match(/^## Captured text[^\n]*\n([\s\S]*?)(?=^## (?!#)|(?![\s\S]))/m);
  return m ? m[1] : null;
}
