---
"@promptowl/contextnest-community": patch
---

Seven UX fixes across search, tags, deep links, publishing, stewardship guidance, workflow errors, and nest names.

**Esc closes Search from anywhere in the overlay.** The overlay advertises the shortcut but only honoured it while the search input held focus, so clicking the scope toggle or the "search all nests" link left Esc doing nothing.

**An accented tag keeps its word.** `café` was stored as `caf` — the accented letter was dropped whole rather than folded to its base. It now becomes `cafe`, and the rewrite is still stated inline. Tags remain ASCII, because that is what the engine stores, so a script with no ASCII base is still refused rather than mangled.

**A nest link that doesn't resolve no longer sticks in the address bar.** The dead id stayed in the URL behind the error screen, so refreshing — or sharing the address off it — landed on the same dead end. The error screen keeps its retry.

**Publishing says it worked.** The new link appearing was the only signal, and on a long form it was easy to miss.

**The stewardship note links to the setting it names.** The Collaborators tab told readers to turn on the approval workflow in nest settings without a way to get there; owners and admins now click through, and everyone else is told who can.

**A rejected workflow connection names the cards, not their ids.** A cycle was reported as a list of internal node identifiers that appear nowhere on the canvas; it now reads as a trail of document titles.

**Nest names are capped at 100 characters.** Any length was accepted, and a long one broke the card and list layouts that render it. The limit is enforced wherever a nest is named — created, renamed, or imported — and stated in the create form as the name is typed.
