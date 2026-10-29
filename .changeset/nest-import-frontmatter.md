---
"@promptowl/contextnest-community": patch
---

**Nest import reads markdown frontmatter.** Importing `.md` files into an open nest (Import → Files or Whole vault, or drag-and-drop) now takes the document's title and tags from its YAML frontmatter and keeps the block out of the body, matching the dashboard's Import Folder. Files without frontmatter, or with YAML that doesn't parse, import exactly as before.
