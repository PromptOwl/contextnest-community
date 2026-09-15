---
"@promptowl/contextnest-community": minor
---

The document page reads like a page, not a form.

**An index beside the document.** Every nest you can see sits in a collapsible rail on the left, the current one opened into its views — Overview, Review queue (with its pending count), Board, Graph, Definitions, Workflows, gated the same way as the nest view switcher — and its folder → document tree with the open document highlighted, the same tree the nest's Documents tab shows. Moving between documents is one click; hide the rail and it stays hidden (per browser). On a phone the rail is a drawer.

**One top bar.** Where you are (nest › folder, status) on the left; what you can do on the right: last-edited time, the nest's visibility — an owner or admin flips private / organization / public right there, with the same going-public acknowledgement as the Share dialog — Share, Comments, Compare, Submit for review, Save, and everything else in ⋮ (version history, markdown source, copy link, move, share this document, publish, discard draft, delete). The sticky footer and the Title / Tags / Content labels and boxes are gone: the title is the heading, tags are a quiet row under it, and the body is the page.

**Click to write, select to format.** The body is prose until you click into it; the block toolbar appears with the caret and leaves with it, and highlighting text brings up the formatting bubble. The window scrolls, not a box inside the page.

**Comments stay out of the way.** The comments rail starts closed instead of taking a third of the width to say "No comments yet", and opens from the top bar (with the open-thread count), for a deep link to a thread, on entering comment mode, or when you pin a comment to a selection. Its state is remembered per browser.

**Fix: opening a document no longer says "Unsaved changes".** A document whose markdown didn't round-trip byte-for-byte through the editor — any document with a table — opened already dirty and wrote a spurious version on the first click-out. The editor normalising a freshly parsed table is no longer reported as an edit.
