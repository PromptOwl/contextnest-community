---
"@promptowl/contextnest-community": patch
---

The Teammate added window now says when the temporary password was already emailed, instead of always asking the admin to pass it on by hand. When PromptOwl sign-in is open to everyone, both that window and the invite email mention Sign in with PromptOwl using a PromptOwl account under the same email. `POST /auth/invite` returns two new fields, `emailed` and `promptowl_sign_in`. The same window warns "This person has no nests yet. Share one?" with a nest picker, so a new teammate doesn't land on an empty server.
