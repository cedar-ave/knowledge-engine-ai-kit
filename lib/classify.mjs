// Link-pattern type candidates (§0.6a step 1). Deterministic; a model may only pick within `candidates`.

const SOURCE_TYPES = new Set(['blog', 'newsletter', 'podcast', 'channel', 'docs-site', 'portfolio', 'website', 'repo', 'book', 'course']);
export const isSourceType = (t) => SOURCE_TYPES.has(t);

const BOOK_HOSTS = /(^|\.)(amazon\.[a-z.]+|leanpub\.com|books\.google\.com|manning\.com|pragprog\.com)$/;
const SECTION = /^(blog|blogs|docs|documentation|home|posts|articles|news|series|writing|en|en-us)$/i;

export function classify(input) {
  const u = new URL(input);
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const segs = u.pathname.split('/').filter(Boolean);
  const out = (candidates, rule) => ({ candidates, rule });

  if (host === 'youtu.be' || host.endsWith('youtube.com') || host.endsWith('vimeo.com')) {
    if (host === 'youtu.be' || u.searchParams.get('v') || /^\d+$/.test(segs[0] ?? '')) return out(['video', 'talk', 'episode'], 'video-url');
    if (/^@/.test(segs[0] ?? '') || ['channel', 'c', 'user'].includes(segs[0])) return out(['channel'], 'channel-url');
  }
  if (host === 'open.spotify.com') {
    if (segs[0] === 'show') return out(['podcast'], 'spotify-show');
    if (segs[0] === 'episode') return out(['episode'], 'spotify-episode');
  }
  if (host === 'podcasts.apple.com') return u.searchParams.get('i') ? out(['episode'], 'apple-episode') : out(['podcast'], 'apple-show');
  if (host.endsWith('.substack.com')) return segs[0] === 'p' ? out(['article'], 'substack-post') : out(['newsletter'], 'substack-root');
  if (host === 'github.com' && segs.length >= 2) {
    if (segs[2] === 'blob') return out(['article', 'docs-page'], 'github-file');
    return out(['repo', 'tool'], 'github-repo');
  }
  if (host === 'linkedin.com') {
    if (segs[0] === 'feed' && segs[1] === 'update') return out(['linkedin-post'], 'linkedin-feed');
    if (segs[0] === 'posts') return out(['linkedin-post'], 'linkedin-posts');
    if (segs[0] === 'pulse') return out(['linkedin-article'], 'linkedin-pulse');
  }
  if (host.endsWith('.slack.com')) return out(['slack-thread'], 'slack');
  if (BOOK_HOSTS.test(host) || (host === 'oreilly.com' && segs[0] === 'library')) return out(['book'], 'book-host');
  if (host === 'medium.com' && segs.length === 1 && segs[0].startsWith('@')) return out(['blog'], 'medium-profile');
  if (segs.length === 0 || (segs.length === 1 && SECTION.test(segs[0]))) {
    return out(['blog', 'portfolio', 'docs-site', 'website', 'newsletter'], 'site-root');
  }
  return out(['article', 'docs-page'], 'page');
}

/** Pick a type deterministically from candidates using cheap hints. Returns { type, guessed }. */
export function pickType(input, { candidates }, hints = {}) {
  const u = new URL(input);
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.toLowerCase();
  const title = (hints.title ?? '').toLowerCase();
  const text = (hints.text ?? '').toLowerCase();
  if (hints.guess && candidates.includes(hints.guess)) return { type: hints.guess, guessed: false };
  if (candidates.length === 1) return { type: candidates[0], guessed: false };
  const has = (t) => candidates.includes(t);
  if (has('talk') && (hints.event || hints.speaker)) return { type: 'talk', guessed: true };
  if (has('episode') && /\b(podcast|episode|webinar)\b/.test(title + ' ' + text)) return { type: 'episode', guessed: true };
  if (has('video')) return { type: 'video', guessed: true };
  if (has('repo')) return { type: 'repo', guessed: true };
  if (has('docs-site') && (/^(docs|developers?|help|support)\./.test(host) || /^\/(docs|documentation|home)\b/.test(path))) return { type: 'docs-site', guessed: true };
  if (has('portfolio') && /portfolio/.test(title)) return { type: 'portfolio', guessed: true };
  if (has('blog') && (/\/blog\b/.test(path) || /\bblog\b/.test(title))) return { type: 'blog', guessed: true };
  if (has('website')) return { type: 'website', guessed: true };
  if (has('docs-page') && (/^(docs|developers?)\./.test(host) || /\/docs\//.test(path + '/'))) return { type: 'docs-page', guessed: true };
  return { type: candidates[0], guessed: true };
}
