---
name: kb-maintain
description: Maintain the Markdown knowledge base on explicit request only. Use when the owner asks to edit or promote vocabulary terms, rename a term, merge duplicate tools, people or organizations, re-tag items, run the retrieval eval, check for dead links, or upgrade manni or qmd.
---

# kb-maintain: rare, explicit upkeep

Run commands from the knowledge-base repo root (the folder with `kb.config.yaml`). Do only the task asked. **Anything destructive (deleting, merging, renaming, rewriting many files) needs the owner's confirmation first**: show what will change, then wait.

End every task with `npm run validate` and one commit describing it. Never use `git commit --no-verify`.

## Vocabulary (`concepts/<scheme>/<term>.md`)

- **Promote candidates:** `npx kb term-usage` lists candidate terms with item counts. A candidate with 2+ items may become `approved` (literary warrant). Set `status: approved` in the term file.
- **Add, edit, deprecate:** one term per file. Closed schemes (`genres`, `knowledge-types`, `lifecycle-stages`, `doc-types`, `org-contexts`) change only when the owner asks. A deprecated term gets `status: deprecated` and `see: <preferred label>`.
- **Rename:** `npx kb rename-term "<old>" "<new>"` updates the term file and every item, and keeps the old label as a hidden label.
- **Synonym suggestions:** `migration/synonym-suggestions.md` lists wording items use for a term they are tagged with. For each row the owner accepts, add the wording to the term's `alt-labels` (CHANGELOG line), then delete the row. Delete rejected rows.
- **Every change** adds one line to `concepts/CHANGELOG.md`: `- YYYY-MM-DD: <change>. Reason: <why>.`
- `narrower` is never stored; it is derived from `broader`.

## Entities (`tools/`, `people/`, `organizations/`, `events/`, `series/`)

- Before creating one: `npx kb find-entity "<name>"`. A match is reused.
- **Merge duplicates:** `npx kb entity-duplicates` lists candidate pairs. For each confirmed pair, keep one file, move the other's names into `alt-labels` and profile URLs into `same-as`, replace the old slug in every item (`grep -rl "<old-slug>" items`), delete the old file. Show the plan and confirm first.
- **Tool links:** `npx kb tools-missing-links` lists tool files with no `resource` (items using each first). Fill a `resource` only from the owner or the tool's own site, then `npx kb fill-tool-links` adds the link to every unlinked "Tools mentioned" line for that tool (existing links are kept).
- A tool the owner wants saved is a `tools/<slug>.md` file (`type: tool`, `title`, `description`, `resource`), not an item.
- A series the owner names: `series/<slug>.md`, then add the slug to each item's `series`.

## Re-tagging

```sh
npx kb tag --redo --files items/<a>.md,items/<b>.md
```

One headless Sonnet call per item. Items the script doubts go to `migration/review-queue.md`. Never re-tag everything without confirmation (cost). `note` and `best` are the owner's and are never changed.

To re-capture a web or YouTube item before re-tagging: delete its `## Captured text` section and `captured-text-sha256`, set `capture: summary-only`, then `npx kb fetch --limit 1` picks it up. Confirm first: verbatim text is replaced.

## Retrieval eval

```sh
npm run eval -- --modes fast --label "<what changed>"
npx kb eval --modes fast --explain      # adds why each zero-recall question missed
```

Writes `evals/report.md`. Use the misses in `evals/misses.md` to suggest vocabulary or tag fixes; apply them only when the owner agrees.

## Dead links

```sh
npx kb check-links
```

Checks every `resource` and lists dead or moved links in `evals/dead-links.md`. No archive service is used. If the command is not available in the installed kit version, say so instead of checking by hand.

## Assets

If `assets/` passes 1 GB, move `assets/**/*.webp` to Git LFS (`git lfs track "assets/**/*.webp"`, then `git lfs migrate import --include="assets/**/*.webp"`). Confirm first: it rewrites history.

## Upgrading manni or qmd

1. In the kit repo, change the pinned version in `package.json`, `npm install`, `npm test`, and `npm run validate` (samples).
2. In the knowledge-base repo, with the new kit installed: `npm run validate`, then `npm run index` (qmd) and `npm run eval -- --modes fast` to compare recall with the last report.
3. Only if all pass: tag a new kit version and bump the knowledge-base dependency.
