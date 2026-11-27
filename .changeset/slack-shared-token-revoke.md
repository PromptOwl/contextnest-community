---
"@promptowl/contextnest-community": patch
---

Slack stays connected when someone runs "Open Slack to approve" again for a workspace that is already connected. With one Slack app per server, Slack returns the connected workspace's own token, and the refused attempt no longer revokes it. A late Slack retry of an old uninstall or token-revoked event also no longer disconnects a newer connection, so drafts and cards in bound channels are not withdrawn.
