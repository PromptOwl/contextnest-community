---
"@promptowl/contextnest-community": patch
---

Fix Board tag-column casing, a stuck Board add-column input, slow Board loads, raw-email mentions, a silent rename-cancel, missing Archived tab controls, and run-on validation/status messages.

The Board's **Columns by = Tag** column headers applied CSS `text-transform: capitalize` unconditionally, so a lowercase tag like `annotations` showed as `Annotations` in the header while the card's tag chip stayed lowercase. Tag headers now render the tag value verbatim, matching the chip; Folder and Status headers are unchanged.

The Board's add-column input is shared between Folder and Tag mode. An unsubmitted value typed in one mode (entered but not confirmed with Add) used to carry over when switching **Columns by**, showing a tag string in the folder input or vice versa. Switching dimensions now clears the input.

The Board's node fetch asked for every document's full body (`content=1`), which forces a vault crawl on every load and refresh — expensive on a large nest, and wasted, since the Board only buckets nodes by tag/folder/status and never reads a body. It already covered the whole nest (tag columns were never scoped to a folder), so this was a pure loading-time fix: the Board now fetches a metadata-only, body-free listing served straight from the node index, same source the document tree already uses.

An `@mention` picked from the `@` autocomplete saved as `@user@example.com`, which the read-only document viewer had no handling for — `remark-gfm`'s email autolink turned the domain half into a `mailto:` link, leaving the mention's `@` as a bare character next to a clickable full address. Mentions now render as a single `@name` chip, matching the live editor's styling, with no link and no exposed email.

Pressing Escape during an inline nest rename reverted the title on screen but still saved the edited name underneath: the revert was a batched `setState` that hadn't applied yet when the input's own synchronous `blur()` fired the pending save. Escape now cancels the save along with the visual revert, so the original name stays persisted.

The Archived tab was a flat list with no way to search or sort, unlike the live Nests tab. It now offers a name filter and a "Date archived / Name" sort, shown once there are more than 5 archived nests, matching the live tab's own threshold and affordances.

The workflow-cycle rejection message ("These steps loop back on each other: ... A flow can't return to a step it already ran.") and the Version History "Never published" hint each ran the specific result and the general explanation together as one sentence. Both now put a line break between them for easier scanning; no wording changed.
