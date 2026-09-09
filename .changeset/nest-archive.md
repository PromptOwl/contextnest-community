---
"@promptowl/contextnest-community": minor
---

**Archive a nest instead of deleting it.** Delete was the only way to get a finished nest off the dashboard, and it takes the documents and the whole version history with it — so people either kept the clutter or destroyed something they might still need.

Archiving is the reversible middle ground. The nest keeps every document, version and steward assignment, and leaves every surface it used to appear on: the dashboard grid, cross-nest search, the work inbox, My Drafts, the MCP nest index — and MCP by id too, so a pinned nest id or a nest-scoped key stops answering rather than quietly feeding an agent from a nest you put away. Published `/p/` links stop resolving while it is archived. It stays readable in the web UI, so you can check what is in there before restoring or deleting, and nothing at all can be written to it — the owner included.

A new **Archived** tab on the dashboard lists them and restores them, after a confirmation. Restoring puts everything back exactly as it was, links included.

Archive sits inside the delete dialog rather than in a menu of its own: someone reaching for Delete is deciding whether they still need the nest, and that is where the reversible option belongs. Editors, who cannot delete a nest, can now ask for one to be archived from the same request dialog they use to ask for it to be deleted — same queue, same reviewers, and honouring it archives rather than destroys.
