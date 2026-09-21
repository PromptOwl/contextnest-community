---
"@promptowl/contextnest-community": patch
---

An HTML artifact can be shared, published, linked, moved and deleted from its own page, the way a markdown document can.

A markdown document's top bar has Share (the nest) and a ⋮ menu with Copy link, Move to folder, Share this document, Publish and Delete. An artifact — a slide deck, dashboard or infographic an agent emitted as HTML — opened in a viewer that had none of them: Preview / Annotate / Edit source, History, Reload, Turn into a document, Comments and Open in new tab. The server already published and granted access to artifacts exactly as it does documents; the buttons just weren't there, so sharing an artifact meant going back to the nest list and finding its row menu.

The artifact page now carries the same visibility control, the same Share button and the same ⋮ menu, with the same gating — owners and admins share and publish, editors move and ask for deletion, viewers get Copy link, an archived nest withholds sharing — and a published artifact serves as HTML under the artifact sandbox as before. The two pages draw the menu from one list (`ui/src/lib/document-actions.ts`), so they can't drift apart again; that list is unit-tested for the role matrix.
