---
"@promptowl/contextnest-community": minor
---

Wiki usability pass — the nest reads like a real wiki.

- **Backlinks**: every document shows "Linked from N documents" (client-side reverse index over `[[wiki links]]`; zero server changes).
- **Outline/TOC**: docs with 3+ headings get a clickable outline that scrolls to the section.
- **Hover-preview**: hovering a `[[wiki link]]` in the read view shows the target's title + snippet, resolved from the already-loaded list.
- **Multi-tag filtering**: tag chips on document rows are clickable and combine into an AND filter with a clear bar.
- **Sharing clarity**: the document view's share button now says "Share nest" and the dialog states sharing applies to the whole nest (stewards restrict individual docs). New "Copy link" button produces a `?nest=&doc=` deep link, and the app's deep-link probe opens documents directly.
- **Rename safety**: retitling a doc warns which `[[Title]]`-form links would break (slug links survive).
- **Link health**: the document list reports broken links and orphan docs, each clickable.
- **Recently edited**: a quick-access strip appears once a nest outgrows a glance (5+ docs).
