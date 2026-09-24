---
"@promptowl/contextnest-community": patch
---

Re-inviting an existing email from Teammates no longer issues a new temporary password. `POST /auth/invite` now returns `409` for any existing user and leaves their credentials alone: "already a member" once they've signed in, or "already invited but hasn't signed in yet — use Reset password" otherwise. Previously a not-yet-signed-in user's first password was silently replaced.
