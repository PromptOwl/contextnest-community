---
"@promptowl/contextnest-community": minor
---

Drafts can be thrown away, and My Drafts can be managed at scale.

**Discard a draft.** Every document with unreviewed edits now offers Discard: the document goes back to its last approved version, and the edits are gone. A document that was never approved has nothing to fall back to, so discarding it deletes it — the confirmation says which will happen. It is refused while a review is pending; reject the review first. Reachable from three places, because the moment you decide an edit was a mistake is rarely the same place twice: the document's own action bar, its version history panel, and My Drafts.

**Drafts no longer add versions.** This is what made Discard possible. A draft save used to append to the document's version history, which is append-only and hash-linked — so a draft, once written, could never be taken back, and a long editing session left a trail of versions nobody wanted to read. Unreviewed work now lives in the document itself, and a version is recorded when the draft is submitted for review, and again when it is published. Version history is a record of what was released rather than of every save, and discarding costs no version at all. Existing documents are unaffected: nothing is migrated, old history stays exactly as it was, and the versions already in it remain readable.

**My Drafts is a list you can work.** Alongside Submit for review, each row now has Discard, rows can be selected in bulk and discarded together, and the list can be searched by title or nest and sorted by title or by most recently edited. `GET /me/drafts` takes `q` and `sort` to match.

**The document editor's write actions moved to a sticky bar** at the bottom of the page, holding Save, Submit for review and Discard, with the unsaved-changes marker beside the Save it refers to. A document takes minutes to fill in and runs well past one screen, so Save used to scroll out of reach exactly when it was wanted. The header keeps what describes the document rather than changes it — the review verdict, the version comparison, the secondary menu — and no longer repeats the document's name in the breadcrumb, which the title field directly below already shows.
