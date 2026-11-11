const ts = (s) => {
  const t = Math.floor(s);
  return [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60].map((n) => String(n).padStart(2, '0')).join(':');
};
const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m);
const parse = (s) => { const [h, m, r] = s.split(':'); return +h * 3600 + +m * 60 + parseFloat(r.replace(',', '.')); };

/** VTT -> `[HH:MM:SS] text` lines, de-duplicating rolling captions, one stamp per ~30 s. */
export function vttToTranscript(vtt, every = 30) {
  const cues = [];
  for (const block of vtt.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const start = parse(lines[i].split('-->')[0].trim());
    const text = decode(lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (text) cues.push({ start, text });
  }
  const out = []; let last = ''; let bucket = -1; let cur = null;
  for (const c of cues) {
    if (c.text === last || last.endsWith(c.text)) continue;
    const b = Math.floor(c.start / every);
    if (cur && b === bucket && last && c.text.startsWith(last)) cur.text = cur.text.slice(0, cur.text.length - last.length) + c.text; // rolling caption grows
    else if (!cur || b !== bucket) { cur = { start: c.start, text: c.text }; out.push(cur); bucket = b; }
    else cur.text += ' ' + c.text;
    last = c.text;
  }
  return out.map((c) => `[${ts(c.start)}] ${c.text}`).join('\n');
}
