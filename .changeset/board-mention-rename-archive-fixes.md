---
"@promptowl/contextnest-community": patch
---

Fix Board tag-column casing, a stuck Board add-column input, slow Board loads, raw-email mentions, a silent rename-cancel, missing Archived tab controls, and run-on validation/status messages.

The Board's **Columns by = Tag** column headers applied CSS `text-transform: capitalize` unconditionally, so a lowercase tag like `annotations` showed as `Annotations` in the header while the card's tag chip stayed lowercase. Tag headers now render the tag value verbatim, matching the chip; Folder and Status headers are unchanged.

The Board's add-column input is shared between Folder and Tag mode. An unsubmitted value typed in one mode (entered but not confirmed with Add) used to carry over when switching **Columns by**, showing a tag string in the folder input or vice versa. Switching dimensions now clears the input.

The Board's node fetch asked for every document's full body (`content=1`), which forces a vault crawl on every load and refresh — expensive on a large nest, and wasted, since the Board only buckets nodes by tag/folder/status and never reads a body. It already covered the whole nest (tag columns were never scoped to a folder), so this was a pure loading-time fix: the Board now fetches a metadata-only, body-free listing served straight from the node index, same source the document tree already uses.

An `@mention` picked from the `@` autocomplete saved as `@user@example.com`, which the read-only document viewer had no handling for — `remark-gfm`'s email autolink turned the domain half into a `mailto:` link, leaving the mention's `@` as a bare character next to a clickable full address. Mentions now render as a single `@name` chip, matching the live editor's styling, with no link and no exposed email. The live editor itself had the same leak: its mention decoration only added a CSS class to the raw text, so the full email stayed visible while editing even though the read view was fixed. It now hides the `@domain` remainder the same way `[[WikiLink]]` brackets are hidden today, showing just `@localpart` in both places.

Pressing Escape during an inline nest rename reverted the title on screen but still saved the edited name underneath: the revert was a batched `setState` that hadn't applied yet when the input's own synchronous `blur()` fired the pending save. Escape now cancels the save along with the visual revert, so the original name stays persisted.

The Archived tab was a flat list with no way to search or sort, unlike the live Nests tab. It now offers a name filter and a "Date archived / Name" sort, shown once there are more than 5 archived nests, matching the live tab's own threshold and affordances.

The workflow-cycle rejection message ("These steps loop back on each other: ... A flow can't return to a step it already ran.") and the Version History "Never published" hint each ran the specific result and the general explanation together as one sentence. Both now put a line break between them for easier scanning; no wording changed.

The Board's **Columns by = Tag** view rendered zero columns on a nest with many tags: the tag board is user-curatable (adding/removing a column persists an explicit, exhaustive `columnOrder`), but a nest nobody had curated yet had no saved `columnOrder` at all, and an empty/undefined order was being treated as "curated to nothing" — so every tag in the nest was there in the data but none of it had a column to land in. A fresh tag board (no saved `columnOrder` yet) now auto-populates a column for every tag actually present, exactly like Folder and Status already do; it only switches to the curated, exhaustive-list behavior the moment the user adds, removes, or reorders a column, which is unchanged and keeps any already-curated board exactly as it was.

The `\n\n` added to the workflow-cycle rejection message split the string, but the message is displayed inside a plain `<div>`/`{error}` text node in `WorkflowsView.tsx`, and the browser's default `white-space: normal` collapses newline characters like any other whitespace — so the two sentences still rendered on one line despite the source string having a line break. The two error containers that can show this message (the Edges tab's inline error, and the workflow canvas's connect/save error) now add `whitespace-pre-line`, which preserves `\n` as a line break while still collapsing ordinary runs of spaces/tabs, so the existing `\n\n` in the message now actually renders as a blank line between the cycle path and the explanation.
