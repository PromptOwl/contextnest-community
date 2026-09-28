---
"@promptowl/contextnest-community": patch
---

Invited users get a guided sign-in. Invite emails, and share emails to someone who hasn't signed in yet, link to the login page with `?invite=<email>`: the email is prefilled, a banner explains how to get in, the PromptOwl button reads "Continue with PromptOwl" and passes the invited email on to PromptOwl. Signing in with a PromptOwl account under a different email warns that nests shared with the invited address won't show. A failed password login explains the invite options instead of a bare "Invalid credentials", and the self-registration errors no longer point at a "Set your password" option that doesn't exist.
