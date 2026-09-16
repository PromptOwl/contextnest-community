---
"@promptowl/contextnest-community": minor
---

The document page reads like a page, not a form.

**An index beside the document.** Every nest you can see sits in a collapsible rail on the left, the current one opened into its views — Overview, Review queue (with its pending count), Board, Graph, Definitions, Workflows, gated the same way as the nest view switcher — and its folder → document tree with the open document highlighted, the same tree the nest's Documents tab shows. Moving between documents is one click; hide the rail and it stays hidden (per browser). On a phone the rail is a drawer.

**One top bar.** Where you are (nest › folder, status) on the left; what you can do on the right: last-edited time, the nest's visibility — an owner or admin flips private / organization / public right there, with the same going-public acknowledgement as the Share dialog — Share, Comments, Compare, Submit for review, Save, and everything else in ⋮ (version history, markdown source, copy link, move, share this document, publish, discard draft, delete). The sticky footer and the Title / Tags / Content labels and boxes are gone: the title is the heading, tags are a quiet row under it, and the body is the page.

**Click to write, select to format.** The body is prose until you click into it; the block toolbar appears with the caret and leaves with it, and highlighting text brings up the formatting bubble. The window scrolls, not a box inside the page.

**Comments stay out of the way.** The comments rail starts closed instead of taking a third of the width to say "No comments yet", and opens from the top bar (with the open-thread count), for a deep link to a thread, on entering comment mode, or when you pin a comment to a selection. Its state is remembered per browser.

**Fix: opening a document no longer says "Unsaved changes".** A document whose markdown didn't round-trip byte-for-byte through the editor — any document with a table — opened already dirty and wrote a spurious version on the first click-out. The editor normalising a freshly parsed table is no longer reported as an edit.

**Turn into.** A document can now become an agent, skill, tool, table or hosted artifact after the fact — ⋮ → *Turn into…* on the document page, and *Turn into a document* on an artifact's page — where the type used to be fixed at creation. `PATCH /nests/:id/nodes/:nodeId` accepts `type` with the same gate as create; converting to a skill defaults its trigger from the title, and converting away from a runnable type drops its schedule.

**The sidebar stays.** Leaving a document for the board, graph, review queue or definitions kept the index — it wraps every page inside a nest now, with the current view highlighted and Connect one row down, and the old tab strip only shows on phones or when the sidebar is hidden.

**Definitions is just the table.** Rows edit in place (click one; Enter or Ctrl+Enter saves, Escape cancels), a new term is the last row, and the duplicate-term warning appears under the row you're on. No form above the table.

On the dashboard the sidebar is the app's navigation — **Nests**, **My Work** and **My Drafts**, badges included — and each is its own page (`/`, `/my-work`, `/my-drafts`), so the tab strip above the nest grid is gone and a page can be bookmarked or shared. Each is its own component and chunk: opening `/` no longer fetches the inbox and drafts, and opening `/my-work` no longer fetches every nest — a page loads its own data when it opens, and the sidebar badges come from two one-row reads. Archived nests are a switch at the end of the Nests filter row instead of a fourth tab; the list, its filter/sort and restore are unchanged. Under a nest the sidebar keeps Overview and Review queue — with a badge when something is waiting — at the top, with Board · Graph · Definitions · Workflows folded under **Views** (remembered per browser, opened when you're on one of them).

**Nest views have their own URLs.** Board, Graph, Definitions and Workflows are `/nest/<id>/board` … (the old `?view=` links still open), each its own page behind the same folder registry the dashboard uses. The header shows a breadcrumb — Home › nest › page, or the document's title — everywhere.

**The nest page paints tab by tab.** Overview, Documents, Review, External Edits, Stewards and Collaborators each load their own data and show their own loader, so a slow disk scan for external edits no longer holds the whole page on one spinner. Each tab is its own chunk, loaded when first opened; so are the nest page, the editor and the settings pages.

**External edits come from the database.** Staged external edits are recorded as they are staged (who, when, source, hashes) and the External Edits list and its badge read that table instead of walking every document in the vault — on a deep folder tree that walk was the slowest request on the page. Existing installs rebuild the table on the nest's next index refresh (migration 043). `GET /nests/:id/external-edits?count=1` returns the total only.

**Fewer requests per page.** Opening a nest fetches its metadata once (it was four times), the sidebar tree loads one folder level at a time instead of the whole nest, comment counts load with the Documents tab rather than the Overview, and the Review-tab gate reads the comment feed only when nothing else already shows the tab. `/me/work` notification rows carry `nest_name`, so opening one needs no nest list.

**Editing.** The toolbar is always visible in edit mode and sticks under the top bar; the Type control (Document · Artifact · Table · Agent · Skill · Tool) sits on the page for existing documents too — picking another type is "Turn into", with a one-step confirmation. Markdown source moved to the toolbar, Discard draft to the bottom bar beside Save. The artifact page shares the document page's layout: same top bar, padded column, and a comments rail that opens on demand.

**Nest header.** Rename is a pencil beside the name; Import and New Document sit with New Folder on the tab row; a `+` on every sidebar folder creates a document there.
