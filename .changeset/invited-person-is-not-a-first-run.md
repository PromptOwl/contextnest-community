---
"@promptowl/contextnest-community": patch
---

Someone invited to a nest no longer lands on the Getting started screen. A first run is now a person who owns no nest and was let into nobody else's (collaborator, steward, team share, or a share on one document). An invited person opens Home on their nest list with the shared nest in it, and Getting started is still there. A public or org-visible nest they can merely read does not count, so someone who reaches nothing still gets the welcome screen. `GET /onboarding` and `context_onboarding` report the same rule and a new `shared_nests` count. A link to a nest or a document followed while signed out now opens that nest or document after sign-in, including a sign-in that leaves the page (PromptOwl, Google, single sign-on).
