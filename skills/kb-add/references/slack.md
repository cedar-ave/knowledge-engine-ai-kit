# Slack threads

Slack hides messages older than 30 days on free workspaces, so save Slack links first. The workspace must be listed under `slack-workspaces` in `kb.config.yaml`; for `app.slack.com/client/T…/C…` links the team ID maps to the subdomain there. If it is missing, ask the owner to add it.

## Expand

1. Open the thread link. The thread opens in the right-hand pane.
2. Note the reply count shown at the top of the thread ("12 replies").
3. Click every "Show more" inside long messages. The snippet also clicks them, but check.

## Extract

Run this in the page (browser tool's JavaScript runner). Set `LINK` to the link the owner gave. It scrolls the thread pane from the top, collects every message once (by timestamp), turns links into `text (url)`, and downloads `slack-<ts>.md`.

```js
(async () => {
  const LINK = 'PASTE THE THREAD LINK';
  const pane = document.querySelector('[data-qa="threads_flexpane"]') || document.querySelector('.p-flexpane') || document;
  const scroller = [...pane.querySelectorAll('.c-scrollbar__hider')].sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad = (n) => String(n).padStart(2, '0');
  const when = (ts) => { const d = new Date(Number(ts) * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const textOf = (el) => {
    const c = el.cloneNode(true);
    c.querySelectorAll('a[href]').forEach((a) => { const t = a.innerText.trim(); a.replaceWith(t && t !== a.href ? `${t} (${a.href})` : a.href); });
    return c.innerText.trim();
  };
  const msgs = new Map(); let who = '';
  const grab = () => {
    pane.querySelectorAll('button').forEach((b) => { if (/^show more$/i.test(b.innerText.trim())) b.click(); });
    for (const m of pane.querySelectorAll('[data-qa="message_container"]')) {
      const ts = m.querySelector('[data-ts]')?.getAttribute('data-ts') || m.querySelector('a.c-timestamp')?.getAttribute('data-ts');
      const name = m.querySelector('[data-qa="message_sender_name"]')?.innerText.trim();
      if (name) who = name;
      if (!ts || msgs.has(ts)) continue;
      const body = m.querySelector('[data-qa="message-text"]') || m.querySelector('.c-message_kit__blocks');
      msgs.set(ts, `[${when(ts)}] ${name || who}: ${body ? textOf(body) : ''}`);
    }
  };
  if (scroller) { scroller.scrollTop = 0; await sleep(800); }
  for (let i = 0; i < 200; i++) {
    grab();
    if (!scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) break;
    scroller.scrollTop += Math.floor(scroller.clientHeight * 0.7); await sleep(500);
  }
  grab();
  const replies = Number((pane.innerText.match(/(\d+)\s+repl(?:y|ies)/i) || [])[1] ?? NaN);
  const channel = (document.querySelector('[data-qa="channel_name"]')?.innerText || document.title.match(/#?[\w-]+/)?.[0] || '').trim();
  const body = [...msgs.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([, t]) => t).join('\n\n');
  const fm = ['---', `url: "${LINK}"`, channel ? `channel: "#${channel.replace(/^#/, '')}"` : '', Number.isFinite(replies) ? `expected: ${replies + 1}` : '', '---', ''].filter((l) => l !== '').join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([`${fm}\n${body}\n`], { type: 'text/markdown' }));
  a.download = `slack-${[...msgs.keys()].sort()[0] ?? 'thread'}.md`; a.click();
  return `${msgs.size} messages${Number.isFinite(replies) ? ` (page shows ${replies} replies + parent)` : ''}`;
})();
```

Slack changes its markup now and then. If the snippet finds 0 messages, inspect one message element, fix the selectors in this file (kb-maintain), and run it again.

## File format `kb ingest-browser` expects

```markdown
---
url: "https://example-workspace.slack.com/archives/C0000000000/p1700000000000001"
channel: "#ai-docs"
expected: 4
---
[2026-05-04 09:12] Jane Doe: First message …

[2026-05-04 09:30] Sam Roe: A reply … continuation lines are kept as they are.
```

`expected` is the number of messages (replies + the parent). A mismatch is reported; expand and download again.

## Refresh

`npx kb ingest-browser <file> --refresh` appends messages whose header line is not already in the item. It never deletes or edits saved messages.
