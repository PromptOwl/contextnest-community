---
"@promptowl/contextnest-community": minor
---

Sharing a document takes one click. **Share public link** in a document's menu (and in the document row menu) copies its public link, or makes one first with the same defaults as the Publish dialog and says what became public, with Undo and Manage. Published pages (`/p/<slug>`) now show a title, an excerpt of the approved version and an image when the link is pasted into Slack, LinkedIn or a chat; a gated link shows no excerpt. Readers see one quiet line, **Make your own nest**, linking to this server's sign-up; a white-label nest shows none. An HTML document is now framed by the reader page so that line never goes inside it. Agents can do the same over MCP: `context_public_link_create`, `context_public_links` and `context_public_link_revoke` mirror `/nests/:id/publications`.
