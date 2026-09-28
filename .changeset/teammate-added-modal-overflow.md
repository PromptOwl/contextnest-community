---
"@promptowl/contextnest-community": patch
---

Fix the "Teammate added" confirmation modal overflowing horizontally — the
temporary password field and the "Pick a nest…" dropdown extended past the
modal's edge and were clipped.

The modal's content area is a CSS grid; the temporary-password `<code>`
element was a flex item without `min-w-0`, so it kept its full unbroken-text
width when computing the grid column's minimum size. That blew the shared
column out past the dialog's max width, dragging every other field in the
modal — including the nest picker — along with it. The `<code>` element now
allows shrinking, so `break-all` can wrap it within the dialog like intended.
