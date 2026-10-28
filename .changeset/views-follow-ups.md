---
"@promptowl/contextnest-community": patch
---

The drift scan now flags any file written straight into the vault that sits on a view's own address (`X/view` or under `X/view/blocks/`). Such a node can't be reached at those URLs because the view serves there; the scan logs it once and lists it as `viewCollisions` in the `POST /external-edits/scan` response. Also adds tests that a folder import keeps a view's layout and that a view node opens as its rendered page.
