---
"@promptowl/contextnest-community": patch
---

Fix Backspace below an embedded video still corrupting its URL. The earlier
fix moved the caret into the video's hidden URL text, so the next keystroke
edited the URL and removed the player. Backspace at the start of the line
below a video now selects the whole video (outlined), like an image; a second
Backspace deletes it cleanly. An empty line below the video is removed first.
