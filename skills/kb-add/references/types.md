# Item types and capture

`kb classify <url>` decides the allowed types from the link pattern; the tag call picks within them. Every type is a **source** (always a bookmark, no content stored) or a **piece** (content captured).

## Sources: `capture: bookmark`

| Type | What it is | Its pieces |
|---|---|---|
| `blog` | A blog as a whole | `article` |
| `newsletter` | A publication (a Substack, a mailing list) | `article` (one issue) |
| `podcast` | The show | `episode` |
| `channel` | A video channel on any platform | `video`, `talk`, `episode` |
| `docs-site` | A documentation site (default: example) | `docs-page` |
| `portfolio` | A writer's or designer's portfolio (default: example) | none |
| `website` | Any other site as a whole | `article` |
| `repo` | A repo kept as an example or reference (default: example). A repo you would *use* is a `tools/` entity | none |
| `book` | A book (summary and why it matters only) | none |
| `course` | A course as a whole | none |

Bookmark inputs come from a script (`migration/bookmark-inputs/<file>.json`): page title and description, up to 20 recent feed, episode or video titles, and for docs sites `/llms.txt`, navigation labels and the site generator. Page bodies are never fetched.

## Pieces

| Type | Capture | Parent (`part-of`) |
|---|---|---|
| `article` | Full text (blog posts, news, vendor guides, PDF reports, newsletter issues) | `blog`, `website`, `newsletter` |
| `episode` | Verbatim transcript: published transcript page, else a YouTube upload, else whisper.cpp | `podcast`, `channel` |
| `video`, `talk` | Verbatim transcript from YouTube captions | `channel` |
| `slide-deck` | Slide text; only a deck published with no recording | none |
| `docs-page` | Full text (default: example) | `docs-site` |
| `linkedin-post`, `linkedin-article`, `slack-thread` | Verbatim, from the browser | none |

A conference or meetup presentation is a `talk`; an installment of a recurring show is an `episode`; any other video is a `video`.

## Parents

When a piece is saved, the script sets `part-of` if its source is already saved (matched by URL prefix, or by YouTube channel). It never creates the source; the reply says `<source type> not saved — say 'bookmark the <source type>' to add it`.

## Captures that need a person

- `extraction-failed`: the page could not be read. The item keeps a summary from the page metadata. Options: the owner pastes the text, gives another URL, or leaves it.
- `partial`: paywall preview only. Capture the full text in the browser later.
- Auto-captions only: the transcript is machine captions; wording may be wrong.
