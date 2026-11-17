# LinkedIn posts and articles

**Capture must use Claude in Chrome (`mcp__claude-in-chrome__*`), which acts in the owner's own signed-in Chrome. Never use Playwright or any other browser for this. If the Claude in Chrome tools are not available, stop and tell the owner to restart with `kbc`.**

**One post at a time, only when the owner asks for that post. Never bulk, never browse feeds or profiles.**

`linkedin.com/feed/update/urn:li:activity:<id>` and `linkedin.com/posts/…-activity-<id>-…` are posts. `linkedin.com/pulse/…` is an article: try `npx kb add-batch <url>` first (public articles extract without the browser); use the browser only if it comes back `extraction-failed` or summary-only.

## Expand

1. Open the post. If LinkedIn shows a sign-in wall, ask the owner to sign in in that browser.
2. Note the comment count under the post ("8 comments").
3. Click "…see more" on the post, "Load more comments" until it disappears, and "See previous replies" / "Load more replies" on each comment. The snippet also clicks these in a loop, but check.

## Extract

Set `LINK` to the owner's link. The post line gets its date from the activity ID; comments get LinkedIn's relative age (`+2w`), because the page shows no exact date.

```js
(async () => {
  const LINK = 'PASTE THE POST LINK';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const more = /^(…?see more|load more comments|see previous replies|load more replies|show more replies|view more comments)$/i;
  for (let i = 0; i < 40; i++) {
    const btns = [...document.querySelectorAll('button')].filter((b) => more.test(b.innerText.trim().replace(/\s+/g, ' ')));
    if (!btns.length) break;
    btns.forEach((b) => b.click()); await sleep(900);
  }
  const textOf = (el) => {
    if (!el) return '';
    const c = el.cloneNode(true);
    c.querySelectorAll('a[href]').forEach((a) => { const t = a.innerText.trim(); const h = a.href.split('?')[0]; a.replaceWith(/linkedin\.com\/(in|company)\//.test(h) || !t ? t : t === h ? h : `${t} (${h})`); });
    return c.innerText.replace(/…?\s*see (more|less)\s*$/i, '').trim();
  };
  const id = (decodeURIComponent(LINK).match(/(?:activity[:-]|share[:-]|ugcPost[:-])(\d{19})/) || [])[1];
  const pad = (n) => String(n).padStart(2, '0');
  const d = id ? new Date(Number(BigInt(id) >> 22n)) : new Date();
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const post = document.querySelector('.feed-shared-update-v2, [data-urn*="activity"]') || document;
  const author = post.querySelector('.update-components-actor__title span[aria-hidden="true"], .update-components-actor__name span[aria-hidden="true"]')?.innerText.trim() || 'Author';
  const text = textOf(post.querySelector('.update-components-text, .feed-shared-inline-show-more-text, .feed-shared-text'));
  const lines = [`[${day}] ${author}: ${text}`];
  const comments = post.querySelectorAll('article.comments-comment-entity, article.comments-comment-item');
  for (const c of comments) {
    const who = c.querySelector('.comments-comment-meta__description-title, .comments-post-meta__name-text')?.innerText.trim().split('\n')[0] || 'Unknown';
    const age = c.querySelector('time, .comments-comment-meta__data')?.innerText.trim().split(/\s|•/)[0] || '?';
    const body = textOf(c.querySelector('.comments-comment-item__main-content, .update-components-text'));
    const reply = c.closest('.comments-replies-list, .comments-comment-entity__replies') ? '↳ ' : '';
    lines.push(`[+${age}] ${reply}${who}: ${body}`);
  }
  const shown = Number(((post.innerText.match(/([\d,]+)\s+comments?/i) || [])[1] || '').replace(/,/g, ''));
  const fm = ['---', `url: "${LINK}"`, Number.isFinite(shown) && shown ? `expected: ${shown + 1}` : '', '---'].filter(Boolean).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([`${fm}\n${lines.join('\n\n')}\n`], { type: 'text/markdown' }));
  a.download = `linkedin-${id ?? 'post'}.md`; a.click();
  return `post + ${comments.length} comments${shown ? ` (page shows ${shown})` : ''}`;
})();
```

LinkedIn's comment count includes replies. If the count still differs after expanding everything, say so in the reply rather than retrying in a loop.

For a sign-in-walled `pulse` article, add `title: "<article title>"` to the downloaded file's frontmatter before ingesting, so the title is not devised.

## Ingest

```sh
npx kb ingest-browser migration/inbox/linkedin-<id>.md [--note "<owner's words>"]
```

`published` comes from the activity ID; the title is devised by the tag call (`title-devised: true`).
