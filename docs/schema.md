# Item schema

`schema/kb-item.schema.json` (`kb:item:1.0.0`) defines field shapes only. Allowed values for controlled fields come from the private repo's generated `schema/vocab.enum.json` (built by `kb gen-vocab` from `approved` terms). The only enums in the kit are structural: `type`, `capture`, term `status` and `in-scheme`. `additionalProperties` is `true` so manni's own vocabularies still apply.

Validation stack for `items/`: `google:okf:0.1`, `manni:core:1.0.0`, `manni:structure:1.0.0`, `manni:ai-context:1.1.0`, `kb-item.schema.json`, `vocab.enum.json`.

| Key | Standard it comes from | Notes |
|---|---|---|
| `id` | manni core | Item ID (`yt:`, `li:`, `slack:`, `web:`). Never changes |
| `type` | OKF (required), manni core | Kit enum of source and piece types |
| `title` | OKF, manni core | |
| `title-devised` | kit | `true` when the agent wrote the title |
| `description` | OKF, manni core | One sentence |
| `resource` | OKF | Canonical URL |
| `authors` | manni stewardship (name) | Here: slugs in `people/` or `organizations/` |
| `hosts`, `guests`, `organizations` | kit | Slugs of entity files |
| `publisher`, `event`, `series` | kit | `event` and `series` are slugs |
| `slack-workspace`, `slack-channel` | kit | Workspace must be listed in `kb.config.yaml` |
| `published` | Dublin Core `dcterms:issued` | W3CDTF |
| `captured-on` | kit | Date saved |
| `length-min` | kit | Audio and video |
| `concepts` | manni structure | 1 to 6 labels from the `topics` and `frameworks` schemes |
| `genre`, `knowledge-types`, `lifecycle-stages`, `org-contexts`, `doc-types` | kit | Notations from closed schemes |
| `example-of` | kit | Required when `knowledge-types` includes `example` |
| `tools` | kit | Up to 8 slugs in `tools/` |
| `first-hand`, `best`, `note` | kit | Agents never set `best` or `note` |
| `sample-questions` | manni ai-context | Strings only here. 3 to 5 for pieces, 1 to 3 for bookmarks |
| `segments` | kit | Slug must equal the GitHub slug of a `###` heading |
| `related-pages` | manni structure | Item IDs or URLs |
| `shared-in` | kit | Item IDs |
| `captured-text-sha256` | kit | Checked by `kb check-captured-text` |
| `capture` | kit | `verbatim`, `full-text`, `summary-only`, `extraction-failed`, `bookmark` |
| `part-of` | Dublin Core `dcterms:isPartOf` | `id` of the source item |
| `meta-provenance` | manni ai-context | manni's shape: `generated-by`, `fields` (JSON Pointers), `confidence`. Stored outside the page in `items.metadata.yaml`, declared by `externalMetadata` in `manni.config.yaml`. Deleting an entry marks it reviewed |
| `last-reviewed` | manni stewardship (key and pattern) | Date a human last reviewed the metadata. The kit schema repeats manni's pattern instead of adding `manni:stewardship` to the stack, because that schema wants `authors` outside the page |
| `notion-url` | kit | Migration trace. Remove after Phase 12 |

## External metadata

manni's ai-context schema marks `meta-provenance` as `x-manni-location: external`. The collection config lists `externalMetadata: [{file: ./items.metadata.yaml, keys: [meta-provenance]}]`, and the manifest maps each item path to its entries. `manni meta relocate` moves values there. Validation runs with no warnings.

## Other schemas

- `kb-term.schema.json` (`kb:term:1.0.0`): SKOS term files, on top of `manni:terminology:1.2.0`.
- `kb-entity.schema.json` (`kb:entity:1.0.0`): tools, people, organizations, events and series.
- `tag-output.schema.json` (`kb:tag-output:1.0.0`): the model-output contract for tagging (a patch plus confidence, never a whole file).
