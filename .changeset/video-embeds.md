---
"@promptowl/contextnest-community": minor
---

YouTube and Vimeo links play in place.

Paste a YouTube or Vimeo URL on a line of its own and the document shows the video's player instead of a bare link — in the reader, version history, the artifact viewer and the editor (and its preview). The markdown on disk stays the plain URL, so agents, exports and the `/p` published pages see exactly what was written; published pages keep showing it as a link.

Only a bare URL embeds: a titled link (`[Watch the demo](https://youtu.be/…)`) and a link inside a sentence stay links. Recognised: `youtube.com/watch?v=…`, `youtu.be/…`, `youtube.com/shorts/…`, `youtube.com/embed/…` (a `t=`/`start=` time is kept), `vimeo.com/<id>` (including unlisted `vimeo.com/<id>/<hash>`) and `player.vimeo.com/video/<id>`. Hosts are matched exactly — anything else, including look-alike domains, stays a link. YouTube plays from `youtube-nocookie.com`; the player runs in a sandboxed, lazy-loaded frame. For an unlisted Vimeo video, paste the share link that includes its hash (`vimeo.com/<id>/<hash>`) — without it Vimeo refuses to play the video.
