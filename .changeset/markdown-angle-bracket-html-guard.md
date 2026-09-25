---
"@promptowl/contextnest-community": patch
---

Fix inline text in angle brackets (e.g. `Array<string>`) being silently dropped when switching to the Rich editor, and in the read-only Preview.

CommonMark treats any `<word>` as a raw HTML tag, not just real markup. Once
parsed that way, an unrecognized tag name like `string` has no separate text
of its own to fall back to, so the Rich editor's ProseMirror parser dropped
it entirely and the read-only Preview's HTML-stripping erased it outright —
in both cases permanently, since saving and reopening re-parsed the already
corrupted text. Both pipelines now only treat a small allow-list of real HTML
tags (the ones this app actually round-trips, like the color-mark `<span>`)
as markup; anything else renders as the literal text it is.
