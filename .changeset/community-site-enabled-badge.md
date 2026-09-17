---
"@promptowl/contextnest-community": patch
---

Community sites say Enabled / Disabled instead of Active / Inactive. The badge only ever reflected the admin switch — the server never contacts a site (SSO tickets are verified locally with the shared secret), so "Active" implied a reachability it could not know. The switch's tooltip says the same.
