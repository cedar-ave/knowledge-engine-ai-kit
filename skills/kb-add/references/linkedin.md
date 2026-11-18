# LinkedIn posts and articles

**Capture must use Claude in Chrome (`mcp__claude-in-chrome__*`), which acts in the owner's own signed-in Chrome. Never use Playwright or any other browser for this. If the Claude in Chrome tools are not available, stop and tell the owner to restart with `kbc`.**

**One post at a time, only when the owner asks for that post. Never bulk, never browse feeds or profiles.**

`linkedin.com/feed/update/urn:li:activity:<id>` and `linkedin.com/posts/…-activity-<id>-…` are posts. `linkedin.com/pulse/…` is an article: try `npx kb add-batch <url>` first (public articles extract without the browser); use the browser only if it comes back `extraction-failed` or summary-only.

## Expand

1. Open the post. If LinkedIn shows a sign-in wall, ask the owner to sign in in that browser.
2. Note the comment count under the post ("8 comments").
3. Click "…see more" on the post, "Load more comments" until it disappears, and "See previous replies" / "Load more replies" on each comment. The snippet also clicks these in a loop, but check.

## Extract

Open the post by the owner's exact link (do not rebuild a `feed/update` URL from a `share-` ID: that shows "Post not found") and wait about 6 seconds for it to load. Set `LINK` to the owner's link. The post line gets its date from the activity ID; comments get LinkedIn's relative age (`+2w`), because the page shows no exact date.

```js
(async () => {
  const LINK = 'PASTE THE POST LINK';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const more = /^(…\s*more|load more comments|see previous replies|load more replies|show more replies|view more comments)$/i;
  for (let i = 0; i < 40; i++) {
    const els = [...document.querySelectorAll('main *')].filter((e) => e.children.length === 0 && more.test((e.innerText || '').trim()));
    if (!els.length) break;
    els.forEach((e) => (e.closest('button,a,[role=button]') || e).click()); await sleep(1300);
  }
  const clean = (s) => s.replace(/\n?…\s*more\s*$/i, '').trim();
  const id = (decodeURIComponent(LINK).match(/(?:activity[:-]|share[:-]|ugcPost[:-])(\d{19})/) || [])[1];
  const pad = (n) => String(n).padStart(2, '0');
  const d = id ? new Date(Number(BigInt(id) >> 22n)) : new Date();
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const feed = document.querySelector('[componentkey^="expanded"]') || document.querySelector('main');
  const author = feed.innerText.split('\n').map((x) => x.trim()).filter(Boolean).find((x) => x !== 'Feed post') || 'Author';
  const postEl = [...document.querySelectorAll('main [componentkey]')]
    .filter((e) => !e.getAttribute('componentkey').startsWith('replaceableComment') && !feed.isSameNode(e) && e.innerText.length > 80 && !/^(Feed post|Premium)/.test(e.innerText))
    .sort((a, b) => a.innerText.length - b.innerText.length).find((e) => !e.querySelector('[componentkey^="replaceableComment"]') && feed.contains(e));
  const lines = [`[${day}] ${author}: ${postEl ? clean(postEl.innerText) : ''}`];
  const seen = new Set();
  for (const c of document.querySelectorAll('[componentkey^="replaceableComment_urn"]')) {
    const k = c.getAttribute('componentkey'); if (seen.has(k)) continue; seen.add(k);
    const L = c.innerText.split('\n').map((x) => x.trim()).filter(Boolean);
    const ai = L.findIndex((x) => /^(\(edited\)\s*)?\d+\s*(mo|yr|w|d|h|m|s)$/i.test(x));
    if (ai < 0) continue;
    const name = (L[0] === author ? L[0] : L[1]).split('•')[0].trim();
    let bi = ai + 1; if (L[bi] === 'Follow') bi++;
    let ei = L.findIndex((x, i) => i >= bi && /^\d+\s+reactions?$/i.test(x)); if (ei < 0) ei = L.length;
    lines.push(`[+${L[ai].replace(/^\(edited\)\s*/, '')}] ${name}: ${clean(L.slice(bi, ei).join('\n'))}`);
  }
  const shown = Number((document.body.innerText.match(/\n(\d[\d,]*)\n(\d[\d,]*)\n(\d[\d,]*)\n/) || [])[2]?.replace(/,/g, '') || 0);
  const fm = ['---', `url: "${LINK}"`, `expected: ${lines.length}`, '---'].join('\n');
  window.__kbdoc = `${fm}\n${lines.join('\n\n')}\n`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([window.__kbdoc], { type: 'text/markdown' }));
  a.download = `linkedin-${id ?? 'post'}.md`; document.body.appendChild(a); a.click(); a.remove();
  return `post + ${lines.length - 1} comments (page counter shows ${shown})`;
})();
```

LinkedIn now obfuscates its class names, so the snippet finds comments by their `replaceableComment_urn…` component keys and the post by its text. If it finds 0 comments on a post that has them, inspect `[componentkey]` elements and fix the selectors in this file (kb-maintain).

The script sets `expected` to the number it captured, so the count check cannot catch a miss: compare `post + N comments` with the page counter yourself. If the counter is higher after everything is expanded, say so in the reply.

**If Chrome blocks the download** (nothing lands in the download folder or on the Desktop), run `document.body.innerHTML = ''; const p = document.createElement('pre'); p.style.whiteSpace = 'pre-wrap'; p.textContent = window.__kbdoc; document.body.appendChild(p)`, read the page with `get_page_text`, and write the file to `migration/inbox/` unchanged.

LinkedIn's comment count includes replies. If the count still differs after expanding everything, say so in the reply rather than retrying in a loop.

For a sign-in-walled `pulse` article, add `title: "<article title>"` to the downloaded file's frontmatter before ingesting, so the title is not devised.

## Ingest

```sh
npx kb ingest-browser migration/inbox/linkedin-<id>.md [--note "<owner's words>"]
```

`published` comes from the activity ID; the title is devised by the tag call (`title-devised: true`).
