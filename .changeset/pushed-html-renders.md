---
"@promptowl/contextnest-community": patch
---

HTML documents sent with `ctx push` now render as pages. A pushed body starts with the blank line under its frontmatter, and the viewer's HTML check didn't allow for leading whitespace, so those pages showed a blank gap followed by broken text. The viewer now allows leading whitespace, and the server drops leading blank lines from pushed bodies (the indentation on the first real line is kept).
