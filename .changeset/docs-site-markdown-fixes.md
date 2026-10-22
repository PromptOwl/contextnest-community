---
"@promptowl/contextnest-community": patch
---

Public docs site rendering fixes (CU-wdqcq05raw). Bare filenames such as `CONTEXT.md` are no longer turned into `http://CONTEXT.md` links, and only URLs with a scheme are autolinked. Aliased wikilinks (`[[page|label]]`) now work inside table cells. HTML comments are removed from the HTML pages, the Markdown twins and `llms-full.txt`, but kept inside code. Tag hub pages get a readable title that keeps acronyms upper-case (`mcp` → "MCP") and a description that names the topic and counts its pages. A node's frontmatter `description` can now be set or cleared through REST `PATCH /nodes/:id` and MCP `context_update`.
