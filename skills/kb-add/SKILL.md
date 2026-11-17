---
name: kb-add
description: Save links to the Markdown knowledge base. Use when the owner pastes one or more links (web pages, YouTube, podcasts, repos, docs sites, portfolios, Slack threads, LinkedIn posts) and says add, save, bookmark or capture. Also for "refresh" of a saved Slack thread or LinkedIn post.
---

# kb-add: save links to the knowledge base

Run every command from the knowledge-base repo root (the folder with `kb.config.yaml`). Read `kb.config.yaml` first: `owner` is the person you are working for, `slack-workspaces` lists the Slack workspaces you may save from.

Scripts do all fetching, capture, IDs, dates and file writing. The model judgment happens in one headless tag call per link that `kb` starts itself. **Never write or edit item files by hand, never retype captured text, never set `best` unless the owner says so in this request.**

## 1. Sort the links

For each link, keep the owner's own words about it (for example "great API reference with a try-it console") exactly as written: they become the item's `note`. Words that are instructions, not description, are not a note:

| Owner says | Flag |
|---|---|
| "bookmark this", "bookmark only" (for a page, post or episode) | `--bookmark` |
| "make it a blog", "it's a talk" (a type correction) | `--type <type>` |
| "mark as good", "star it" | `--best` |
| "this is a series" | leave out of the note; mention that `series` needs a `series/` file (kb-maintain) |

Then split the links:

- **Slack** (`*.slack.com`) and **LinkedIn** (`linkedin.com/feed/update/…`, `/posts/…`, `/pulse/…` behind a sign-in wall): browser, one at a time, Slack first (Slack hides threads after 30 days). Go to step 3.
- **Everything else** (web pages, YouTube, podcasts, repos, sites): headless batch, step 2.

If the owner asks to fully index a source (a whole blog, channel, podcast or docs site), reply: "Send me the specific post, page or episode." Sources are always saved as bookmarks.

## 2. Web and YouTube links: one headless batch

Even for a single link:

```sh
npx kb add-batch <url1> [--note "<owner's words>"] [--bookmark] [--type <t>] [--best] <url2> …
```

Quote each note. For each link the command checks for an existing item (`kb find`), classifies the type, captures (page text, YouTube captions, podcast transcript, or bookmark inputs for sources), runs **one** headless `claude -p --model sonnet` tag call that also writes Summary, Key takeaways, Tools mentioned and Articles & resources, then, after all links: `kb validate`, one commit `add: <titles>`, one `kb index`.

Use `--no-index` when you will add more links in the next few minutes, and run `npm run index` once at the end.

Relay the output lines as they are (step 5). Do not open the new item files to check them.

## 2a. After validate, commit and index: new candidate terms

Once the final `npm run validate`, commit and `npm run index` are done (by `add-batch` or `ingest-browser`, or by you after `--no-index`), run:

```sh
npx kb term-usage --new-only
```

It prints a line only for candidate terms this add created or that just reached two items, and nothing otherwise. **Never run plain `kb term-usage` (the full list) during kb-add.** Copy each `Candidate "<term>" is now used by 2 items. Approve it?` line into the reply unchanged.

If the owner says yes to one: set `status: approved` in its file under `concepts/<scheme>/`, append `- YYYY-MM-DD: approved candidate <scheme> term "<term>". Reason: used by 2 items (literary warrant).` to `concepts/CHANGELOG.md`, then `npm run validate` and commit (`vocab: approve <term>`).

## 3. Slack and LinkedIn: browser, one at a time

1. `npx kb find <url>`. If it exists and the owner did not say "refresh", stop and reply with the file.
2. Load the Claude in Chrome skill and open the link in a new tab. Never use Playwright or the built-in browser; if the `mcp__claude-in-chrome__*` tools are not available, stop and tell the owner to restart with `kbc`. If you see a sign-in page, ask the owner to sign in; never type credentials.
3. Follow the source's reference file for expanding the thread and the extraction snippet:
   - Slack: `references/slack.md`
   - LinkedIn: `references/linkedin.md` (one post at a time, only at the owner's request, never bulk)
4. The snippet downloads a `.md` file. Move it from the browser's download folder into `migration/inbox/`.
5. Ingest it (it checks the message count, builds the verbatim captured text, tags in one headless call, validates, commits and indexes):

   ```sh
   npx kb ingest-browser migration/inbox/<file>.md [--note "<owner's words>"]
   npx kb ingest-browser migration/inbox/<file>.md --refresh    # existing item: appends new replies, never deletes
   ```

6. If it reports a message-count mismatch, expand what is missing and download again. Only if the download itself fails may you paste the extracted text into the inbox file yourself, unchanged.
7. **Shared links:** the command lists the links found in the thread. Ask the owner which to save. Save the chosen ones with step 2, adding `--shared-in <thread id>` after each URL.

## 4. Existing items

`kb add-batch` never overwrites: an existing item comes back as `Already saved: …`. Offer a refresh:

- Slack or LinkedIn: step 3 with `--refresh`.
- Web or YouTube: re-capture is a kb-maintain task (`kb tag --redo` after a re-fetch); offer it, do not do it unasked.

## 5. Reply

One line per item, exactly as the command prints it:

```
Saved as <type>[ bookmark]: <title> (<file>)
```

Add more only for what the command flags under an item: a failed or short capture, auto-captions only, a candidate term, a review-queue entry, synonym suggestions (`"doc rot" → Content drift`, logged to `migration/synonym-suggestions.md`; mention them only when there are any, and never add them to the vocabulary here), or a missing parent source (`blog not saved — say 'bookmark the blog' to add it`). Then any lines from step 2a.

"Tools mentioned" links come from the tool files (`tools/<slug>.md` `resource`), or from a URL in the item's own text, which the script then saves to the tool file. Never add a tool link yourself. The owner may correct the type ("make it a blog"): re-add is not possible over an existing item, so note it for kb-maintain.

If validation fails, nothing is committed: show the failing lines and stop.

## Rules

- Commands run in the repo root; on Windows use the same commands in PowerShell or Git Bash.
- Model: Sonnet for tagging (the command picks it). Do not tag in this session.
- Never use `git commit --no-verify`.
- Tools are not items. If the owner wants a tool saved ("save Vale as a tool"), it is a `tools/` entity: use kb-maintain.
- Source-type detail (what each type means, bookmark inputs): `references/types.md`.
