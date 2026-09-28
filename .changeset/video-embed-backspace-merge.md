---
"@promptowl/contextnest-community": patch
---

Fix pressing Backspace at the start of the paragraph right after an embedded video merging that paragraph into the video's URL, corrupting the link and destroying the player.

The video player is a decoration over a plain paragraph whose text is the
bare URL, so a Backspace at the start of the following paragraph hit
ProseMirror's default `joinBackward` and appended the typed text straight
onto the URL. The editor now redirects the first Backspace into the video
paragraph instead of merging into it, leaving the video and its URL intact.
