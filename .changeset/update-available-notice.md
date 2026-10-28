---
"@promptowl/contextnest-community": patch
---

**Server admins are told when an update is out.** The server checks npm for a newer release at startup and every 12 hours. When one exists, admins see "vX available" next to the version in the footer; it opens the exact command for this install (npm or container) with a copy button, and can be dismissed until the next release. Other users see nothing. `UPDATE_CHECK=false` turns the check off. How it works has a new Updating section.
