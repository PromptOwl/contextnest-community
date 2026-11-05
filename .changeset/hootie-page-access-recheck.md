---
"@promptowl/contextnest-community": patch
---

If a share on one page is revoked while Hootie is answering, Hootie can no longer open that page for the rest of the answer. It now re-checks access to the specific page right before reading it, and refuses the read if that check fails.
