---
"@promptowl/contextnest-community": patch
---

Eight Community improvements across the markdown renderer, the inbox, reviews, the graph, search, sharing and folders.

**Math and footnotes render.** `$…$` and `$$…$$` are typeset with KaTeX, and inline math that starts or ends with whitespace is left as text so prose like "costs $5 and $10" is unaffected. Footnotes already parsed, but the editor escaped the reference bracket on save, storing `[^1]` as `\[^1\]` — that escape is now undone alongside the wikilink one.

**Notifications can be cleared one at a time.** The inbox only offered "Mark all read"; each row now carries its own mark-as-read control.

**A pending submission can be withdrawn.** Review rows under "Waiting on others" offer Withdraw, cancelling the review and returning the document to Draft — previously the only exit was Delete. The endpoint existed but was unreachable and unauthorized; it now admits the submitter, and otherwise requires approve rights.

**The graph navigates.** Coverage-gaps orphan entries open their document, the selected-node panel gains an Open document action, and double-clicking a document node opens it. Single click still selects the node, so the neighborhood highlight and copyable query are unchanged.

**An empty nest no longer looks fully governed.** With no documents, Coverage gaps showed "Every category has a steward" and "No orphans" — vacuously true. It now says there is nothing to evaluate yet.

**Search says what it is searching.** The ⌘K palette searched one nest or every nest depending on where it was opened, with nothing indicating which. It now names its scope and, inside a nest, offers This nest / All nests.

**Nest access is one surface.** The Collaborators tab and the Share dialog duplicated each other, with the tab sending users to the dialog for visibility. Visibility moves into a control both render, the tab now covers visibility, people and teams, and the nest's Share button opens that tab.

**New folders start empty.** Creating a folder seeded a real "Overview" document that then counted as content everywhere, including the AI-eligible set of an auto-approved nest. A folder is a directory in the vault, so creating one now creates that directory with only the generated INDEX.md in it; folder listings merge the vault's directory shape with the index's counts, and deleting a folder removes its directory.
