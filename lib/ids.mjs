import { createHash } from 'node:crypto';

const TRACKING = /^(utm_.*|ref|source|si|smid|psc)$/i;

export function slackTsToParent(digits) {
  const d = String(digits).replace(/^p/, '');
  return `${d.slice(0, 10)}.${d.slice(10)}`;
}

export function itemId(input, { slackTeams = {} } = {}) {
  const u = new URL(input);
  const host = u.hostname.toLowerCase().replace(/^www\./, '');

  if (host === 'youtu.be' || host.endsWith('youtube.com')) {
    const v = host === 'youtu.be' ? u.pathname.split('/')[1] : u.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return `yt:${v}`;
  }
  if (host === 'linkedin.com') {
    const m = decodeURIComponent(input).match(/(?:activity[:-]|share[:-]|ugcPost[:-])(\d{19})/);
    if (m) return `li:${m[1]}`;
  }
  if (host.endsWith('.slack.com')) {
    const ws = host.split('.')[0];
    const m = u.pathname.match(/\/archives\/([A-Z0-9]+)\/p(\d{16})/);
    if (m) {
      const parent = u.searchParams.get('thread_ts') || slackTsToParent(m[2]);
      return `slack:${ws}:${m[1]}:${parent}`;
    }
    const c = u.pathname.match(/\/client\/(T[A-Z0-9]+)\/([A-Z0-9]+)\/thread\/[A-Z0-9]+-(\d+\.\d+)/);
    if (c && slackTeams[c[1]]) return `slack:${slackTeams[c[1]]}:${c[2]}:${c[3]}`;
  }
  return `web:${host}${webPath(u)}`;
}

function webPath(u) {
  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  const path = u.pathname.replace(/\/+$/, '');
  const q = kept.map(([k, v]) => `${k}=${v}`).join('&');
  return path + (q ? `?${q}` : '');
}

export function canonicalUrl(input) {
  const id = itemId(input);
  if (id.startsWith('yt:')) return `https://www.youtube.com/watch?v=${id.slice(3)}`;
  if (id.startsWith('li:')) return `https://www.linkedin.com/feed/update/urn:li:activity:${id.slice(3)}`;
  const u = new URL(input);
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  return u.toString();
}

export function kebab(s, max = 50) {
  const k = String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return k.slice(0, max).replace(/-+$/, '');
}

export const idHash = (id) => createHash('sha256').update(id).digest('hex').slice(0, 8);

export function prefixFor(id) {
  return id.split(':')[0] === 'slack' ? 'slack' : id.split(':')[0] === 'web' ? 'web' : id.split(':')[0];
}

export function fileName(id, title) {
  return `${prefixFor(id)}-${kebab(title)}-${idHash(id)}.md`;
}
