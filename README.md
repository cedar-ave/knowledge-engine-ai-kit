# knowledge-engine-ai-kit

Public toolkit for a personal Markdown knowledge base: the `kb` CLI, JSON Schemas, a Claude plugin (skills), and a **fictional** sample dataset. Your own items live in a separate private repo and install this kit at a pinned tag.

```sh
npm install --save-dev "github:cedar-ave/knowledge-engine-ai-kit#v1.0.0"
npx kb validate
```

Requires Node 24 or later.

## Commands

- Add: `find`, `add-batch` (web and YouTube; one headless tag call per link, then validate, commit, index), `ingest-browser` (Slack and LinkedIn downloads), `classify`, `fetch`, `fetch-bookmark`, `tag`.
- Research: `research` (fast retrieval with facet filters, JSON out), `mcp` (stdio MCP server for Claude desktop with `kb_research` and `kb_get`), `index`, `build-catalog`, `eval`.
- Upkeep: `validate`, `regen`, `gen-vocab`, `check-vocab`, `term-usage`, `rename-term`, `check-refs`, `check-ids`, `check-segments`, `check-captured-text`, `find-entity`, `entity-duplicates`, `check-links`, `cursor-skills`.

Pass `--root <dir>` to run against another folder.

## Skills

The Claude plugin in `skills/`: `kb-add`, `kb-research`, `kb-maintain`. Enable it in the knowledge-base repo's `.claude/settings.json`. For Cursor, `npx kb cursor-skills` copies them to `.cursor/skills/`.

## Claude desktop

`kb mcp` serves the knowledge base to Claude desktop over stdio: `kb_research` (a question and the same facet flags as `kb research`, as arguments) and `kb_get` (an item ID, optionally one segment slug). Register it in `claude_desktop_config.json` with absolute paths, since Claude desktop does not set a working directory:

```json
{
  "mcpServers": {
    "kb": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/kb-repo/node_modules/knowledge-engine-ai-kit/bin/kb.mjs", "mcp", "--root", "/absolute/path/to/kb-repo"]
    }
  }
}
```

Upload `skills/kb-research` as a zip in Claude desktop (Settings → Capabilities → Skills) so answers follow the same grouping. Adding items stays in Claude Code.

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
