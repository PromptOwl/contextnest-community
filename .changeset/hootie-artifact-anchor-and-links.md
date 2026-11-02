---
"@promptowl/contextnest-community": patch
---

Hootie answers with an HTML artifact open. The open document is now always in Hootie's context — on its own budget, cut with a visible `[trimmed]` marker when it is too long instead of being dropped (which used to turn into "Node not found") — and an artifact's HTML is reduced to the text the page shows, so scripts and styles never reach the model. Every `[[link]]` in an answer renders: a link matches a retrieved document by title, id or slug, ignoring case, dash and quote style, on both the server and the panel, and a link that matches nothing shows as plain text without brackets.
