---
"@promptowl/contextnest-community": minor
---

Tag people in comments, and stop retyping addresses to add them.

**`@mentions` work in comments.** The comment box gets the same `@` autocomplete the document editor has, listing everyone who can reach the nest, and a posted comment's mentions are styled — resolved names as live references, a name matching nobody drawn as unresolved, so a typo can't pass for a delivered mention. The roster read behind it is read-tier (commenting is), so a read-only reviewer's picker works too; it stays members-only, so a nest that is public or org-visible still doesn't hand its member list to a passing reader.

**A tagged person actually hears about it.** Tagging someone in a comment now drops a row in their queue that links to the document, posts to the configured Slack/Teams/webhook connector, and emails them directly when SMTP is set up. Previously a comment mention notified nobody: the fan-out was wired to document saves only. Mentions in a document body reach the same channels — they used to be inbox-only. The author is never notified about their own mention, an unresolvable name notifies nobody, and someone who can't open the document is skipped — a mention can't disclose a title. A mention in a comment on a hosted artifact now points at the artifact rather than at its derived annotations projection, and fires once instead of twice.

**Adding people and teams autocompletes.** The add-a-person fields (nest collaborators, stewards, team members) suggest people you already work with — anyone on a nest or team you share — while still accepting a brand-new address, so inviting someone without an account works exactly as before. Team pickers (share a team onto a nest, add a team from the collaborator panel) are searchable instead of a flat dropdown.
