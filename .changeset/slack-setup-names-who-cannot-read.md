---
"@promptowl/contextnest-community": patch
---

Slack setup: a "Proposals only" channel now names the members who can't read the nest, grouped as "Can be added to the nest", "No matching account on this server" and "Apps in the channel". Before, when nobody could be added, the wizard showed only a count and no "Add to nest…" button, with no reason. The binding preview also lists other apps' bots in `people.members_not_readers` (with `is_bot: true`), so the names match the guard's count.
