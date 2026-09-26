---
"@promptowl/contextnest-community": patch
---

Fix a rejected Server settings save (e.g. an invalid PostHog project key)
showing the same error twice, as a toast and in the inline banner. The error
now shows once, in the inline banner, which also switches to the tab holding
the rejected field.
