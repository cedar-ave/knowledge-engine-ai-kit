# knowledge-engine-ai-kit

Public toolkit for a personal Markdown knowledge base: the `kb` CLI, JSON Schemas, a Claude plugin (skills), and a **fictional** sample dataset. Your own items live in a separate private repo and install this kit at a pinned tag.

```sh
npm install --save-dev "github:cedar-ave/knowledge-engine-ai-kit#v0.1.0"
npx kb validate
```

Requires Node 24 or later.

## Commands

`id`, `canonical`, `slug`, `gen-vocab`, `check-vocab`, `check-refs`, `check-ids`, `check-segments`, `check-captured-text`, `find-entity`, `rename-term`, `validate`. Later phases add `classify`, `fetch`, `capture`, `tag`, `apply-patch`, `index` and `build-site` (currently stubs). Pass `--root <dir>` to run against another folder.

## Development

```sh
npm test               # unit tests
npm run validate       # validate samples/
node scripts/leak-check.mjs
node scripts/gen-samples.mjs   # regenerate samples/
node scripts/gen-schemas.mjs   # regenerate schema/
```

No real item, transcript, Slack or LinkedIn text belongs in this repo. See `docs/schema.md` for the field table.

MIT licensed.
