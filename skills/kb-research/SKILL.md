---
name: kb-research
description: Answer questions from the Markdown knowledge base with ranked links to original sources. Use for any question about documentation practice, docs tools, examples of docs sites, pages, portfolios or repos, case studies, talks at an event, or "latest" news on a docs topic, when a kb.config.yaml knowledge base is present.
---

# kb-research: answer from the knowledge base

Run commands from the knowledge-base repo root (the folder with `kb.config.yaml`). Answers are **ranked links to the original sources**, grouped, never an essay. Read as little as possible: the command returns everything needed for the answer.

## 1. Map the question to facets

`kb research` expands the question through every concept scheme itself (labels, alt-labels, narrower terms, closed schemes such as lifecycle stages and doc types). Your job is the intent, as flags:

| The question asks… | Flags |
|---|---|
| "How have companies…", "who has done…", "case studies" | `--knowledge-types case-study --first-hand` |
| "Tools for…", "what tools…" | `--knowledge-types tool-overview,comparison` (and `--tools <slug>` if one is named) |
| "Latest…", "what's new" | `--sort published` |
| "News about…" | `--genre news --sort published` |
| "Best practices", "how should I set up…" | `--knowledge-types best-practice,how-to`, plus `--org-contexts <startup\|scaleup\|enterprise\|solo-writer\|open-source>` if the question says |
| "What came out of <event>", "talks at <event>" | `--event <event slug>` (editions are included); for an overview also run once with `--genre recap` |
| "Show me examples of…" | `--knowledge-types example --sort best`, plus `--type docs-site,docs-page,portfolio,repo` or `--tools <generator slug>` ("Mintlify sites") when named |

Find slugs with `npx kb find-entity "<name>"` (tools, organizations, events). Unsure of the intent? Run without flags.

## 2. Retrieve

```sh
npx kb research "<the question, in the owner's words>" [flags] [--k 12]
```

It uses fast mode (thesaurus-expanded keyword and vector search fused with catalog facet matches, catalog weight 1.5) and returns JSON: `terms` (matched vocabulary) and `results`, best first. Items that pass the flags come first (`"filter": true`), then other strong matches; `--strict` drops the others.

Each result has `title`, `type`, `published`, `description`, `file` (with `#segment-slug` when the match is in a segment), `link` (the original; YouTube links carry `&t=<seconds>` for the segment), `segment`, `knowledge-types`, `first-hand`, `best`, `note`, `example-of`, `how-built` (case studies about the same organization, for examples), and `chunk` (the matched text).

**In Claude desktop** (no shell), call the `kb_research` MCP tool instead: `question`, plus the flags above as arguments (`"knowledge-types": ["case-study"]`, `"first-hand": true`, `"sort": "published"`, `"k": 12`). It returns the same JSON.

Run a second query only when the first is thin (fewer than about 4 relevant results) or the question has two distinct parts. Do not run one query per group.

## 3. Check, sparingly

Judge relevance from `description`, `segment` and `chunk`. Open an item file only to verify a borderline match, and then read only its frontmatter and the matched segment (`grep -n "^### " <file>` to find it). Never open whole transcripts. In Claude desktop, use `kb_get` with the result's `id` and the `#segment` slug instead of opening the file.

## 4. Answer

Groups, in this order, omitting empty ones: **Best practices · Case studies (first-hand) · Examples · Tools · Latest**.

- Best practices: `best-practice`, `how-to`, `reference`.
- Case studies: `case-study` with `first-hand: true` (others may follow, marked "reported").
- Examples: `example`; `best: true` first, then items whose `note` matches the question. Show the owner's `note` in quotes and `example-of`. Add `how-built` items as "how they built it".
- Tools: `tool-overview`, `comparison`, and tools named across the results.
- Latest: up to 5 results from the last 12 months, newest first, when the question asks for it or the topic moves fast.

Each entry, one or two lines:

```
- [Title](link) — why it is relevant, in one line. (published) · `items/file.md#segment-slug`
```

For audio and video, the `link` is already timestamped. Put each item in one group only. Add a short synthesis only if the owner asks for one.

## 5. After answering

- Offer to save the answer as `briefs/<YYYY-MM-DD>-<slug>.md` (the answer plus a list of the item IDs). Write it only if the owner says yes.
- If the owner points out a miss ("you missed the Acme talk"), append one line to `evals/misses.md`: date, question, the missing item's ID or URL, and what it should have matched on. Do not change tags here; that is kb-maintain.

## Rules

- No web search unless the owner asks; the knowledge base is the source.
- Never invent links. Every link comes from a result's `link`.
- If nothing relevant comes back, say so and name the matched `terms`, so the owner can see what was searched.
